import { createMiddleware } from 'hono/factory';

/**
 * Simple in-memory rate limiter.
 * TODO: Replace with a distributed solution for production.
 */
export const rateLimit = (opts: { windowMs: number; max: number }) => {
  const _opts = opts; // Will be used in implementation

  return createMiddleware(async (c, next) => {
    // TODO: Implement rate limiting — backend agent
    // For now, pass through
    void _opts;
    await next();
  });
};
