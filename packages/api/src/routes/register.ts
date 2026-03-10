import { Hono } from 'hono';
import type { Bindings } from '../types/index.js';

const register = new Hono<{ Bindings: Bindings }>();

/**
 * POST /v1/register/init
 * Agent sends its public key. Registry returns a challenge + current difficulty.
 */
register.post('/init', async (c) => {
  // TODO: Implement — backend agent
  return c.json(
    { error: 'not_implemented', message: 'POST /v1/register/init not yet implemented' },
    501
  );
});

/**
 * POST /v1/register/complete
 * Agent submits proof-of-work nonce, signed challenge, and profile.
 */
register.post('/complete', async (c) => {
  // TODO: Implement — backend agent
  return c.json(
    { error: 'not_implemented', message: 'POST /v1/register/complete not yet implemented' },
    501
  );
});

export default register;
