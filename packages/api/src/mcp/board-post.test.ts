/**
 * insertOwnerBoardPost — the shared owner board write (spec §6), exercised
 * against a real better-sqlite3 DB with foreign_keys ON so board_posts' XOR
 * check and column shape are actually enforced.
 *
 * setupMcpTestDb() builds board_posts (0033) et al. but NOT the rate_limit_log
 * table (0021) — checkRateLimit's backing store — so we graft 0021 onto the raw
 * handle here; this is the one src/mcp unit whose code path touches the limiter.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupMcpTestDb } from './test-migrations.js';
import { insertOwnerBoardPost } from './board-post.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import { sha256, bytesToHex } from '../crypto/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RATE_LIMIT_SQL = readFileSync(
  join(__dirname, '..', '..', 'migrations', '0021_rate_limit_table.sql'),
  'utf-8',
);

const te = new TextEncoder();
const bodyHash = (body: string): string => bytesToHex(sha256(te.encode(body)));

interface PostRow {
  id: string;
  author_agent_id: string | null;
  author_owner_id: string;
  author_kind: string;
  assertion_id: string | null;
  body: string;
  body_sha256: string;
  reply_to_post_id: string | null;
  thread_root_id: string;
  status: string;
  created_at: string;
}

describe('insertOwnerBoardPost', () => {
  let rawDb: Database.Database;
  let db: SQLiteAdapter;

  beforeEach(() => {
    const setup = setupMcpTestDb();
    rawDb = setup.rawDb;
    db = setup.db;
    // Graft the limiter's table (0021) onto the MCP schema for this unit.
    rawDb.exec(RATE_LIMIT_SQL);
  });

  it('rate-limit-passes then writes a well-formed owner root post', async () => {
    const body = 'hello board, from a connector';
    const res = await insertOwnerBoardPost(db, 'ow_alice', body, 'assert_123');

    expect(res.ok).toBe(true);
    if (!res.ok) return; // narrow
    expect(res.post_id).toMatch(/^post_[0-9A-Za-z]{21}$/);
    expect(res.created_at).toBeTruthy();
    expect(() => new Date(res.created_at).toISOString()).not.toThrow();

    const row = rawDb.prepare('SELECT * FROM board_posts WHERE id = ?').get(res.post_id) as PostRow;
    expect(row.author_kind).toBe('owner');
    expect(row.author_owner_id).toBe('ow_alice');
    expect(row.author_agent_id).toBeNull();     // XOR check: owner set, agent null
    expect(row.assertion_id).toBe('assert_123'); // provenance carried through
    expect(row.body).toBe(body);
    expect(row.body_sha256).toBe(bodyHash(body)); // hash re-derived inside, not trusted
    expect(row.reply_to_post_id).toBeNull();     // roots only
    expect(row.thread_root_id).toBe(res.post_id); // = id for roots
    expect(row.status).toBe('visible');
  });

  it('stores assertion_id NULL when omitted (connector / session-only path)', async () => {
    const omitted = await insertOwnerBoardPost(db, 'ow_bob', 'no signature here');
    expect(omitted.ok).toBe(true);
    if (!omitted.ok) return;
    const r1 = rawDb.prepare('SELECT assertion_id FROM board_posts WHERE id = ?').get(omitted.post_id) as {
      assertion_id: string | null;
    };
    expect(r1.assertion_id).toBeNull();

    // Explicit null behaves identically to omission.
    const explicit = await insertOwnerBoardPost(db, 'ow_bob', 'still none', null);
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    const r2 = rawDb.prepare('SELECT assertion_id FROM board_posts WHERE id = ?').get(explicit.post_id) as {
      assertion_id: string | null;
    };
    expect(r2.assertion_id).toBeNull();
  });

  it('returns { ok:false, reason:"rate_limited" } on the 61st post in the hour, writing nothing', async () => {
    // Drive the limiter through its OWN code path: 60 posts fill the bucket.
    for (let i = 0; i < 60; i++) {
      const res = await insertOwnerBoardPost(db, 'ow_carol', `post ${i}`);
      expect(res.ok).toBe(true);
    }
    const before = (rawDb.prepare('SELECT COUNT(*) AS n FROM board_posts').get() as { n: number }).n;
    expect(before).toBe(60);

    const limited = await insertOwnerBoardPost(db, 'ow_carol', 'the 61st post');
    expect(limited).toEqual({ ok: false, reason: 'rate_limited' });

    // A 429 writes no row (rate-limit BEFORE the INSERT).
    const after = (rawDb.prepare('SELECT COUNT(*) AS n FROM board_posts').get() as { n: number }).n;
    expect(after).toBe(60);
  });

  it("scopes the 60/hr budget per owner — one owner's cap never blocks another", async () => {
    for (let i = 0; i < 60; i++) {
      await insertOwnerBoardPost(db, 'ow_dave', `d ${i}`);
    }
    expect(await insertOwnerBoardPost(db, 'ow_dave', 'over')).toEqual({ ok: false, reason: 'rate_limited' });
    // Distinct bucket board:owner:ow_erin is untouched.
    const erin = await insertOwnerBoardPost(db, 'ow_erin', 'fresh owner, fresh budget');
    expect(erin.ok).toBe(true);
  });
});
