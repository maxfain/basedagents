import { Hono } from 'hono';
import type { Bindings } from '../types/index.js';

const verify = new Hono<{ Bindings: Bindings }>();

/**
 * GET /v1/verify/assignment
 * Get a verification assignment for the authenticated agent.
 */
verify.get('/assignment', async (c) => {
  // TODO: Implement — backend agent
  return c.json(
    { error: 'not_implemented', message: 'GET /v1/verify/assignment not yet implemented' },
    501
  );
});

/**
 * POST /v1/verify/submit
 * Submit verification results.
 */
verify.post('/submit', async (c) => {
  // TODO: Implement — backend agent
  return c.json(
    { error: 'not_implemented', message: 'POST /v1/verify/submit not yet implemented' },
    501
  );
});

export default verify;
