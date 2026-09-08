/**
 * Tests for migration 0035_task_review.sql — the tasks rebuild (nullable
 * creator_agent_id + owner creators, accept/revision/dispute bookkeeping,
 * settlement slot columns) — Tasks P0 spec §4.
 *
 * The migration must be visible to three harnesses: wrangler d1 (directory
 * scan), the node runner (src/node.ts — the full chain from
 * db/migration-list.ts, one transaction per file), and the vitest schema in
 * test-helpers.ts (inlined statements). The first two are exercised here by
 * replaying the real files the way node.ts does — inside a transaction with
 * foreign_keys=ON, which is what makes the file's PRAGMA defer_foreign_keys
 * effective — the third via a parity test on setupTestDb() so the inlined
 * copy can't silently drift from the file.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTestDb } from './test-helpers.js';
import { RUNNER_LOCAL_STATEMENTS, migrationFilesBefore, runnerMigrationFiles } from './db/migration-list.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const SCHEMA_SQL = readFileSync(join(__dirname, 'db', 'schema.sql'), 'utf-8');
const FILE_0035 = '0035_task_review.sql';
const SQL_0035 = readFileSync(join(MIGRATIONS_DIR, FILE_0035), 'utf-8');

const TASK_STATUSES = ['open', 'claimed', 'submitted', 'verified', 'closed', 'cancelled'];

/** Apply files exactly the way src/node.ts does: one transaction per file. */
function applyMigrations(db: Database.Database, files: string[]): void {
  for (const file of files) {
    db.transaction(() => db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf-8')))();
  }
}

/** What initDatabase() gives the runner before any migration: schema.sql, FKs on. */
function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

/** schema.sql + every migration before 0035 — a deploy that has not run it yet. */
function existingDb(): Database.Database {
  const db = freshDb();
  applyMigrations(db, migrationFilesBefore(MIGRATIONS_DIR, '0035'));
  return db;
}

function migratedDb(): Database.Database {
  const db = existingDb();
  applyMigrations(db, [FILE_0035]);
  return db;
}

function insertAgent(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO agents (id, public_key, name, description, capabilities, protocols)
     VALUES (?, ?, ?, 'test', '[]', '[]')`
  ).run(id, Buffer.from(id.padEnd(32, 'x')), `agent-${id}`);
}

/** Insert against the 0035 shape; every constraint under test is reachable from here. */
function insertTask(
  db: Database.Database,
  task: {
    id: string;
    agent?: string | null;
    owner?: string | null;
    kind?: string;
    status?: string;
    acceptedBy?: string | null;
    nonce?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO tasks (task_id, creator_agent_id, creator_owner_id, creator_kind, title, description, status, created_at, accepted_by, payment_nonce)
     VALUES (?, ?, ?, ?, 't', 'd', ?, ?, ?, ?)`
  ).run(
    task.id,
    task.agent ?? null,
    task.owner ?? null,
    task.kind ?? 'agent',
    task.status ?? 'open',
    new Date().toISOString(),
    task.acceptedBy ?? null,
    task.nonce ?? null
  );
}

/**
 * The prod shape right before 0035: a claimed+submitted task with a
 * submission, a signed receipt and a payment event — every child table that
 * REFERENCES tasks(task_id) has a row, so the rebuild has to survive FKs.
 */
function seedPre0035(db: Database.Database): void {
  insertAgent(db, 'ag_creator');
  insertAgent(db, 'ag_deliverer');
  db.prepare(
    `INSERT INTO tasks (task_id, creator_agent_id, claimed_by_agent_id, title, description, status, created_at, claimed_at, submitted_at, payment_status)
     VALUES ('task_live', 'ag_creator', 'ag_deliverer', 't', 'd', 'submitted', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z', 'none')`
  ).run();
  db.prepare(
    `INSERT INTO submissions (submission_id, task_id, agent_id, content, summary, created_at)
     VALUES ('sub_live', 'task_live', 'ag_deliverer', '{}', 's', '2026-01-03T00:00:00Z')`
  ).run();
  db.prepare(
    `INSERT INTO delivery_receipts (receipt_id, task_id, agent_id, summary, completed_at, signature)
     VALUES ('rcpt_live', 'task_live', 'ag_deliverer', 's', '2026-01-03T00:00:00Z', 'sig')`
  ).run();
  db.prepare(
    `INSERT INTO payment_events (id, task_id, event_type, created_at)
     VALUES ('pev_live', 'task_live', 'submitted', '2026-01-03T00:00:00Z')`
  ).run();
}

