/**
 * Tests for migration 0033_board.sql (board_posts / board_reports /
 * agents.name_skeleton) — spec §12.1.
 *
 * The migration must be visible to three harnesses: wrangler d1 (directory
 * scan), the node runner (src/node.ts ≥0023 filter), and the vitest schema in
 * test-helpers.ts (inlined statements). The first two are exercised here by
 * replaying the real file the way node.ts does; the third via a parity test
 * on setupTestDb() so the inlined copy can't silently drift from the file.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTestDb } from './test-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const SCHEMA_SQL = readFileSync(join(__dirname, 'db', 'schema.sql'), 'utf-8');
const SQL_0033 = readFileSync(join(MIGRATIONS_DIR, '0033_board.sql'), 'utf-8');

/** Apply migrations exactly the way src/node.ts does on an existing deploy. */
function nodeRunnerMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f >= '0023' && f.endsWith('.sql'))
    .sort();
}

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

/** schema.sql + 0021 + all ≥0023 migrations except 0033 — a pre-board deploy. */
function existingDb(): Database.Database {
  const db = freshDb();
  db.exec(readFileSync(join(MIGRATIONS_DIR, '0021_rate_limit_table.sql'), 'utf-8'));
  for (const file of nodeRunnerMigrations()) {
    if (file === '0033_board.sql') continue;
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf-8'));
  }
  return db;
}

function insertAgent(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO agents (id, public_key, name, description, capabilities, protocols)
     VALUES (?, ?, ?, 'test', '[]', '[]')`
  ).run(id, Buffer.from(id.padEnd(32, 'x')), `agent-${id}`);
}

function insertPost(
  db: Database.Database,
  post: { id: string; agent?: string | null; owner?: string | null; kind?: string }
): void {
  db.prepare(
    `INSERT INTO board_posts (id, author_agent_id, author_owner_id, author_kind, body, body_sha256, thread_root_id, created_at)
     VALUES (?, ?, ?, ?, 'hello board', 'deadbeef', ?, ?)`
  ).run(post.id, post.agent ?? null, post.owner ?? null, post.kind ?? 'agent', post.id, new Date().toISOString());
}

describe('migration 0033_board.sql', () => {
  it('is picked up by the node runner filter (≥0023, .sql)', () => {
    // The runner auto-applies by directory scan — a misnamed file (e.g.
    // starting below '0023') would silently never run locally.
    expect(nodeRunnerMigrations()).toContain('0033_board.sql');
  });

  it('applies clean on a fresh DB (schema.sql only)', () => {
    const db = freshDb();
    expect(() => db.exec(SQL_0033)).not.toThrow();

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'board%' ORDER BY name`)
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(['board_posts', 'board_reports']);

    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_board%' ORDER BY name`)
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toEqual(['idx_board_author', 'idx_board_status_seq', 'idx_board_thread']);

    const agentCols = db.prepare(`PRAGMA table_info(agents)`).all() as { name: string }[];
    expect(agentCols.some((c) => c.name === 'name_skeleton')).toBe(true);
    db.close();
  });

  it('applies clean on an existing DB (all prior migrations applied)', () => {
    const db = existingDb();
    expect(() => db.exec(SQL_0033)).not.toThrow();

    // Round-trip a row to prove the table is usable, not just present.
    insertAgent(db, 'ag_replay');
    insertPost(db, { id: 'post_replay', agent: 'ag_replay' });
    const row = db.prepare(`SELECT seq, status FROM board_posts WHERE id = ?`).get('post_replay') as {
      seq: number;
      status: string;
    };
    expect(row.seq).toBe(1); // AUTOINCREMENT cursor spine starts at 1
    expect(row.status).toBe('visible');
    db.close();
  });

  describe('XOR authorship CHECK', () => {
    function migratedDb(): Database.Database {
      const db = freshDb();
      db.exec(SQL_0033);
      insertAgent(db, 'ag_author');
      return db;
    }

    it('accepts agent-only and owner-only authorship', () => {
      const db = migratedDb();
      expect(() => insertPost(db, { id: 'post_agent', agent: 'ag_author' })).not.toThrow();
      expect(() => insertPost(db, { id: 'post_owner', owner: 'ow_human', kind: 'owner' })).not.toThrow();
      db.close();
    });

    it('rejects a post with BOTH author columns set', () => {
      const db = migratedDb();
      expect(() => insertPost(db, { id: 'post_both', agent: 'ag_author', owner: 'ow_human' })).toThrow(/CHECK/);
      db.close();
    });

    it('rejects a post with NEITHER author column set', () => {
      const db = migratedDb();
      expect(() => insertPost(db, { id: 'post_neither' })).toThrow(/CHECK/);
      db.close();
    });

    it('rejects an author_kind outside agent|owner', () => {
      const db = migratedDb();
      expect(() => insertPost(db, { id: 'post_kind', agent: 'ag_author', kind: 'bot' })).toThrow(/CHECK/);
      db.close();
    });
  });

  describe('test-helpers parity (inlined EXTRA_ALTER_STATEMENTS copy)', () => {
    it('setupTestDb carries the board tables, skeleton column, and the XOR CHECK', async () => {
      // The vitest harness inlines the schema instead of reading the file —
      // if the copy drifts, route tests pass against a shape prod won't have.
      const adapter = setupTestDb();
      insertAgent(
        // Reach the raw handle through the adapter-owned Database instance.
        (adapter as unknown as { db: Database.Database }).db,
        'ag_helper'
      );
      await adapter.run(
        `INSERT INTO board_posts (id, author_agent_id, author_kind, body, body_sha256, thread_root_id, created_at)
         VALUES (?, ?, 'agent', 'b', 'sha', ?, ?)`,
        'post_helper', 'ag_helper', 'post_helper', new Date().toISOString()
      );
      await expect(
        adapter.run(
          `INSERT INTO board_posts (id, author_kind, body, body_sha256, thread_root_id, created_at)
           VALUES (?, 'agent', 'b', 'sha', ?, ?)`,
          'post_helper2', 'post_helper2', new Date().toISOString()
        )
      ).rejects.toThrow(/CHECK/);

      await adapter.run(
        `INSERT INTO board_reports (post_id, reporter_agent_id, created_at) VALUES (?, ?, ?)`,
        'post_helper', 'ag_helper', new Date().toISOString()
      );
      const skeleton = await adapter.get<{ name_skeleton: string | null }>(
        `SELECT name_skeleton FROM agents WHERE id = ?`, 'ag_helper'
      );
      expect(skeleton).toBeDefined(); // column exists; NULL rows are grandfathered
    });
  });

  describe('board_reports', () => {
    it('enforces one report per (post, reporter) via the composite PK', () => {
      const db = freshDb();
      db.exec(SQL_0033);
      insertAgent(db, 'ag_author');
      insertPost(db, { id: 'post_x', agent: 'ag_author' });
      const insert = db.prepare(
        `INSERT INTO board_reports (post_id, reporter_agent_id, reporter_owner_id, created_at) VALUES (?, ?, ?, ?)`
      );
      insert.run('post_x', 'ag_reporter', null, new Date().toISOString());
      expect(() => insert.run('post_x', 'ag_reporter', 'ow_late', new Date().toISOString())).toThrow(/UNIQUE|PRIMARY/i);
      db.close();
    });
  });
});
