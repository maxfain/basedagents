import { createMiddleware } from 'hono/factory';

/**
 * @deprecated HIGH-1: In-memory rate limiters are ineffective on Cloudflare Workers because
 * each isolate has its own memory — limits don't survive across requests.
 * Use the D1-based rate limiter at src/lib/rate-limiter.ts instead.
 *
 * This middleware is kept for reference but should not be used in production.
 */
export const rateLimit = (opts: { windowMs: number; max: number }) => {
  const { windowMs, max } = opts;
  const hits = new Map<string, number[]>();

  // Periodic cleanup every 60 seconds (note: setInterval is unreliable in CF Workers)
  try {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [key, timestamps] of hits) {
        const filtered = timestamps.filter((t) => now - t < windowMs);
        if (filtered.length === 0) {
          hits.delete(key);
        } else {
          hits.set(key, filtered);
        }
      }
    }, 60_000);
    // Node.js: allow process to exit even if timer is pending
    if (timer && typeof (timer as NodeJS.Timeout).unref === 'function') {
      (timer as NodeJS.Timeout).unref();
    }
  } catch {
    // setInterval may not be available in all runtimes
  }

  return createMiddleware(async (c, next) => {
    // Use IP + path prefix as the rate limit key
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      || c.req.header('x-real-ip')
      || 'unknown';
    const key = `${ip}`;
    const now = Date.now();

    const timestamps = hits.get(key) || [];
    // Filter to current window
    const windowTimestamps = timestamps.filter((t) => now - t < windowMs);

    if (windowTimestamps.length >= max) {
      const retryAfter = Math.ceil((windowTimestamps[0] + windowMs - now) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json(
        { error: 'rate_limited', message: `Too many requests. Retry after ${retryAfter}s` },
        429
      );
    }

    windowTimestamps.push(now);
    hits.set(key, windowTimestamps);

    await next();
  });
};
