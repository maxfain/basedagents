import type { DBAdapter } from '../db/adapter.js';

/**
 * D1-based rate limiter for Cloudflare Workers.
 * Uses a simple sliding window approach.
 * Requires the rate_limit_log table (migration 0021_rate_limit_table.sql).
 */
export async function checkRateLimit(
  db: DBAdapter,
  key: string,         // e.g., "scan:1.2.3.4" or "probe:1.2.3.4"
  maxRequests: number, // e.g., 10
  windowMs: number,    // e.g., 60000 (1 minute)
): Promise<{ allowed: boolean; remaining: number; retryAfterMs?: number }> {
  const now = Date.now();
  const windowStart = new Date(now - windowMs).toISOString();

  // Count recent requests in window
  const count = await db.get<{ count: number }>(
    'SELECT COUNT(*) as count FROM rate_limit_log WHERE key = ? AND created_at > ?',
    key, windowStart,
  );

  const current = count?.count ?? 0;

  if (current >= maxRequests) {
    // Find oldest entry to calculate retry-after
    const oldest = await db.get<{ created_at: string }>(
      'SELECT created_at FROM rate_limit_log WHERE key = ? AND created_at > ? ORDER BY created_at ASC LIMIT 1',
      key, windowStart,
    );
    const retryAfterMs = oldest
      ? windowMs - (now - new Date(oldest.created_at).getTime())
      : windowMs;
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  // Log this request
  await db.run(
    'INSERT INTO rate_limit_log (id, key, created_at) VALUES (?, ?, ?)',
    crypto.randomUUID(), key, new Date().toISOString(),
  );

  // Cleanup old entries (lazy, only occasionally)
  if (Math.random() < 0.1) {
    const cutoff = new Date(now - windowMs * 2).toISOString();
    await db.run('DELETE FROM rate_limit_log WHERE created_at < ?', cutoff);
  }

  return { allowed: true, remaining: maxRequests - current - 1 };
}
