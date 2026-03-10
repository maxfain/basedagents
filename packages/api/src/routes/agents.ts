import { Hono } from 'hono';
import type { AppEnv, Agent, Verification } from '../types/index.js';
import { ProfileSchema } from '../types/index.js';
import { getDatabase } from '../db/index.js';
import { agentAuth } from '../middleware/auth.js';

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
 *
 * Query params:
 *   q — free text search on name + description
 *   capabilities — comma-separated capabilities to filter by
 *   protocols — comma-separated protocols to filter by
 *   offers — comma-separated offers to filter by
 *   needs — comma-separated needs to filter by
 *   status — filter by status (default: active)
 *   page — page number (default: 1)
 *   limit — results per page (default: 20, max: 100)
 *   sort — sort field: reputation, registered_at (default: reputation)
 */
agents.get('/search', async (c) => {
  const db = getDatabase();

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

  // Build dynamic query
  const conditions: string[] = ['status = ?'];
  const params: unknown[] = [status];

  // Free text search on name + description
  if (q) {
    conditions.push('(name LIKE ? OR description LIKE ?)');
    const pattern = `%${q}%`;
    params.push(pattern, pattern);
  }

  // JSON array field search — check if the stored JSON array contains the value
  if (capabilities) {
    for (const cap of capabilities.split(',')) {
      conditions.push("capabilities LIKE ?");
      params.push(`%"${cap.trim()}"%`);
    }
  }

  if (protocols) {
    for (const proto of protocols.split(',')) {
      conditions.push("protocols LIKE ?");
      params.push(`%"${proto.trim()}"%`);
    }
  }

  if (offers) {
    for (const offer of offers.split(',')) {
      conditions.push("offers LIKE ?");
      params.push(`%"${offer.trim()}"%`);
    }
  }

  if (needs) {
    for (const need of needs.split(',')) {
      conditions.push("needs LIKE ?");
      params.push(`%"${need.trim()}"%`);
    }
  }

  const whereClause = conditions.join(' AND ');
  const orderBy = sort === 'registered_at'
    ? 'registered_at DESC'
    : 'reputation_score DESC';

  // Get total count
  const countRow = db.prepare(
    `SELECT COUNT(*) as count FROM agents WHERE ${whereClause}`
  ).get(...params) as { count: number };

  // Get paginated results
  const rows = db.prepare(
    `SELECT * FROM agents WHERE ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as Agent[];

  return c.json({
    agents: rows.map(formatAgent),
    pagination: {
      page,
      limit,
      total: countRow.count,
      total_pages: Math.ceil(countRow.count / limit),
    },
  });
});

/**
 * GET /v1/agents/:id
 * Get an agent's public profile + reputation.
 */
agents.get('/:id', async (c) => {
  const id = c.req.param('id');
  const db = getDatabase();

  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent | undefined;

  if (!agent) {
    return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  }

  // Get recent verifications (last 10 where this agent was the target)
  const recentVerifications = db.prepare(
    `SELECT verifier_id, result, coherence_score, created_at
     FROM verifications
     WHERE target_id = ?
     ORDER BY created_at DESC
     LIMIT 10`
  ).all(id) as Pick<Verification, 'verifier_id' | 'result' | 'coherence_score' | 'created_at'>[];

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

  // Parse body — note: agentAuth already consumed the body via c.req.text(),
  // so we need to handle this. We'll re-parse from the raw text.
  // Actually, Hono caches the body, so let's try json parsing.
  let body: unknown;
  try {
    // The body was already read by auth middleware, but Hono may cache it.
    // We need to get the raw text that auth already read and parse it.
    const rawBody = await c.req.text();
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  }

  // Validate profile fields (partial update — allow subset of profile fields)
  const profileUpdate = ProfileSchema.partial().safeParse(body);
  if (!profileUpdate.success) {
    return c.json({
      error: 'bad_request',
      message: 'Validation failed',
      details: profileUpdate.error.flatten(),
    }, 400);
  }

  const db = getDatabase();
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

  // Also update last_seen
  setClauses.push('last_seen = ?');
  params.push(new Date().toISOString());
  params.push(id);

  db.prepare(
    `UPDATE agents SET ${setClauses.join(', ')} WHERE id = ?`
  ).run(...params);

  // Return updated agent
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent;
  return c.json(formatAgent(agent));
});

/**
 * GET /v1/agents/:id/reputation
 * Detailed reputation breakdown.
 */
agents.get('/:id/reputation', async (c) => {
  const id = c.req.param('id');
  const db = getDatabase();

  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent | undefined;
  if (!agent) {
    return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  }

  // Compute detailed reputation breakdown
  // Verifications received (as target)
  const received = db.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN result = 'pass' THEN 1 ELSE 0 END) as passes,
       AVG(CASE WHEN coherence_score IS NOT NULL THEN coherence_score END) as avg_coherence
     FROM verifications WHERE target_id = ?`
  ).get(id) as { total: number; passes: number; avg_coherence: number | null };

  // Verifications given (as verifier) — contribution score
  const given = db.prepare(
    'SELECT COUNT(*) as total FROM verifications WHERE verifier_id = ?'
  ).get(id) as { total: number };

  // Uptime: ratio of non-timeout results when this agent was target
  const uptimeData = db.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN result != 'timeout' THEN 1 ELSE 0 END) as responsive
     FROM verifications WHERE target_id = ?`
  ).get(id) as { total: number; responsive: number };

  const passRate = received.total > 0 ? received.passes / received.total : 0;
  const avgCoherence = received.avg_coherence ?? 0;
  // Contribution: normalized — cap at 1.0 (10+ verifications given = max contribution)
  const contribution = Math.min(1.0, given.total / 10);
  const uptime = uptimeData.total > 0 ? uptimeData.responsive / uptimeData.total : 0;

  const rawScore = 0.4 * passRate + 0.3 * avgCoherence + 0.2 * contribution + 0.1 * uptime;
  const confidenceMultiplier = Math.log(1 + received.total);
  const finalScore = rawScore * confidenceMultiplier;

  return c.json({
    agent_id: id,
    reputation_score: Math.round(finalScore * 100) / 100,
    breakdown: {
      pass_rate: Math.round(passRate * 1000) / 1000,
      avg_coherence: Math.round(avgCoherence * 1000) / 1000,
      contribution: Math.round(contribution * 1000) / 1000,
      uptime: Math.round(uptime * 1000) / 1000,
    },
    weights: {
      pass_rate: 0.4,
      avg_coherence: 0.3,
      contribution: 0.2,
      uptime: 0.1,
    },
    raw_score: Math.round(rawScore * 1000) / 1000,
    confidence_multiplier: Math.round(confidenceMultiplier * 1000) / 1000,
    verifications_received: received.total,
    verifications_given: given.total,
  });
});

export default agents;
