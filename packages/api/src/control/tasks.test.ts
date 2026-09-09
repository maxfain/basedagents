/**
 * Owner (human) task routes — compose, list, review (accept / changes /
 * dispute / cancel) over the shared task service, next to the AgentSig routes
 * so cross-family invariants (an agent cannot review a human's task; a human's
 * task is claimed and delivered by agents like any other) are asserted in one
 * place.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { AppEnv } from '../types/index.js';
import { drainOutbox } from '../events/service.js';
import { setupTestDb, createTestAgent, signRequest, type TestKeypair } from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import { ControlStore } from './store.js';
import { resetCertificationProbeForTests } from './certification.js';
import {
  enablePaymentsForTests, disablePaymentsForTests, resetPaymentsForTests, paymentHeaderFor,
  TEST_WALLET, TEST_TX, type FakeFacilitator,
} from '../payments/test-fixtures.js';
import type { PaymentRequirementsV2 } from '../payments/x402.js';
import { sha256, bytesToHex } from '../crypto/index.js';
import ownerTaskRoutes from './tasks.js';
import taskRoutes from '../routes/tasks.js';
import agentRoutes from '../routes/agents.js';

vi.mock('../lib/twitter.js', () => ({
  postTweet: vi.fn(),
  registrationTweet: vi.fn(() => 'mock tweet'),
  firstVerificationTweet: vi.fn(() => 'mock tweet'),
}));
vi.mock('../skills/resolver.js', () => ({
  resolveAllAgentSkills: vi.fn().mockResolvedValue({ updated: 0 }),
  computeSkillReputations: vi.fn().mockResolvedValue(undefined),
}));

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const sha256hex = (s: string) => bytesToHex(sha256(new TextEncoder().encode(s)));

describe('Owner task routes', () => {
  let db: SQLiteAdapter;
  let app: Hono<AppEnv>;
  let store: ControlStore;
  let agent: TestKeypair & { name: string };
  const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

  async function installControlTables(): Promise<void> {
    for (const f of ['0023_owner_accounts.sql', '0025_owner_recovery.sql', '0027_authority_ladder.sql']) {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
    }
    resetCertificationProbeForTests();
  }

  let ownerSeq = 0;
  /** An active owner with an email-rung session; returns the Cookie header value. */
  async function ownerSession(displayName = 'Max'): Promise<{ ownerId: string; cookie: string }> {
    const ownerId = `ow_test${++ownerSeq}`;
    await db.run(`INSERT INTO owners (id, status, display_name) VALUES (?, 'active', ?)`, ownerId, displayName);
    const token = `tok_${ownerId}_${Math.random().toString(36).slice(2)}`;
    await store.createSession({ ownerId, tokenHash: sha256hex(token), method: 'email', ttlSeconds: 3600 });
    return { ownerId, cookie: `ba_owner_session=${token}` };
  }

  async function ownerPost(path: string, body: unknown, cookie?: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
    return app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
      body: JSON.stringify(body),
    });
  }
  async function ownerGet(path: string, cookie?: string): Promise<Response> {
    return app.request(path, { headers: cookie ? { Cookie: cookie } : {} });
  }

  async function compose(cookie: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const res = await ownerPost('/v1/owner/tasks', {
      title: 'Reproduce the quickstart', description: 'Follow README on a clean machine and report where it breaks',
      category: 'code', required_capabilities: ['code'], ...overrides,
    }, cookie);
    expect(res.status).toBe(200);
    return ((await res.json()) as { task_id: string }).task_id;
  }

  async function agentPost(kp: TestKeypair, path: string, body?: unknown): Promise<Response> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers = await signRequest(kp, 'POST', path, text);
    return app.request(path, { method: 'POST', headers: { ...(text ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: text });
  }
  async function claimAndDeliver(taskId: string, summary = 'Done'): Promise<void> {
    expect((await agentPost(agent, `/v1/tasks/${taskId}/claim`)).status).toBe(200);
    expect((await agentPost(agent, `/v1/tasks/${taskId}/deliver`, { summary, submission_type: 'json', submission_content: '{}' })).status).toBe(200);
  }

  beforeEach(async () => {
    db = setupTestDb();
    await installControlTables();
    store = new ControlStore(db);
    ownerSeq = 0;
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);
    app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      (c.env as AppEnv['Bindings']) = { ...(c.env ?? {}), PAYMENT_ENCRYPTION_KEY: 'a'.repeat(64) };
      await next();
    });
    app.route('/v1/owner', ownerTaskRoutes);
    app.route('/v1/tasks', taskRoutes);
    app.route('/v1/agents', agentRoutes);
    agent = await createTestAgent(db, { status: 'active', capabilities: ['code'] });
  });

  afterEach(() => { resetPaymentsForTests(); vi.unstubAllGlobals(); });

  it('requires a session → 401', async () => {
    expect((await ownerPost('/v1/owner/tasks', { title: 'x', description: 'y' })).status).toBe(401);
    expect((await ownerGet('/v1/owner/tasks')).status).toBe(401);
  });

  it('composes an unpaid task as the owner; public reads show a human creator and no owner id', async () => {
    const { ownerId, cookie } = await ownerSession('Max F');
    const taskId = await compose(cookie);
    const row = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE task_id = ?', taskId);
    expect(row!.creator_kind).toBe('owner');
    expect(row!.creator_owner_id).toBe(ownerId);
    expect(row!.creator_agent_id).toBeNull();
    expect(row!.payment_status).toBe('none');

    const pub = (await (await app.request(`/v1/tasks/${taskId}`)).json()) as { task: Record<string, unknown> };
    expect(pub.task.creator).toEqual({ kind: 'owner', id: null, short_id: null, name: 'Max F', cert: 'none' });
    expect(pub.task).not.toHaveProperty('creator_owner_id');
    expect(pub.task.creator_agent_id).toBeNull();
    const funnel = await db.all<{ event: string; provider: string }>('SELECT event, provider FROM funnel_events WHERE funnel_id = ?', taskId);
    expect(funnel).toEqual([{ event: 'task_posted', provider: 'human' }]);
  });

  it('rejects unknown fields at the schema (strict)', async () => {
    const { cookie } = await ownerSession();
    expect((await ownerPost('/v1/owner/tasks', { title: 'x', description: 'y', evil: 1 }, cookie)).status).toBe(400);
  });

  it('refuses a bounty when payments are not enabled → 503 payments_unavailable', async () => {
    disablePaymentsForTests();
    const { cookie } = await ownerSession();
    const res = await ownerPost('/v1/owner/tasks', { title: 'x', description: 'y', bounty: { amount: '5000000' } }, cookie);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('payments_unavailable');
  });

  it('composes a bounty task when payments are enabled: stores the bounty, payment_status=pending, declares it', async () => {
    enablePaymentsForTests();
    const { cookie } = await ownerSession();
    const res = await ownerPost('/v1/owner/tasks', {
      title: 'Paid task', description: 'do it', category: 'code',
      bounty: { amount: '100000', token: 'USDC', network: 'eip155:8453' },
    }, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task_id: string; payment_status: string; bounty: { amount_atomic: string; amount_display: string } };
    expect(body.payment_status).toBe('pending');
    expect(body.bounty.amount_atomic).toBe('100000');
    expect(body.bounty.amount_display).toBe('0.10');

    const row = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE task_id = ?', body.task_id);
    expect(row!.bounty_amount).toBe('100000');
    expect(row!.bounty_token).toBe('USDC');
    expect(row!.bounty_network).toBe('eip155:8453');
    expect(row!.payment_status).toBe('pending');
    const funnel = await db.all<{ event: string }>('SELECT event FROM funnel_events WHERE funnel_id = ?', body.task_id);
    expect(funnel.map((f) => f.event)).toEqual(['task_posted']);
    const pay = await db.all<{ event_type: string }>('SELECT event_type FROM payment_events WHERE task_id = ? ORDER BY created_at', body.task_id);
    expect(pay.map((p) => p.event_type)).toEqual(['bounty_declared']);
  });

  // ─── Owner accept-and-pay (x402, sign-at-accept) ───
  describe('accepting a delivered bounty and paying it', () => {
    let facilitator: FakeFacilitator;

    async function deliveredBounty(cookie: string): Promise<{ taskId: string; requirements: PaymentRequirementsV2 }> {
      // The deliverer needs a receiving wallet on file (the bounty's payTo).
      await db.run('UPDATE agents SET wallet_address = ?, wallet_network = ? WHERE id = ?', TEST_WALLET, 'eip155:8453', agent.agentId);
      const taskId = await compose(cookie, { bounty: { amount: '100000', token: 'USDC', network: 'eip155:8453' } });
      await claimAndDeliver(taskId);
      // Pull the x402 requirements from the 402 challenge (no header → challenge).
      const challenge = await ownerPost(`/v1/owner/tasks/${taskId}/accept`, { note: 'looks good' }, cookie);
      expect(challenge.status).toBe(402);
      const header = challenge.headers.get('PAYMENT-REQUIRED')!;
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { accepts: PaymentRequirementsV2[] };
      expect(decoded.accepts[0].payTo).toBe(TEST_WALLET);
      return { taskId, requirements: decoded.accepts[0] };
    }

    beforeEach(() => { facilitator = enablePaymentsForTests(); });

    it('without a payment header → 402 challenge, task still submitted, facilitator untouched', async () => {
      const { cookie } = await ownerSession();
      await db.run('UPDATE agents SET wallet_address = ? WHERE id = ?', TEST_WALLET, agent.agentId);
      const taskId = await compose(cookie, { bounty: { amount: '100000' } });
      await claimAndDeliver(taskId);
      const res = await ownerPost(`/v1/owner/tasks/${taskId}/accept`, {}, cookie);
      expect(res.status).toBe(402);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe('payment_required');
      const row = await db.get<Record<string, unknown>>('SELECT status, payment_status FROM tasks WHERE task_id = ?', taskId);
      expect(row!.status).toBe('submitted');
      expect(row!.payment_status).toBe('pending');
      expect(facilitator.verifyCalls.length).toBe(0);
    });

    it('with a valid wallet signature → verified + settled in one call', async () => {
      const { cookie, ownerId } = await ownerSession();
      const { taskId, requirements } = await deliveredBounty(cookie);
      const res = await ownerPost(`/v1/owner/tasks/${taskId}/accept`, { note: 'ship it' }, cookie, {
        'PAYMENT-SIGNATURE': paymentHeaderFor(requirements),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string; accepted_by: string; payment_status: string; payment_tx_hash: string };
      expect(data.status).toBe('verified');
      expect(data.accepted_by).toBe('creator');
      expect(data.payment_status).toBe('settled');
      expect(data.payment_tx_hash).toBe(TEST_TX);
      expect(res.headers.get('PAYMENT-RESPONSE')).not.toBeNull();

      const row = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE task_id = ?', taskId);
      expect(row!.status).toBe('verified');
      expect(row!.review_note).toBe('ship it');
      expect(row!.payment_status).toBe('settled');
      expect(row!.payment_tx_hash).toBe(TEST_TX);
      expect(row!.creator_owner_id).toBe(ownerId);
      expect(facilitator.verifyCalls.length).toBe(1);
      expect(facilitator.settleCalls.length).toBe(1);
    });

    it('refuses to pay when the deliverer removed their wallet after claiming → 409 payee_wallet_missing', async () => {
      const { cookie } = await ownerSession();
      // Claim requires a wallet, so set one, then clear it before the owner pays.
      await db.run('UPDATE agents SET wallet_address = ? WHERE id = ?', TEST_WALLET, agent.agentId);
      const taskId = await compose(cookie, { bounty: { amount: '100000' } });
      await claimAndDeliver(taskId);
      await db.run('UPDATE agents SET wallet_address = NULL WHERE id = ?', agent.agentId);
      const res = await ownerPost(`/v1/owner/tasks/${taskId}/accept`, {}, cookie);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('payee_wallet_missing');
    });
  });

  it('enforces the creator XOR at the schema level', async () => {
    await expect(db.run(
      `INSERT INTO tasks (task_id, creator_agent_id, creator_owner_id, creator_kind, title, description, status, created_at)
       VALUES ('task_xor', ?, 'ow_x', 'owner', 't', 'd', 'open', '2026-09-08T00:00:00Z')`, agent.agentId,
    )).rejects.toThrow();
  });

  it('lists only my tasks with the latest receipt and needs_review; 404 for another owner', async () => {
    const a = await ownerSession('A');
    const b = await ownerSession('B');
    const mine = await compose(a.cookie);
    await compose(b.cookie);
    await claimAndDeliver(mine, 'First cut');

    const list = (await (await ownerGet('/v1/owner/tasks', a.cookie)).json()) as { tasks: Array<Record<string, unknown>> };
    expect(list.tasks.map((t) => t.task_id)).toEqual([mine]);
    expect(list.tasks[0].needs_review).toBe(true);
    expect(list.tasks[0].claimer_name).toBe(agent.name);
    expect((list.tasks[0].latest_receipt as Record<string, unknown>).summary).toBe('First cut');
    expect(list.tasks[0]).not.toHaveProperty('creator_owner_id');

    expect((await ownerGet(`/v1/owner/tasks/${mine}`, b.cookie)).status).toBe(404);
    expect((await ownerPost(`/v1/owner/tasks/${mine}/accept`, {}, b.cookie)).status).toBe(404);
    const detail = (await (await ownerGet(`/v1/owner/tasks/${mine}`, a.cookie)).json()) as { task: Record<string, unknown>; receipts: unknown[]; delivery_receipt: Record<string, unknown> };
    expect(detail.receipts).toHaveLength(1);
    expect(detail.delivery_receipt.summary).toBe('First cut');
    expect(detail.task.review_state).toBeNull();
  });

  it('accept → verified, the deliverer gains reputation, and an agent cannot accept a human task', async () => {
    const { cookie } = await ownerSession();
    const taskId = await compose(cookie);
    await claimAndDeliver(taskId);
    await db.run('UPDATE agents SET reputation_score = 0 WHERE id = ?', agent.agentId);

    // The AgentSig route family refuses to review a human-posted task.
    const viaAgent = await agentPost(agent, `/v1/tasks/${taskId}/accept`);
    expect(viaAgent.status).toBe(403);

    const res = await ownerPost(`/v1/owner/tasks/${taskId}/accept`, { note: 'Nice' }, cookie);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.status).toBe('verified');
    expect(data.accepted_by).toBe('creator');
    expect(data.chain_sequence).toBeTypeOf('number');
    const row = await db.get<{ status: string; review_note: string; accepted_by: string }>('SELECT status, review_note, accepted_by FROM tasks WHERE task_id = ?', taskId);
    expect(row).toEqual({ status: 'verified', review_note: 'Nice', accepted_by: 'creator' });
    const score = await db.get<{ reputation_score: number }>('SELECT reputation_score FROM agents WHERE id = ?', agent.agentId);
    expect(score!.reputation_score).toBeGreaterThan(0);
    // idempotent
    expect((await ownerPost(`/v1/owner/tasks/${taskId}/accept`, {}, cookie)).status).toBe(200);
  });

  it('request changes → claimed + review_state; a second delivery adds a receipt; the 4th round is refused', async () => {
    const { cookie } = await ownerSession();
    const taskId = await compose(cookie);
    await claimAndDeliver(taskId, 'v1');
    expect((await ownerPost(`/v1/owner/tasks/${taskId}/revision`, {}, cookie)).status).toBe(400);
    const res = await ownerPost(`/v1/owner/tasks/${taskId}/revision`, { note: 'Add tests' }, cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).review_state).toBe('revision_requested');

    expect((await agentPost(agent, `/v1/tasks/${taskId}/deliver`, { summary: 'v2', submission_type: 'json', submission_content: '{}' })).status).toBe(200);
    const detail = (await (await ownerGet(`/v1/owner/tasks/${taskId}`, cookie)).json()) as { receipts: Array<{ summary: string }>; task: Record<string, unknown> };
    expect(detail.receipts.map((r) => r.summary)).toEqual(['v2', 'v1']);
    expect(detail.task.revision_count).toBe(1);

    for (let i = 0; i < 2; i++) {
      expect((await ownerPost(`/v1/owner/tasks/${taskId}/revision`, { note: `round ${i + 2}` }, cookie)).status).toBe(200);
      expect((await agentPost(agent, `/v1/tasks/${taskId}/deliver`, { summary: `v${i + 3}`, submission_type: 'json', submission_content: '{}' })).status).toBe(200);
    }
    const fourth = await ownerPost(`/v1/owner/tasks/${taskId}/revision`, { note: 'again' }, cookie);
    expect(fourth.status).toBe(409);
    expect(((await fourth.json()) as { error: string }).error).toBe('max_revisions');
  });

  it('dispute freezes auto-accept; cancel needs a dispute first; dispute→cancel counts against the deliverer', async () => {
    const { cookie } = await ownerSession();
    const taskId = await compose(cookie);
    await claimAndDeliver(taskId);
    const early = await ownerPost(`/v1/owner/tasks/${taskId}/cancel`, {}, cookie);
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: string }).error).toBe('dispute_first');

    expect((await ownerPost(`/v1/owner/tasks/${taskId}/dispute`, {}, cookie)).status).toBe(400);
    const dispute = await ownerPost(`/v1/owner/tasks/${taskId}/dispute`, { reason: 'Not what I asked' }, cookie);
    expect(dispute.status).toBe(200);
    expect(((await dispute.json()) as Record<string, unknown>).review_state).toBe('disputed');
    const row = await db.get<{ disputed_at: string | null; auto_release_at: string | null }>('SELECT disputed_at, auto_release_at FROM tasks WHERE task_id = ?', taskId);
    expect(row!.disputed_at).not.toBeNull();
    expect(row!.auto_release_at).toBeNull();

    const { runTaskCron } = await import('../cron/tasks.js');
    await runTaskCron(db, { PAYMENT_ENCRYPTION_KEY: 'a'.repeat(64) } as never, new Date(Date.now() + 8 * 24 * 3600_000).toISOString());
    expect((await db.get<{ status: string }>('SELECT status FROM tasks WHERE task_id = ?', taskId))!.status).toBe('submitted');

    const cancel = await ownerPost(`/v1/owner/tasks/${taskId}/cancel`, {}, cookie);
    expect(cancel.status).toBe(200);
    const rep = (await (await app.request(`/v1/agents/${agent.agentId}/reputation`)).json()) as { tasks_failed: number };
    expect(rep.tasks_failed).toBeGreaterThan(0);
  });

  it('a half-signed ceremony is refused → 400', async () => {
    const { cookie } = await ownerSession();
    const taskId = await compose(cookie);
    await claimAndDeliver(taskId);
    const res = await ownerPost(`/v1/owner/tasks/${taskId}/accept`, { nonce: 'n1' }, cookie);
    expect(res.status).toBe(400);
    expect((await db.get<{ status: string }>('SELECT status FROM tasks WHERE task_id = ?', taskId))!.status).toBe('submitted');
  });

  it('rate-limits composing to 20 per hour → 429', async () => {
    const { cookie } = await ownerSession();
    for (let i = 0; i < 20; i++) await compose(cookie, { title: `t${i}` });
    const res = await ownerPost('/v1/owner/tasks', { title: 'one more', description: 'd' }, cookie);
    expect(res.status).toBe(429);
  });

  it('notifies capability-matching agents when a human posts a task', async () => {
    const hooked = await createTestAgent(db, { status: 'active', capabilities: ['code'], webhookUrl: 'https://hooked.example.com/events' });
    void hooked;
    const { cookie } = await ownerSession();
    const taskId = await compose(cookie);
    await drainOutbox(db, new Date().toISOString());
    await new Promise((r) => setTimeout(r, 10));
    const calls = mockFetch.mock.calls.filter((call: unknown[]) => call[0] === 'https://hooked.example.com/events');
    expect(calls.length).toBe(1);
    const body = JSON.parse((calls[0][1] as { body: string }).body) as { type: string; task: { task_id: string; bounty: unknown } };
    expect(body.type).toBe('task.available');
    expect(body.task.task_id).toBe(taskId);
    expect(body.task.bounty).toBeNull();
  });
});
