/**
 * Regression (review fix): the lazy cleanup must be scoped to the caller's own
 * key. A key-blind DELETE using the caller's window let any short-window
 * limiter (e.g. a 60s per-IP board read) garbage-collect another key's
 * still-live rows — silently uncapping the board's hourly buckets, the
 * uncertified valve, and the 10/hour DM limiter.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb } from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import { checkRateLimit } from './rate-limiter.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;

describe('checkRateLimit lazy cleanup is key-scoped', () => {
  let db: SQLiteAdapter;

  beforeEach(() => {
    db = setupTestDb();
    // Force the 10%-probability cleanup to fire on every allowed call, so the
    // test is deterministic instead of relying on ~60 rounds of chance.
    vi.spyOn(Math, 'random').mockReturnValue(0.0);
  });
  afterEach(() => vi.restoreAllMocks());

  it("a short-window key's cleanup does not delete an hourly key's live rows", async () => {
    // An hourly bucket (1h window) sitting at 4 rows, each 3 minutes old:
    // still live for the hourly key (< 1h), but OLDER than 2×60s — exactly the
    // rows a 60s-window caller's key-blind cleanup used to purge.
    const threeMinAgo = new Date(Date.now() - 3 * MINUTE).toISOString();
    for (let i = 0; i < 4; i++) {
      await db.run('INSERT INTO rate_limit_log (id, key, created_at) VALUES (?, ?, ?)',
        `seed_${i}`, 'board:agentX', threeMinAgo);
    }

    // Hammer a DIFFERENT, short-window (60s) key. Each allowed call fires the
    // (now key-scoped) cleanup with cutoff = now - 120s.
    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimit(db, 'board:posts:1.2.3.4', 120, MINUTE);
      expect(r.allowed).toBe(true);
    }

    // The hourly key's rows survive: key-scoped cleanup never touched them.
    const surviving = await db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM rate_limit_log WHERE key = ?', 'board:agentX');
    expect(surviving?.n).toBe(4);

    // And the hourly limit still bites: 4 seeded + a 5th allowed → 6th blocked
    // at max=5 over the hour window.
    expect((await checkRateLimit(db, 'board:agentX', 5, HOUR)).allowed).toBe(true);
    expect((await checkRateLimit(db, 'board:agentX', 5, HOUR)).allowed).toBe(false);
  });

  it("a key still trims its OWN rows older than 2× its window", async () => {
    const old = new Date(Date.now() - 5 * MINUTE).toISOString();
    await db.run('INSERT INTO rate_limit_log (id, key, created_at) VALUES (?, ?, ?)', 'stale', 'k', old);
    // A 60s-window call on 'k' cleans up k's own >120s-old rows.
    await checkRateLimit(db, 'k', 100, MINUTE);
    const staleGone = await db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM rate_limit_log WHERE key = 'k' AND id = 'stale'");
    expect(staleGone?.n).toBe(0);
  });
});
