import { Hono } from 'hono';
import type { AppEnv } from '../types/index.js';
import { resolveSkill, resolveAgentSkills } from '../skills/resolver.js';

const skills = new Hono<AppEnv>();

/**
 * GET /v1/skills/:registry/:name
 * Look up a skill by registry and name. Returns cached or freshly resolved metadata.
 */
skills.get('/:registry/:name', async (c) => {
  const registry = c.req.param('registry');
  const name = c.req.param('name');

  const validRegistries = ['npm', 'clawhub', 'pypi'];
  if (!validRegistries.includes(registry)) {
    return c.json({ error: 'bad_request', message: `Unknown registry "${registry}". Valid: ${validRegistries.join(', ')}` }, 400);
  }

  const db = c.get('db');
  if (!db) return c.json({ error: 'db_unavailable', message: 'Database not available' }, 503);

  const resolved = await resolveSkill({ name, registry: registry as 'npm' | 'clawhub' | 'pypi' }, db);
  return c.json(resolved);
});

/**
 * GET /v1/skills/agent/:agentId
 * Returns fully resolved skills for an agent, with trust scores.
 */
skills.get('/agent/:agentId', async (c) => {
  const agentId = c.req.param('agentId');
  const db = c.get('db');
  if (!db) return c.json({ error: 'db_unavailable', message: 'Database not available' }, 503);

  const agent = await db.get<{ skills: string | null }>(
    'SELECT skills FROM agents WHERE id = ?', agentId
  );

  if (!agent) return c.json({ error: 'not_found', message: 'Agent not found' }, 404);

  const declared = agent.skills ? JSON.parse(agent.skills) : [];
  const { resolved, aggregate_trust } = await resolveAgentSkills(declared, db);

  return c.json({
    agent_id: agentId,
    skills: resolved,
    aggregate_trust,
    skill_count: resolved.length,
    verified_count: resolved.filter(s => s.verified).length,
    unverified_count: resolved.filter(s => !s.verified && !s.private).length,
    private_count: resolved.filter(s => s.private).length,
  });
});

export default skills;
