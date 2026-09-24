/**
 * WS5 through the real Worker app: POST /v1/feedback (anonymous + signed,
 * limits, idempotency, redaction, notification), request ids + telemetry,
 * the daily digest, and the operator's triage routes.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { setNodeAdapter } from '../index.js';
import { setupTestDb, createTestAgent, signRequest, type TestKeypair } from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import { ControlStore } from '../control/store.js';
import { sha256, bytesToHex } from '../crypto/index.js';
import { buildDigest, formatDigest, runDailyDigest, retryFeedbackNotifications, recordUsage, type FeedbackRow } from '../feedback/service.js';
import { FEEDBACK_LIMITS } from './feedback.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const BASE = 'https://api.basedagents.ai';
const ADMIN = 'ow_admin1';

let db: SQLiteAdapter;
let agent: TestKeypair & { name: string };
let pending: Promise<unknown>[];
let env: Record<string, string>;
let fetchSpy: ReturnType<typeof vi.fn>;
let logSpy: MockInstance<typeof console.log>;

const ctx = () => ({ waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} });
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), env as never, ctx() as never);
  await Promise.all(pending.splice(0));
  return res;
}

const report = (over: Record<string, unknown> = {}) => ({
  scope: 'general',
  environment: 'node 22, linux, behind a proxy',
  expectedBehavior: 'tasks list --min-usdc 1 returns only paid tasks',
  actualBehavior: 'it returned a free task',
  stepsToReproduce: 'npx basedagents@latest tasks list --min-usdc 1 --json',
  skillVersion: '1.0.0',
  ...over,
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  call('/v1/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', ...headers }, body: JSON.stringify(body) });

async function signedPost(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const text = JSON.stringify(body);
  const auth = await signRequest(agent, 'POST', '/v1/feedback', text);
  return call('/v1/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth, ...headers }, body: text });
}

beforeEach(async () => {
  db = setupTestDb();
  for (const f of ['0023_owner_accounts.sql', '0025_owner_recovery.sql', '0027_authority_ladder.sql']) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  setNodeAdapter(db);
  agent = await createTestAgent(db, { name: 'Reporter' });
  pending = [];
  env = { ADMIN_OWNER_IDS: ADMIN, FEEDBACK_NOTIFY_EMAIL: 'ops@example.com', FEEDBACK_SLACK_WEBHOOK_URL: 'https://hooks.slack.test/T0/B0/x' };
  fetchSpy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const rowOf = (id: string) => db.get<FeedbackRow>('SELECT * FROM feedback WHERE feedback_id = ?', id);

describe('POST /v1/feedback', () => {
  it('accepts an anonymous report, stores it, and notifies email + Slack', async () => {
    const res = await post(report());
    expect(res.status).toBe(201);
    const body = await res.json() as { feedback_id: string; anonymous: boolean; status: string };
    expect(body).toMatchObject({ anonymous: true, status: 'open' });
    const row = (await rowOf(body.feedback_id))!;
    expect(row.agent_id).toBeNull();
    expect(row.skill_version).toBe('1.0.0');
    expect(row.notified_at).toBeTruthy();
    const email = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('[email:log-only] to=ops@example.com'));
    expect(email).toContain('[BasedAgents feedback] general');
    const slack = fetchSpy.mock.calls.find(([u]) => String(u).startsWith('https://hooks.slack.test'));
    expect(JSON.parse(String((slack![1] as RequestInit).body)).text).toContain('it returned a free task');
  });

  it('records the signing agent', async () => {
    const res = await signedPost(report({ scope: 'task', taskId: 'task_abc', errorCodes: ['conflict'], requestIds: ['req-1'] }));
    expect(res.status).toBe(201);
    const { feedback_id, anonymous } = await res.json() as { feedback_id: string; anonymous: boolean };
    expect(anonymous).toBe(false);
    const row = (await rowOf(feedback_id))!;
    expect(row).toMatchObject({ agent_id: agent.agentId, scope: 'task', task_id: 'task_abc', error_codes: '["conflict"]', request_ids: '["req-1"]' });
  });

  it('rejects a bad signature instead of silently going anonymous', async () => {
    const res = await post(report(), { Authorization: 'AgentSig nope:nope', 'X-Timestamp': '1', 'X-Nonce': 'n' });
    expect(res.status).toBe(401);
  });

  it('validates the body: task scope needs taskId, unknown fields are refused', async () => {
    expect((await post(report({ scope: 'task' }))).status).toBe(400);
    expect((await post(report({ extra: 1 }))).status).toBe(400);
    expect((await post({ scope: 'general' })).status).toBe(400);
  });

  it('redacts secrets before storing', async () => {
    const key = 'ab'.repeat(32);
    const res = await post(report({ actualBehavior: `failed with privateKey: "${key}" and Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123` }));
    const row = (await rowOf(((await res.json()) as { feedback_id: string }).feedback_id))!;
    expect(row.actual_behavior).not.toContain(key);
    expect(row.actual_behavior).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
    expect(row.actual_behavior).toContain('[REDACTED]');
  });

  it(`limits anonymous reports to ${FEEDBACK_LIMITS.anonymousPerHour} an hour per IP, with Retry-After`, async () => {
    for (let i = 0; i < FEEDBACK_LIMITS.anonymousPerHour; i++) expect((await post(report())).status).toBe(201);
    const res = await post(report());
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    // A signed report from the same IP still goes through.
    expect((await signedPost(report())).status).toBe(201);
  });

  it('Idempotency-Key: a retry returns the first response; a different body is 422', async () => {
    const first = await post(report(), { 'Idempotency-Key': 'retry-key-0001' });
    const again = await post(report(), { 'Idempotency-Key': 'retry-key-0001' });
    expect(again.status).toBe(201);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await again.json()).toEqual(await first.json());
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM feedback'))!.n).toBe(1);
    expect((await post(report({ actualBehavior: 'different' }), { 'Idempotency-Key': 'retry-key-0001' })).status).toBe(422);
    expect((await post(report(), { 'Idempotency-Key': 'bad key!' })).status).toBe(400);
  });

  it('a replay is served even after the limit is reached, and costs nothing', async () => {
    const first = await post(report(), { 'Idempotency-Key': 'filed-once-0001' });
    for (let i = 1; i < FEEDBACK_LIMITS.anonymousPerHour; i++) await post(report({ actualBehavior: `other ${i}` }));
    expect((await post(report({ actualBehavior: 'one too many' }))).status).toBe(429);
    const replay = await post(report(), { 'Idempotency-Key': 'filed-once-0001' });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(await first.json());
  });

  it('stores silently when no notification channel is configured', async () => {
    env = { ADMIN_OWNER_IDS: ADMIN };
    const res = await post(report());
    const row = (await rowOf(((await res.json()) as { feedback_id: string }).feedback_id))!;
    expect(row.notified_at).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the cron retries a notification that failed', async () => {
    fetchSpy.mockResolvedValue(new Response('down', { status: 500 }));
    env = { FEEDBACK_SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' };
    const res = await post(report());
    const id = ((await res.json()) as { feedback_id: string }).feedback_id;
    expect((await rowOf(id))!.notified_at).toBeNull();
    fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }));
    const later = new Date(Date.now() + 120_000).toISOString();
    const sender = { send: vi.fn() };
    expect(await retryFeedbackNotifications(db, env, sender, later)).toBe(1);
    expect((await rowOf(id))!.notified_at).toBe(later);
  });
});

describe('request ids + telemetry', () => {
  it('every response carries X-Request-Id; agent traffic is counted per day', async () => {
    const res = await call('/v1/health', { headers: { 'X-BasedAgents-Cli-Version': '0.9.0', 'X-BasedAgents-Skill-Version': '1.1.0' } });
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
    await call('/v1/tasks/task_missing', { headers: { 'X-BasedAgents-Cli-Version': '0.9.0' } });
    await call('/v1/health'); // no version header, no signer, 200: not counted
    const rows = await db.all<{ cli_version: string; skill_version: string; status: number; error_code: string; count: number }>('SELECT cli_version, skill_version, status, error_code, count FROM api_usage_daily ORDER BY status');
    expect(rows).toEqual([
      { cli_version: '0.9.0', skill_version: '1.1.0', status: 200, error_code: '', count: 1 },
      { cli_version: '0.9.0', skill_version: '', status: 404, error_code: 'not_found', count: 1 },
    ]);
  });
});

describe('daily digest', () => {
  const DAY = '2026-09-23';
  beforeEach(async () => {
    const rec = (agentId: string, cli: string, skill: string, status: number, code = '', times = 1) =>
      Promise.all(Array.from({ length: times }, () => recordUsage(db, { day: DAY, agentId, cliVersion: cli, skillVersion: skill, status, errorCode: code })));
    await rec('ag_a', '0.8.0', '1.0.0', 200, '', 5);
    await rec('ag_b', '0.9.0', '1.1.0', 200, '', 2);
    await rec('ag_b', '0.9.0', '1.1.0', 409, 'conflict', 3);
    await rec('', '', '', 429, 'rate_limited', 4);
    await rec('ag_a', '0.8.0', '1.0.0', 200, '', 1).then(() => recordUsage(db, { day: '2026-09-22', agentId: 'ag_old', cliVersion: '0.7.0', skillVersion: '', status: 200, errorCode: '' }));
    const fb = (id: string, created: string, status = 'open') => db.run(
      `INSERT INTO feedback (feedback_id, scope, environment, expected_behavior, actual_behavior, steps_to_reproduce, status, created_at, updated_at) VALUES (?, 'general', 'e', 'x', 'y', 'z', ?, ?, ?)`, id, status, created, created);
    await fb('fb_1', `${DAY}T10:00:00.000Z`);
    await fb('fb_2', `${DAY}T23:59:00.000Z`, 'fixed');
    await fb('fb_3', '2026-09-24T00:00:01.000Z');
  });

  it('counts agents, versions, errors, 429s and feedback for the day', async () => {
    const d = await buildDigest(db, DAY);
    expect(d).toMatchObject({ day: DAY, uniqueAgents: 2, requests: 15, rateLimited: 4, feedback: { received: 2, open: 2 } });
    expect(d.byCli).toEqual([{ version: '0.8.0', requests: 6, agents: 1 }, { version: '0.9.0', requests: 5, agents: 1 }]);
    expect(d.bySkill).toEqual([{ version: '1.0.0', requests: 6, agents: 1 }, { version: '1.1.0', requests: 5, agents: 1 }]);
    expect(d.topErrors).toEqual([{ status: 429, code: 'rate_limited', count: 4 }, { status: 409, code: 'conflict', count: 3 }]);
    const { subject, text } = formatDigest(d);
    expect(subject).toBe('[BasedAgents digest] 2026-09-23: 2 agents, 2 feedback, 4 × 429');
    expect(text).toContain('0.9.0: 5 requests, 1 agents');
  });

  it('sends once a day after 07:00 UTC', async () => {
    const sender = { send: vi.fn().mockResolvedValue(undefined) };
    const envNotify = { FEEDBACK_NOTIFY_EMAIL: 'ops@example.com' };
    expect(await runDailyDigest(db, envNotify, sender, new Date('2026-09-24T06:59:00Z'))).toBe('not_yet');
    expect(await runDailyDigest(db, envNotify, sender, new Date('2026-09-24T07:00:00Z'))).toBe('sent');
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send.mock.calls[0][0].subject).toContain('2026-09-23');
    expect(await runDailyDigest(db, envNotify, sender, new Date('2026-09-24T07:05:00Z'))).toBe('already_sent');
    expect(await runDailyDigest(db, {}, sender, new Date('2026-09-25T08:00:00Z'))).toBe('no_channel');
  });
});

describe('operator triage (/v1/owner/admin/feedback)', () => {
  async function session(ownerId: string): Promise<string> {
    await db.run(`INSERT INTO owners (id, status, display_name) VALUES (?, 'active', 'x')`, ownerId);
    const token = `tok_${ownerId}`;
    await new ControlStore(db).createSession({ ownerId, tokenHash: bytesToHex(sha256(new TextEncoder().encode(token))), method: 'email', ttlSeconds: 3600 });
    return `ba_owner_session=${token}`;
  }

  it('lists and updates feedback for an admin; 404 for anyone else; /me says who is admin', async () => {
    const id = ((await (await post(report())).json()) as { feedback_id: string }).feedback_id;
    const admin = await session(ADMIN);
    const other = await session('ow_someone');

    const list = await call('/v1/owner/admin/feedback?status=open', { headers: { Cookie: admin } });
    expect(list.status).toBe(200);
    const body = await list.json() as { feedback: Array<{ feedback_id: string; error_codes: string[] }>; counts: Record<string, number> };
    expect(body.feedback.map((f) => f.feedback_id)).toEqual([id]);
    expect(body.counts).toEqual({ open: 1, fixed: 0, wont_fix: 0 });

    expect((await call('/v1/owner/admin/feedback', { headers: { Cookie: other } })).status).toBe(404);
    expect((await call('/v1/owner/admin/feedback')).status).toBe(401);

    const upd = await call(`/v1/owner/admin/feedback/${id}`, { method: 'POST', headers: { Cookie: admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'fixed', note: 'min_usdc shipped' }) });
    expect(upd.status).toBe(200);
    expect(((await upd.json()) as { feedback: { status: string; status_note: string } }).feedback).toMatchObject({ status: 'fixed', status_note: 'min_usdc shipped' });
    expect((await call(`/v1/owner/admin/feedback/fb_nope`, { method: 'POST', headers: { Cookie: admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'fixed' }) })).status).toBe(404);

    const meAdmin = await (await call('/v1/owner/me', { headers: { Cookie: admin } })).json() as { is_admin: boolean };
    const meOther = await (await call('/v1/owner/me', { headers: { Cookie: other } })).json() as { is_admin: boolean };
    expect(meAdmin.is_admin).toBe(true);
    expect(meOther.is_admin).toBe(false);
  });
});
