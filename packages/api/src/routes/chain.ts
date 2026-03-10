import { Hono } from 'hono';
import type { Bindings } from '../types/index.js';

const chain = new Hono<{ Bindings: Bindings }>();

/**
 * GET /v1/chain/latest
 * Returns the latest chain entry hash + sequence number.
 */
chain.get('/latest', async (c) => {
  // TODO: Implement — backend agent
  return c.json(
    { error: 'not_implemented', message: 'GET /v1/chain/latest not yet implemented' },
    501
  );
});

/**
 * GET /v1/chain/:sequence
 * Returns a specific chain entry by sequence number.
 */
chain.get('/:sequence', async (c) => {
  const _seq = c.req.param('sequence');
  // TODO: Implement — backend agent
  return c.json(
    { error: 'not_implemented', message: 'GET /v1/chain/:sequence not yet implemented' },
    501
  );
});

export default chain;
