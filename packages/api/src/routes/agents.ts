import { Hono } from 'hono';
import type { AppEnv, Agent, Verification } from '../types/index.js';
import { ProfileSchema } from '../types/index.js';
import { agentAuth } from '../middleware/auth.js';
import { computeReputation } from '../reputation/calculator.js';

const agents = new Hono<AppEnv>();

/**
 * Format an agent row for API response (parse JSON fields).
 */
function formatAgent(agent: Agent) {
  return {
    agent_id: agent.id,
    name: agent.name,
    description: agent.description,
    capabilities: JSON.parse(agent.capabilities),
    protocols: JSON.parse(agent.protocols),
    offers: agent.offers ? JSON.parse(agent.offers) : [],
    needs: agent.needs ? JSON.parse(agent.needs) : [],
    homepage: agent.homepage,
    contact_endpoint: agent.contact_endpoint,
    comment: agent.comment ?? null,
    organization: agent.organization ?? null,
    organization_url: agent.organization_url ?? null,
    logo_url: agent.logo_url ?? null,
    tags: agent.tags ? JSON.parse(agent.tags) : [],
    version: agent.version ?? null,
    contact_email: agent.contact_email ?? null,
    skills: agent.skills ? JSON.parse(agent.skills) : [],
    status: agent.status,
    reputation_score: agent.reputation_score,
    verification_count: agent.verification_count,
    registered_at: agent.registered_at,
    last_seen: agent.last_seen,
  };
}

/**
 * GET /v1/agents/search
 * Search/filter agents by capabilities, protocols, offers, needs.
 * Full-text search on name + description. Paginated.
 */
