import { Hono } from 'hono';
import type { Bindings } from '../types/index.js';

const agents = new Hono<{ Bindings: Bindings }>();

/**
 * GET /v1/agents/search
 * Search/filter agents by capabilities, protocols, offers, needs.
 */
agents.get('/search', async (c) => {
  // TODO: Implement — backend agent
  return c.json(
    { error: 'not_implemented', message: 'GET /v1/agents/search not yet implemented' },
    501
  );
});

/**
 * GET /v1/agents/:id
 * Get an agent's public profile + reputation.
 */
agents.get('/:id', async (c) => {
  const _id = c.req.param('id');
  // TODO: Implement — backend agent
  return c.json(
    { error: 'not_implemented', message: 'GET /v1/agents/:id not yet implemented' },
    501
  );
});

/**
 * PUT /v1/agents/:id
 * Update an agent's profile (requires AgentSig auth).
 */
agents.put('/:id', async (c) => {
  const _id = c.req.param('id');
  // TODO: Implement — backend agent
  return c.json(
    { error: 'not_implemented', message: 'PUT /v1/agents/:id not yet implemented' },
    501
  );
});

/**
 * GET /v1/agents/:id/reputation
 * Detailed reputation breakdown.
 */
agents.get('/:id/reputation', async (c) => {
  const _id = c.req.param('id');
  // TODO: Implement — backend agent
  return c.json(
    { error: 'not_implemented', message: 'GET /v1/agents/:id/reputation not yet implemented' },
    501
  );
});

export default agents;