function tableNames(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map(
    (t) => t.name
  );
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
}

describe('migration 0035_task_review.sql', () => {
  it('is in the node runner list, which starts at 0001 (full-chain replay)', () => {
    // node.ts applies by directory scan of the shared list — a misnamed file
    // would silently never run locally, and a list that skipped the early
    // files would leave the runner without a tasks table to rebuild.
    const files = runnerMigrationFiles(MIGRATIONS_DIR);
    expect(files[0]).toBe('0001_initial.sql');
    expect(files).toContain(FILE_0035);
    expect(files).toEqual([...files].sort());

    const before = migrationFilesBefore(MIGRATIONS_DIR, '0035');
    expect(before).not.toContain(FILE_0035);
    expect(before[before.length - 1]).toBe('0034_oauth_mcp.sql');
    expect(migrationFilesBefore(MIGRATIONS_DIR, '0033_board.sql')).not.toContain('0033_board.sql');
  });

  it('fresh DB: schema.sql + the full chain applies in per-file transactions with foreign_keys=ON', () => {
    const db = freshDb();
    expect(() => applyMigrations(db, runnerMigrationFiles(MIGRATIONS_DIR))).not.toThrow();
    expect(db.inTransaction).toBe(false);

    const tables = tableNames(db);
    for (const t of ['tasks', 'submissions', 'delivery_receipts', 'payment_events', 'funnel_events', 'used_signatures']) {
      expect(tables).toContain(t);
    }
    expect(tables).not.toContain('tasks_backup');
    expect(columnNames(db, 'tasks')).toContain('creator_kind');
    expect(columnNames(db, 'chain')).toContain('entry_type'); // 0008 — the gap-list runner lacked it

    // The runner's guarded shims (N8): no migration defines these two columns.
    for (const stmt of RUNNER_LOCAL_STATEMENTS) expect(() => db.exec(stmt)).not.toThrow();
    expect(columnNames(db, 'agents')).toEqual(expect.arrayContaining(['webhook_url', 'reputation_override']));
    db.close();
  });

  describe('existing deploy (every migration before 0035, child rows present)', () => {
    it('applies inside a transaction; rows survive; FKs resolve to the rebuilt table', () => {
      const db = existingDb();
      seedPre0035(db);

      expect(() => applyMigrations(db, [FILE_0035])).not.toThrow();
      expect(db.inTransaction).toBe(false);

      const task = db
        .prepare(`SELECT creator_agent_id, creator_owner_id, creator_kind, claimed_by_agent_id, status, accepted_by, payment_status, revision_count FROM tasks WHERE task_id = 'task_live'`)
        .get() as Record<string, unknown>;
      expect(task).toMatchObject({
        creator_agent_id: 'ag_creator',
        creator_owner_id: null,
        creator_kind: 'agent',
        claimed_by_agent_id: 'ag_deliverer',
        status: 'submitted',
        accepted_by: null,
        payment_status: 'none',
        revision_count: 0,
      });
      const counts = db
        .prepare(
          `SELECT (SELECT count(*) FROM submissions) AS s, (SELECT count(*) FROM delivery_receipts) AS r, (SELECT count(*) FROM payment_events) AS p`
        )
        .get() as { s: number; r: number; p: number };
      expect(counts).toEqual({ s: 1, r: 1, p: 1 });

      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(tableNames(db)).not.toContain('tasks_backup');

      // The children's REFERENCES tasks(task_id) now bind to the recreated table.
      expect(() =>
        db
          .prepare(
            `INSERT INTO delivery_receipts (receipt_id, task_id, agent_id, summary, completed_at, signature) VALUES ('rcpt_orphan', 'task_missing', 'ag_deliverer', 's', 'now', 'sig')`
          )
          .run()
      ).toThrow(/FOREIGN KEY/);
      db.close();
    });

    it('maps legacy rows: verified → accepted_by=creator, non-atomic bounty → NULL, authorized → expired', () => {
      const db = existingDb();
      insertAgent(db, 'ag_creator');
      db.prepare(
        `INSERT INTO tasks (task_id, creator_agent_id, title, description, status, created_at, verified_at, bounty_amount, bounty_token, bounty_network, payment_status, payment_verified)
         VALUES ('task_legacy', 'ag_creator', 't', 'd', 'verified', '2026-01-01T00:00:00Z', '2026-01-05T00:00:00Z', '$5.00', 'USDC', 'eip155:8453', 'authorized', NULL)`
      ).run();
      db.prepare(
        `INSERT INTO tasks (task_id, creator_agent_id, title, description, status, created_at, bounty_amount, payment_status)
         VALUES ('task_atomic', 'ag_creator', 't', 'd', 'open', '2026-01-01T00:00:00Z', '5000000', 'settled')`
      ).run();
      applyMigrations(db, [FILE_0035]);

      const rows = db
        .prepare(`SELECT task_id, accepted_by, bounty_amount, bounty_token, payment_status, payment_verified FROM tasks ORDER BY task_id`)
        .all();
      expect(rows).toEqual([
        { task_id: 'task_atomic', accepted_by: null, bounty_amount: '5000000', bounty_token: null, payment_status: 'settled', payment_verified: 0 },
        { task_id: 'task_legacy', accepted_by: 'creator', bounty_amount: null, bounty_token: 'USDC', payment_status: 'expired', payment_verified: 0 },
      ]);
      db.close();
    });

    it('applies when tasks is empty', () => {
      const db = existingDb();
      expect(() => applyMigrations(db, [FILE_0035])).not.toThrow();
      expect(db.prepare(`SELECT count(*) AS c FROM tasks`).get()).toEqual({ c: 0 });
      db.close();
    });

    it('needs the transaction: in autocommit the DROP fails at its own commit with child rows', () => {
      // This is why node.ts wraps every file in db.transaction() and why the
      // file relies on D1's implicit migration transaction: DROP TABLE runs an
      // implicit DELETE whose deferred FK violations are checked when the
      // statement's own transaction commits — before the refill can happen.
      const db = existingDb();
      seedPre0035(db);
      expect(() => db.exec(SQL_0035)).toThrow(/FOREIGN KEY/);
      db.close();
    });
  });

  describe('CHECK constraints on the rebuilt table', () => {
    function db0035(): Database.Database {
      const db = migratedDb();
      insertAgent(db, 'ag_author');
      return db;
    }

    it('creator XOR: exactly one of creator_agent_id / creator_owner_id', () => {
      const db = db0035();
      expect(() => insertTask(db, { id: 't_agent', agent: 'ag_author' })).not.toThrow();
      expect(() => insertTask(db, { id: 't_owner', owner: 'ow_human', kind: 'owner' })).not.toThrow();
      expect(() => insertTask(db, { id: 't_both', agent: 'ag_author', owner: 'ow_human' })).toThrow(/CHECK/);
      expect(() => insertTask(db, { id: 't_neither' })).toThrow(/CHECK/);
      // creator_agent_id is nullable now, but still a real FK when set.
      expect(() => insertTask(db, { id: 't_ghost', agent: 'ag_missing' })).toThrow(/FOREIGN KEY/);
      db.close();
    });

    it('creator_kind is agent|owner', () => {
      const db = db0035();
      expect(() => insertTask(db, { id: 't_kind', agent: 'ag_author', kind: 'bot' })).toThrow(/CHECK/);
      db.close();
    });

    it('accepted_by is NULL|creator|auto', () => {
      const db = db0035();
      expect(() => insertTask(db, { id: 't_acc_null', agent: 'ag_author', acceptedBy: null })).not.toThrow();
      expect(() => insertTask(db, { id: 't_acc_creator', agent: 'ag_author', acceptedBy: 'creator' })).not.toThrow();
      expect(() => insertTask(db, { id: 't_acc_auto', agent: 'ag_author', acceptedBy: 'auto' })).not.toThrow();
      expect(() => insertTask(db, { id: 't_acc_bad', agent: 'ag_author', acceptedBy: 'cron' })).toThrow(/CHECK/);
      db.close();
    });

    it('status set is unchanged (D4/D5: no new enum values)', () => {
      const db = db0035();
      for (const status of TASK_STATUSES) {
        expect(() => insertTask(db, { id: `t_${status}`, agent: 'ag_author', status })).not.toThrow();
      }
      for (const status of ['accepted', 'disputed', 'revision_requested']) {
        expect(() => insertTask(db, { id: `t_${status}`, agent: 'ag_author', status })).toThrow(/CHECK/);
      }
      db.close();
    });

    it('payment_nonce is UNIQUE when set (authorization replay), NULLs unconstrained', () => {
      const db = db0035();
      expect(() => insertTask(db, { id: 't_n1', agent: 'ag_author', nonce: '0xabc' })).not.toThrow();
      expect(() => insertTask(db, { id: 't_n2', agent: 'ag_author', nonce: '0xabc' })).toThrow(/UNIQUE/);
      expect(() => insertTask(db, { id: 't_n3', agent: 'ag_author' })).not.toThrow();
      expect(() => insertTask(db, { id: 't_n4', agent: 'ag_author' })).not.toThrow();
      db.close();
    });
  });

  describe('test-helpers parity (inlined EXTRA_ALTER_STATEMENTS copy)', () => {
    type ColumnShape = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
    type IndexShape = { name: string; unique: number; partial: number };

    function columns(db: Database.Database, table: string): ColumnShape[] {
      return (db.pragma(`table_info(${table})`) as ColumnShape[]).map(({ name, type, notnull, dflt_value, pk }) => ({
        name,
        type,
        notnull,
        dflt_value,
        pk,
      }));
    }
    function indexes(db: Database.Database, table: string): IndexShape[] {
      return (db.pragma(`index_list(${table})`) as IndexShape[])
        .map(({ name, unique, partial }) => ({ name, unique, partial }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    it('setupTestDb() has the same tasks columns and indexes as the migrated file', () => {
      // The vitest harness inlines the schema instead of reading the file —
      // if the copy drifts, route tests pass against a shape prod won't have.
      const helper = (setupTestDb() as unknown as { db: Database.Database }).db;
      const migrated = migratedDb();

      expect(columns(helper, 'tasks')).toEqual(columns(migrated, 'tasks'));
      expect(indexes(helper, 'tasks')).toEqual(indexes(migrated, 'tasks'));
      expect(indexes(helper, 'delivery_receipts')).toEqual(indexes(migrated, 'delivery_receipts'));
      expect(columns(helper, 'funnel_events')).toEqual(columns(migrated, 'funnel_events'));

      migrated.close();
      helper.close();
    });

    it('setupTestDb() enforces the same CHECKs and nonce UNIQUE', async () => {
      const adapter = setupTestDb();
      const raw = (adapter as unknown as { db: Database.Database }).db;
      insertAgent(raw, 'ag_helper');

      await expect(
        adapter.run(
          `INSERT INTO tasks (task_id, creator_agent_id, creator_owner_id, title, description, created_at) VALUES (?, ?, ?, 't', 'd', ?)`,
          't_both', 'ag_helper', 'ow_human', new Date().toISOString()
        )
      ).rejects.toThrow(/CHECK/);
      await expect(
        adapter.run(
          `INSERT INTO tasks (task_id, creator_owner_id, creator_kind, title, description, created_at) VALUES (?, ?, 'owner', 't', 'd', ?)`,
          't_owner', 'ow_human', new Date().toISOString()
        )
      ).resolves.toEqual({ changes: 1 });
      await expect(
        adapter.run(
          `INSERT INTO tasks (task_id, creator_agent_id, title, description, created_at, accepted_by) VALUES (?, ?, 't', 'd', ?, 'cron')`,
          't_acc', 'ag_helper', new Date().toISOString()
        )
      ).rejects.toThrow(/CHECK/);
      await adapter.run(
        `INSERT INTO tasks (task_id, creator_agent_id, title, description, created_at, payment_nonce) VALUES (?, ?, 't', 'd', ?, '0xabc')`,
        't_n1', 'ag_helper', new Date().toISOString()
      );
      await expect(
        adapter.run(
          `INSERT INTO tasks (task_id, creator_agent_id, title, description, created_at, payment_nonce) VALUES (?, ?, 't', 'd', ?, '0xabc')`,
          't_n2', 'ag_helper', new Date().toISOString()
        )
      ).rejects.toThrow(/UNIQUE/);
    });
  });
});
