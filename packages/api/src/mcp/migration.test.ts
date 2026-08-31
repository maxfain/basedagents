/**
 * 0034 migration-replay test: prove the six OAuth tables create cleanly on a
 * FRESH better-sqlite3 DB after the owner tables exist (0023 + 0025), the exact
 * order the api Worker's migrate step applies them in. Also spot-checks the two
 * load-bearing invariants at the schema level: the owner FK cascades, and the
 * atomic single-use consume flips exactly one row.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OAUTH_MCP_MIGRATION_SQL } from './test-migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

const OAUTH_TABLES = [
  'oauth_clients',
  'oauth_authorization_requests',
  'oauth_login_challenges',
  'oauth_auth_codes',
  'oauth_access_tokens',
  'oauth_refresh_tokens',
];

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Minimal agents table (0023's delegation FK target), then owners(0023)+0025.
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active');`);
  db.exec(readFileSync(join(MIGRATIONS_DIR, '0023_owner_accounts.sql'), 'utf-8'));
  db.exec(readFileSync(join(MIGRATIONS_DIR, '0025_owner_recovery.sql'), 'utf-8'));
});

describe('0034_oauth_mcp migration', () => {
  it('applies cleanly on a fresh DB after 0023+0025', () => {
    expect(() => db.exec(OAUTH_MCP_MIGRATION_SQL)).not.toThrow();
  });

  it('creates exactly the six OAuth tables', () => {
    db.exec(OAUTH_MCP_MIGRATION_SQL);
    for (const t of OAUTH_TABLES) {
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(t);
      expect(row, `table ${t} should exist`).toBeTruthy();
    }
  });

  it('creates the expected indexes', () => {
    db.exec(OAUTH_MCP_MIGRATION_SQL);
    for (const idx of [
      'idx_oauth_clients_created',
      'idx_oauth_codes_client',
      'idx_oat_owner',
    ]) {
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
        .get(idx);
      expect(row, `index ${idx} should exist`).toBeTruthy();
    }
  });

  it('cascades owner deletes to access tokens (FK ON DELETE CASCADE)', () => {
    db.exec(OAUTH_MCP_MIGRATION_SQL);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO owners (id, email) VALUES ('ow_x', 'x@example.com')`).run();
    db.prepare(
      `INSERT INTO oauth_access_tokens (token_hash, client_id, owner_id, resource, scope, created_at, expires_at)
       VALUES ('h', 'oc_1', 'ow_x', 'https://mcp.basedagents.ai/mcp', 'registry:read', ?, ?)`
    ).run(now, now);
    db.prepare(`DELETE FROM owners WHERE id='ow_x'`).run();
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM oauth_access_tokens`)
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('single-use consume flips exactly one row (atomic .changes===1)', () => {
    db.exec(OAUTH_MCP_MIGRATION_SQL);
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    db.prepare(`INSERT INTO owners (id) VALUES ('ow_y')`).run();
    db.prepare(
      `INSERT INTO oauth_login_challenges (token_hash, owner_id, authreq_id, created_at, expires_at)
       VALUES ('lh', 'ow_y', 'authreq_1', ?, ?)`
    ).run(now, future);
    const consume = () =>
      db
        .prepare(
          `UPDATE oauth_login_challenges SET consumed_at=? WHERE token_hash='lh' AND consumed_at IS NULL AND expires_at > ?`
        )
        .run(new Date().toISOString(), new Date().toISOString());
    expect(consume().changes).toBe(1); // first consume wins
    expect(consume().changes).toBe(0); // replay is a no-op
  });
});
