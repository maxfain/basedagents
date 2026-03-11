import { Hono } from 'hono';
import type { AppEnv, Agent, Verification } from '../types/index.js';
import { ProfileSchema } from '../types/index.js';
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

  // Build dynamic query
  const conditions: string[] = ['status = ?'];
  const params: unknown[] = [status];

  if (q) {
    conditions.push('(name LIKE ? OR description LIKE ?)');
    const pattern = `%${q}%`;
    params.push(pattern, pattern);
  }

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

  const agent = await db.get<Agent>('SELECT * FROM agents WHERE id = ?', id);
  if (!agent) {
    return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  }

  // Verifications received (as target)
  const received = await db.get<{ total: number; passes: number; avg_coherence: number | null }>(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN result = 'pass' THEN 1 ELSE 0 END) as passes,
       AVG(CASE WHEN coherence_score IS NOT NULL THEN coherence_score END) as avg_coherence
     FROM verifications WHERE target_id = ?`,
    id
  );

  // Verifications given (as verifier)
  const given = await db.get<{ total: number }>(
    'SELECT COUNT(*) as total FROM verifications WHERE verifier_id = ?',
    id
  );

  // Uptime
  const uptimeData = await db.get<{ total: number; responsive: number }>(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN result != 'timeout' THEN 1 ELSE 0 END) as responsive
     FROM verifications WHERE target_id = ?`,
    id
  );

  const n = received?.total ?? 0;
  const passRate = n > 0 ? (received?.passes ?? 0) / n : 0;
  const avgCoherence = received?.avg_coherence ?? 0;
  const contribution = Math.min(1.0, (given?.total ?? 0) / 10);
  const uptime = (uptimeData?.total ?? 0) > 0 ? (uptimeData?.responsive ?? 0) / uptimeData!.total : 0;

  // Skill trust: average trust_score of agent's resolved skills (0 if none declared)
  const skillRows = await db.all<{ trust_score: number }>(
    `SELECT sc.trust_score
     FROM skill_cache sc
     WHERE sc.id IN (
       SELECT json_each.value
       FROM agents, json_each(
         json_group_array(json_extract(json_each.value, '$.registry') || ':' || json_extract(json_each.value, '$.name'))
       )
       WHERE id = ?
     )`,
    id
  );
  // Simpler fallback: parse skills from agent row directly
  const agentRow = await db.get<{ skills: string | null }>('SELECT skills FROM agents WHERE id = ?', id);
  let skillTrust = 0;
  if (agentRow?.skills) {
    try {
      const declared: Array<{ name: string; registry?: string; private?: boolean }> = JSON.parse(agentRow.skills);
      if (declared.length > 0) {
        const resolved = await Promise.all(declared.map(async s => {
          const cacheId = `${s.registry ?? 'npm'}:${s.name}`;
          if (s.private) return 0.5;
          const row = await db.get<{ trust_score: number }>('SELECT trust_score FROM skill_cache WHERE id = ?', cacheId);
          return row?.trust_score ?? 0.0;
        }));
        skillTrust = resolved.reduce((a, b) => a + b, 0) / resolved.length;
      }
    } catch { /* malformed skills, skip */ }
  }

  // Profile completeness base score (max 0.05)
  const profileBase = agentRow?.skills ? 0.05 : 0;

  // Weighted raw score (bounded [0,1] by construction)
  // Weights: pass_rate 0.35, coherence 0.25, contribution 0.15, uptime 0.10, skill_trust 0.15
  const rawScore = (
    0.35 * passRate +
    0.25 * avgCoherence +
    0.15 * contribution +
    0.10 * uptime +
    0.15 * skillTrust
  );

  // Confidence multiplier: normalized so 20 verifications = full weight
  // min(1, log(1+n) / log(21)) — bounded [0,1]
  const confidenceMultiplier = n === 0 ? 0 : Math.min(1.0, Math.log(1 + n) / Math.log(21));

  // Final score: raw * confidence + profile_base, capped at 1.0
  const finalScore = Math.min(1.0, rawScore * confidenceMultiplier + profileBase);

  return c.json({
    agent_id: id,
    reputation_score: Math.round(finalScore * 100) / 100,
    breakdown: {
      pass_rate: Math.round(passRate * 1000) / 1000,
      avg_coherence: Math.round(avgCoherence * 1000) / 1000,
      contribution: Math.round(contribution * 1000) / 1000,
      uptime: Math.round(uptime * 1000) / 1000,
      skill_trust: Math.round(skillTrust * 1000) / 1000,
      profile_base: profileBase,
    },
    weights: {
      pass_rate: 0.35,
      avg_coherence: 0.25,
      contribution: 0.15,
      uptime: 0.10,
      skill_trust: 0.15,
    },
    raw_score: Math.round(rawScore * 1000) / 1000,
    confidence_multiplier: Math.round(confidenceMultiplier * 1000) / 1000,
    verifications_received: n,
    verifications_given: given?.total ?? 0,
  });
});

export default agents;
