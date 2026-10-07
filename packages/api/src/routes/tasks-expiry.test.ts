/**
 * Open-task expiry (migration 0047, decision D13): the posted window, the
 * poster cap and house exemption, the cron sweep to `expired` with its money
 * handling, the claim-gate hardening, and the claim-expiry re-stamp.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  setupTestDb,
  createTestApp,
  createTestAgent,
  signRequest,
} from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import type { TestKeypair } from '../test-helpers.js';
import type { Bindings } from '../types/index.js';
import { runTaskCron } from '../cron/tasks.js';
import { runnerMigrationFiles } from '../db/migration-list.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

const DAY_MS = 24 * 60 * 60 * 1000;

describe('open-task expiry (0047)', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;
  let creator: TestKeypair & { name: string };
  let claimer: TestKeypair & { name: string };

  beforeEach(async () => {
    db = setupTestDb();
    app = createTestApp(db);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    creator = await createTestAgent(db, { status: 'active', capabilities: ['code'] });
    claimer = await createTestAgent(db, { status: 'active', capabilities: ['code'] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function post(agent: TestKeypair, path: string, payload?: Record<string, unknown>): Promise<Response> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const headers = await signRequest(agent, 'POST', path, body);
    return app.request(path, {
      method: 'POST',
      headers: payload === undefined ? { ...headers } : { 'Content-Type': 'application/json', ...headers },
      ...(payload === undefined ? {} : { body }),
    });
  }

  async function createTask(overrides: Record<string, unknown> = {}, agent: TestKeypair = creator): Promise<{ res: Response; body: Record<string, unknown> }> {
    const res = await post(agent, '/v1/tasks', {
      title: 'Expiring Task', description: 'window under test', category: 'code', ...overrides,
    });
    return { res, body: (await res.json()) as Record<string, unknown> };
  }

  async function taskRow(taskId: string): Promise<Record<string, unknown>> {
    return (await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE task_id = ?', taskId))!;
  }

  function daysFromNow(iso: string): number {
    return (Date.parse(iso) - Date.now()) / DAY_MS;
  }

  it('stamps the default 60-day window at post and returns it', async () => {
    const { res, body } = await createTask();
    expect(res.status).toBe(200);
    expect(typeof body.expires_at).toBe('string');
    expect(daysFromNow(body.expires_at as string)).toBeGreaterThan(59.9);
    expect(daysFromNow(body.expires_at as string)).toBeLessThan(60.1);
    const detail = await app.request(`/v1/tasks/${body.task_id}`);
    const shaped = (await detail.json()) as { task: { expires_at: string } };
    expect(shaped.task.expires_at).toBe(body.expires_at);
  });

  it('honors expires_in_days within the cap and refuses past it', async () => {
    const { body: monthly } = await createTask({ expires_in_days: 30 });
    expect(daysFromNow(monthly.expires_at as string)).toBeGreaterThan(29.9);

    const over = await createTask({ expires_in_days: 91 });
    expect(over.res.status).toBe(400);
    expect(over.body.error).toBe('expiry_window_not_allowed');

    const never = await createTask({ expires_in_days: 0 });
    expect(never.res.status).toBe(400);
    expect(never.body.error).toBe('expiry_window_not_allowed');
  });

  it('house accounts may exceed the cap and post never-expiring tasks', async () => {
    app = createTestApp(db, { HOUSE_ACCOUNT_IDS: creator.agentId });
    const standing = await createTask({ expires_in_days: 0 });
    expect(standing.res.status).toBe(200);
    expect(standing.body.expires_at).toBeNull();
    expect((await taskRow(standing.body.task_id as string)).expires_at).toBeNull();

    const yearLong = await createTask({ expires_in_days: 365 });
    expect(yearLong.res.status).toBe(200);
    expect(daysFromNow(yearLong.body.expires_at as string)).toBeGreaterThan(364);

    // The exemption is the poster's, not the deployment's.
    const other = await createTask({ expires_in_days: 365 }, claimer);
    expect(other.res.status).toBe(400);
  });

  it('the cron sweeps a lapsed open task to expired, tells the creator, and it is terminal', async () => {
    const { body } = await createTask();
    const taskId = body.task_id as string;
    const past = new Date(Date.now() - 60_000).toISOString();
    await db.run('UPDATE tasks SET expires_at = ? WHERE task_id = ?', past, taskId);

    const summary = await runTaskCron(db, {} as Bindings, new Date().toISOString());
    expect(summary.open_expired).toBe(1);

    const row = await taskRow(taskId);
    expect(row.status).toBe('expired');
    expect(row.expired_at).not.toBeNull();

    const inbox = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agent_events WHERE agent_id = ? AND type = 'task.expired'`, creator.agentId,
    );
    expect(inbox?.n).toBe(1);
    const funnel = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM funnel_events WHERE event = 'task_expired' AND funnel_id = ?`, taskId,
    );
    expect(funnel?.n).toBe(1);

    // Terminal: no claim, no cancel, and a second tick does not double-count.
    expect((await post(claimer, `/v1/tasks/${taskId}/claim`)).status).toBe(409);
    expect((await post(creator, `/v1/tasks/${taskId}/cancel`)).status).toBe(409);
    const again = await runTaskCron(db, {} as Bindings, new Date().toISOString());
    expect(again.open_expired).toBe(0);
  });

  it('a lapsed-but-unswept task already refuses claims at the gate', async () => {
    const { body } = await createTask();
    await db.run('UPDATE tasks SET expires_at = ? WHERE task_id = ?', new Date(Date.now() - 1000).toISOString(), body.task_id);
    expect((await post(claimer, `/v1/tasks/${body.task_id}/claim`)).status).toBe(409);
  });

  it('expired tasks drop out of the default listing but answer ?status=expired', async () => {
    const { body } = await createTask();
    await db.run(`UPDATE tasks SET status = 'expired', expired_at = ? WHERE task_id = ?`, new Date().toISOString(), body.task_id);
    const dflt = (await (await app.request('/v1/tasks')).json()) as { tasks: Array<{ task_id: string }> };
    expect(dflt.tasks.map((t) => t.task_id)).not.toContain(body.task_id);
    const filtered = (await (await app.request('/v1/tasks?status=expired')).json()) as { tasks: Array<{ task_id: string; status: string }> };
    expect(filtered.tasks.map((t) => t.task_id)).toContain(body.task_id);
  });

  it('a lapsed claim re-stamps a fresh open window; a never-expiring task stays NULL', async () => {
    const { body } = await createTask();
    const taskId = body.task_id as string;
    expect((await post(claimer, `/v1/tasks/${taskId}/claim`)).status).toBe(200);
    // The open window would have lapsed during the claim; the reopen must re-arm it.
    const past = new Date(Date.now() - 1000).toISOString();
    await db.run('UPDATE tasks SET claim_expires_at = ?, expires_at = ? WHERE task_id = ?', past, past, taskId);
    const summary = await runTaskCron(db, {} as Bindings, new Date().toISOString());
    expect(summary.claims_expired).toBe(1);
    expect(summary.open_expired).toBe(0); // reopened with a fresh window, not swept
    const row = await taskRow(taskId);
    expect(row.status).toBe('open');
    expect(daysFromNow(row.expires_at as string)).toBeGreaterThan(59.9);
    expect(daysFromNow(row.expires_at as string)).toBeLessThan(60.1);

    // NULL (never) survives the same round trip.
    await db.run('UPDATE tasks SET status = \'claimed\', claimed_by_agent_id = ?, claim_expires_at = ?, expires_at = NULL WHERE task_id = ?', claimer.agentId, past, taskId);
    await runTaskCron(db, {} as Bindings, new Date().toISOString());
    expect((await taskRow(taskId)).expires_at).toBeNull();
  });

  it('voids a declared bounty and starts (or defers) an escrow refund on expiry', async () => {
    // Declared sign-at-accept bounty: payment_status pending → expired + audit event.
    const declaredId = 'task_expiry_declared';
    await db.run(
      `INSERT INTO tasks (task_id, creator_agent_id, creator_kind, title, description, status, created_at, bounty_amount, bounty_token, bounty_network, payment_status, expires_at)
       VALUES (?, ?, 'agent', 't', 'd', 'open', ?, '5000000', 'USDC', 'eip155:8453', 'pending', ?)`,
      declaredId, creator.agentId, new Date().toISOString(), new Date(Date.now() - 1000).toISOString(),
    );
    // Funded escrow: the deposit must head back to the buyer (leg deferred here —
    // no house wallet in unit env — and retried by escrowSweep while `funded`).
    const escrowId = 'task_expiry_escrow';
    await db.run(
      `INSERT INTO tasks (task_id, creator_agent_id, creator_kind, title, description, status, created_at, bounty_amount, bounty_token, bounty_network, payment_status, escrow, escrow_status, expires_at)
       VALUES (?, ?, 'agent', 't', 'd', 'open', ?, '5000000', 'USDC', 'eip155:8453', 'pending', 1, 'funded', ?)`,
      escrowId, creator.agentId, new Date().toISOString(), new Date(Date.now() - 1000).toISOString(),
    );

    const summary = await runTaskCron(db, {} as Bindings, new Date().toISOString());
    expect(summary.open_expired).toBe(2);

    const declared = await taskRow(declaredId);
    expect(declared.status).toBe('expired');
    expect(declared.payment_status).toBe('expired');
    const voided = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM payment_events WHERE task_id = ? AND event_type = 'expired'`, declaredId,
    );
    expect(voided?.n).toBe(1);

    const escrow = await taskRow(escrowId);
    expect(escrow.status).toBe('expired');
    expect(escrow.escrow_status).toBe('funded'); // refund deferred, escrowSweep retries
    const refundReq = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM payment_events WHERE task_id = ? AND event_type = 'escrow_refund_requested'`, escrowId,
    );
    expect(refundReq?.n).toBe(1);
  });
});

function schemaSql(): string {
  return readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf-8');
}

function replayTo(name: string, seed?: (db: Database.Database) => void): Database.Database {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  raw.exec(schemaSql());
  for (const file of runnerMigrationFiles(MIGRATIONS_DIR)) {
    if (file >= name && seed) { seed(raw); seed = undefined; }
    raw.transaction(() => raw.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf-8')))();
  }
  return raw;
}

describe('migration 0047_task_expiry.sql', () => {
  it('grandfathers every non-terminal row with a 7-day window; allowlisted and terminal rows keep NULL', () => {
    const db = replayTo('0047', (d) => {
      d.prepare(`INSERT INTO agents (id, public_key, name, description, capabilities, protocols) VALUES ('ag_pre', ?, 'a', 'd', '[]', '[]')`).run(Buffer.from('k'.repeat(32)));
      d.prepare(`INSERT INTO tasks (task_id, creator_agent_id, title, description, status, created_at) VALUES ('task_pre_open', 'ag_pre', 't', 'd', 'open', '2026-01-01T00:00:00Z')`).run();
      // A pre-migration claim that later lapses must re-arm a window, not live forever on NULL.
      d.prepare(`INSERT INTO tasks (task_id, creator_agent_id, claimed_by_agent_id, title, description, status, created_at) VALUES ('task_pre_claimed', 'ag_pre', 'ag_pre', 't', 'd', 'claimed', '2026-01-01T00:00:00Z')`).run();
      d.prepare(`INSERT INTO tasks (task_id, creator_agent_id, title, description, status, created_at, verified_at, accepted_by) VALUES ('task_pre_done', 'ag_pre', 't', 'd', 'verified', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'creator')`).run();
      // Managed (allowlisted) work belongs to the testing jobs' own timers.
      d.prepare(`INSERT INTO tasks (task_id, creator_agent_id, title, description, status, created_at) VALUES ('task_pre_managed', 'ag_pre', 't', 'd', 'open', '2026-01-01T00:00:00Z')`).run();
      d.prepare(`INSERT INTO task_claim_allowlist (task_id, agent_id, created_at) VALUES ('task_pre_managed', 'ag_pre', '2026-01-01T00:00:00Z')`).run();
    });
    const window = (id: string) =>
      (db.prepare(`SELECT expires_at FROM tasks WHERE task_id = ?`).get(id) as { expires_at: string | null }).expires_at;
    for (const id of ['task_pre_open', 'task_pre_claimed']) {
      expect(window(id)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Date.parse(window(id) as string)).toBeGreaterThan(Date.now() + 6.9 * DAY_MS);
    }
    expect(window('task_pre_done')).toBeNull();
    expect(window('task_pre_managed')).toBeNull();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it("the rebuilt CHECK accepts 'expired' and still rejects unknown statuses", () => {
    const db = replayTo('9999');
    db.prepare(`INSERT INTO agents (id, public_key, name, description, capabilities, protocols) VALUES ('ag_new', ?, 'a', 'd', '[]', '[]')`).run(Buffer.from('k'.repeat(32)));
    expect(() =>
      db.prepare(`INSERT INTO tasks (task_id, creator_agent_id, title, description, status, created_at) VALUES ('task_x', 'ag_new', 't', 'd', 'expired', 'now')`).run(),
    ).not.toThrow();
    expect(() =>
      db.prepare(`INSERT INTO tasks (task_id, creator_agent_id, title, description, status, created_at) VALUES ('task_y', 'ag_new', 't', 'd', 'bogus', 'now')`).run(),
    ).toThrow(/CHECK/);
    db.close();
  });
});

describe('migration 0052_open_window_60d.sql', () => {
  it('moves open tasks provably on the 7-day default to 60 days and leaves every other window alone', () => {
    const created = Date.parse('2026-10-01T04:17:41.518Z');
    const reopened = created + 5 * DAY_MS + 3 * 3_600_000 + 123;
    const iso = (ms: number) => new Date(ms).toISOString();
    // [task_id, status, expires_at (ms or null), escrow, moves]
    const rows: Array<[string, string, number | null, number, boolean]> = [
      ['task_default', 'open', created + 7 * DAY_MS, 0, true],
      // The console stamps the window before its awaited checks, created_at after them.
      ['task_default_console_6s', 'open', created + 7 * DAY_MS - 6_000, 0, true],
      ['task_default_console_90s', 'open', created + 7 * DAY_MS - 90_000, 0, true],
      // A lapsed claim reopened it: the cron recorded task.claim_expired at the re-stamp's base time.
      ['task_restamped', 'open', reopened + 7 * DAY_MS, 0, true],
      // Same shape, but no recorded reopen: nothing proves it is a default window.
      ['task_restamp_shape_no_event', 'open', reopened + 7 * DAY_MS, 0, false],
      ['task_chosen_14', 'open', created + 14 * DAY_MS, 0, false],
      // A chosen window whose console post took 6 s to stamp created_at.
      ['task_chosen_14_console_6s', 'open', created + 14 * DAY_MS - 6_000, 0, false],
      ['task_chosen_3', 'open', created + 3 * DAY_MS, 0, false],
      ['task_never', 'open', null, 0, false],
      ['task_escrow', 'open', created + 7 * DAY_MS, 1, false],
      ['task_claimed', 'claimed', created + 7 * DAY_MS, 0, false],
      ['task_expired', 'expired', created + 7 * DAY_MS, 0, false],
    ];
    const db = replayTo('0052', (d) => {
      d.prepare(`INSERT INTO agents (id, public_key, name, description, capabilities, protocols) VALUES ('ag_w', ?, 'a', 'd', '[]', '[]')`).run(Buffer.from('w'.repeat(32)));
      const insert = d.prepare(
        `INSERT INTO tasks (task_id, creator_agent_id, claimed_by_agent_id, title, description, status, created_at, expires_at, escrow, escrow_status)
         VALUES (?, 'ag_w', ?, 't', 'd', ?, ?, ?, ?, ?)`,
      );
      for (const [id, status, expires, escrow] of rows) {
        insert.run(id, status === 'claimed' ? 'ag_w' : null, status, iso(created), expires === null ? null : iso(expires), escrow, escrow ? 'funded' : null);
      }
      d.prepare(
        `INSERT INTO agent_events (id, agent_id, type, ref_kind, ref_id, payload, created_at)
         VALUES ('evt_reopen', 'ag_w', 'task.claim_expired', 'task', 'task_restamped', '{}', ?)`,
      ).run(iso(reopened));
    });
    for (const [id, , expires, , moves] of rows) {
      const got = (db.prepare(`SELECT expires_at FROM tasks WHERE task_id = ?`).get(id) as { expires_at: string | null }).expires_at;
      const want = expires === null ? null : iso(moves ? expires + 53 * DAY_MS : expires);
      expect(got, id).toBe(want);
    }
    db.close();
  });
});