agents.get('/search', async (c) => {
  const db = c.get('db');

  const q = c.req.query('q');
  const capabilities = c.req.query('capabilities');
  const protocols = c.req.query('protocols');
  const offers = c.req.query('offers');
  const needs = c.req.query('needs');
  const status = c.req.query('status') || 'active';
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
  const sort = c.req.query('sort') || 'reputation';
  const offset = (page - 1) * limit;

  // Escape SQL LIKE wildcards to prevent pattern injection
  // SQLite LIKE escape character: backslash
  function escapeLike(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  }

  // Build dynamic query
  const conditions: string[] = ['status = ?'];
  const params: unknown[] = [status];

  if (q) {
    const safe = escapeLike(q);
    conditions.push('(name LIKE ? ESCAPE \'\\\' OR description LIKE ? ESCAPE \'\\\')');
    params.push(`%${safe}%`, `%${safe}%`);
  }

  if (capabilities) {
    for (const cap of capabilities.split(',')) {
      conditions.push('capabilities LIKE ? ESCAPE \'\\\'');
      params.push(`%"${escapeLike(cap.trim())}"%`);
    }
  }

  if (protocols) {
    for (const proto of protocols.split(',')) {
      conditions.push('protocols LIKE ? ESCAPE \'\\\'');
      params.push(`%"${escapeLike(proto.trim())}"%`);
    }
  }

  if (offers) {
    for (const offer of offers.split(',')) {
      conditions.push('offers LIKE ? ESCAPE \'\\\'');
      params.push(`%"${escapeLike(offer.trim())}"%`);
    }
  }

  if (needs) {
    for (const need of needs.split(',')) {
      conditions.push('needs LIKE ? ESCAPE \'\\\'');
      params.push(`%"${escapeLike(need.trim())}"%`);
    }
  }

  const whereClause = conditions.join(' AND ');
  const orderBy = sort === 'registered_at'
    ? 'registered_at DESC'
    : 'reputation_score DESC';

  // Get total count
  const countRow = await db.get<{ count: number }>(
    `SELECT COUNT(*) as count FROM agents WHERE ${whereClause}`,
    ...params
  );

  // Get paginated results
  const rows = await db.all<Agent>(
    `SELECT * FROM agents WHERE ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    ...params, limit, offset
  );

  return c.json({
    agents: rows.map(formatAgent),
    pagination: {
      page,
      limit,
      total: countRow?.count ?? 0,
      total_pages: Math.ceil((countRow?.count ?? 0) / limit),
    },
  });
});

/**
 * GET /v1/agents/:id
 * Get an agent's public profile + reputation.
 */
agents.get('/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.get('db');

  const agent = await db.get<Agent>('SELECT * FROM agents WHERE id = ?', id);

  if (!agent) {
    return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  }

  // Get recent verifications (last 10 where this agent was the target)
  const recentVerifications = await db.all<Pick<Verification, 'verifier_id' | 'result' | 'coherence_score' | 'created_at'>>(
    `SELECT verifier_id, result, coherence_score, created_at
     FROM verifications
     WHERE target_id = ?
     ORDER BY created_at DESC
     LIMIT 10`,
    id
  );

  return c.json({
    ...formatAgent(agent),
    recent_verifications: recentVerifications.map((v) => ({
      verifier: v.verifier_id,
      result: v.result,
      coherence_score: v.coherence_score,
      date: v.created_at,
    })),
  });
});

/**
 * PUT /v1/agents/:id
 * Update an agent's profile (requires AgentSig auth, owner only).
 */
agents.put('/:id', agentAuth, async (c) => {
  const id = c.req.param('id');
  const authenticatedAgentId = c.get('agentId') as string;

  // Owner check
  if (id !== authenticatedAgentId) {
    return c.json({ error: 'forbidden', message: 'You can only update your own profile' }, 403);
  }

  let body: unknown;
  try {
    const rawBody = await c.req.text();
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  }

  const profileUpdate = ProfileSchema.partial().safeParse(body);
  if (!profileUpdate.success) {
    return c.json({
      error: 'bad_request',
      message: 'Validation failed',
      details: profileUpdate.error.flatten(),
    }, 400);
  }

  const db = c.get('db');
  const updates = profileUpdate.data;

  // Build dynamic UPDATE query
  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (updates.name !== undefined) {
    setClauses.push('name = ?');
    params.push(updates.name);
  }
  if (updates.description !== undefined) {
    setClauses.push('description = ?');
    params.push(updates.description);
  }
  if (updates.capabilities !== undefined) {
    setClauses.push('capabilities = ?');
    params.push(JSON.stringify(updates.capabilities));
  }
  if (updates.protocols !== undefined) {
    setClauses.push('protocols = ?');
    params.push(JSON.stringify(updates.protocols));
  }
  if (updates.offers !== undefined) {
    setClauses.push('offers = ?');
    params.push(JSON.stringify(updates.offers));
  }
  if (updates.needs !== undefined) {
    setClauses.push('needs = ?');
    params.push(JSON.stringify(updates.needs));
  }
  if (updates.homepage !== undefined) {
    setClauses.push('homepage = ?');
    params.push(updates.homepage);
  }
  if (updates.contact_endpoint !== undefined) {
    setClauses.push('contact_endpoint = ?');
    params.push(updates.contact_endpoint);
  }

  if (setClauses.length === 0) {
    return c.json({ error: 'bad_request', message: 'No fields to update' }, 400);
  }

  setClauses.push('last_seen = ?');
  params.push(new Date().toISOString());
  params.push(id);

  await db.run(
    `UPDATE agents SET ${setClauses.join(', ')} WHERE id = ?`,
    ...params
  );

  // Return updated agent
  const agent = await db.get<Agent>('SELECT * FROM agents WHERE id = ?', id);
  return c.json(formatAgent(agent!));
});

/**
 * GET /v1/agents/:id/reputation
 * Detailed reputation breakdown.
 */
agents.get('/:id/reputation', async (c) => {
  const id = c.req.param('id');
  const db = c.get('db');

  const agentExists = await db.get<{ id: string }>('SELECT id FROM agents WHERE id = ?', id);
  if (!agentExists) {
    return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  }

  const rep = await computeReputation(id, db);

  // Also update stored reputation_score
  await db.run(
    'UPDATE agents SET reputation_score = ? WHERE id = ?',
    rep.final_score, id
  );

  return c.json({
    agent_id: id,
    reputation_score: rep.final_score,
    breakdown: rep.components,
    penalty: rep.penalty,
    safety_flags: rep.safety_flags,
    weights: rep.weights,
    raw_score: rep.raw_score,
    confidence: rep.confidence,
    verifications_received: rep.verifications_received,
    verifications_given: rep.verifications_given,
  });
});

export default agents;
