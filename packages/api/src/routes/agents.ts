import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv, Agent, Verification } from '../types/index.js';
import { ProfileSchema } from '../types/index.js';
import { agentAuth } from '../middleware/auth.js';
import { computeReputation } from '../reputation/calculator.js';
import { hashProfile, computeChainHash, GENESIS_HASH } from '../crypto/index.js';

const agents = new Hono<AppEnv>();

/**
 * Obfuscate an email address for public API responses.
 * The full address is never returned — only a masked version to protect
 * against scraping while still confirming one was registered.
 *
 * hansl@agentmail.com  →  h***l@a******l.com
 * a@b.io               →  a@b.io  (too short to mask, leave as-is)
 */
function obfuscateEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return email;

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dotIdx = domain.lastIndexOf('.');
  if (dotIdx < 1) return email;

  const domainName = domain.slice(0, dotIdx);
  const tld = domain.slice(dotIdx); // e.g. ".com"

  const maskLocal = local.length <= 2
    ? local
    : local[0] + '*'.repeat(local.length - 2) + local[local.length - 1];

  const maskDomain = domainName.length <= 2
    ? domainName
    : domainName[0] + '*'.repeat(domainName.length - 2) + domainName[domainName.length - 1];

  return `${maskLocal}@${maskDomain}${tld}`;
}

/**
 * Format an agent row for public API responses.
 * Sensitive fields (contact_email) are obfuscated — never returned in full.
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
    contact_email: agent.contact_email ? obfuscateEmail(agent.contact_email) : null,
    skills: agent.skills ? JSON.parse(agent.skills) : [],
    status: agent.status,
    reputation_score: agent.reputation_score,
    verification_count: agent.verification_count,
    profile_version: (agent as Agent & { profile_version?: number }).profile_version ?? 1,
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
 * PATCH /v1/agents/:id/profile
 * Partially update an agent's profile (AgentSig auth, owner only).
 * Also aliased at PUT /v1/agents/:id for backwards compat.
 */
async function handleProfileUpdate(c: Context<AppEnv>): Promise<Response> {
  const id = c.req.param('id');
  const authenticatedAgentId = c.get('agentId') as string;

  if (id !== authenticatedAgentId) {
    return c.json({ error: 'forbidden', message: 'You can only update your own profile' }, 403);
  }

  let body: unknown;
  try { body = JSON.parse(await c.req.text()); }
  catch { return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400); }

  const parsed = ProfileSchema.partial().safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const db = c.get('db');
  const updates = parsed.data;
  const setClauses: string[] = [];
  const params: unknown[] = [];

  const jsonFields = ['capabilities', 'protocols', 'offers', 'needs', 'tags', 'skills'] as const;
  const textFields = ['name', 'description', 'homepage', 'contact_endpoint', 'comment',
                      'organization', 'organization_url', 'logo_url', 'version', 'contact_email'] as const;

  for (const field of textFields) {
    if (updates[field] !== undefined) {
      setClauses.push(`${field} = ?`);
      params.push(updates[field]);
    }
  }
  for (const field of jsonFields) {
    if (updates[field] !== undefined) {
      setClauses.push(`${field} = ?`);
      params.push(JSON.stringify(updates[field]));
    }
  }

  if (setClauses.length === 0) {
    return c.json({ error: 'bad_request', message: 'No fields to update' }, 400);
  }

  // Name uniqueness check (case-insensitive) — only when name is being changed
  if (updates.name !== undefined) {
    const nameTaken = await db.get<{ id: string }>(
      'SELECT id FROM agents WHERE name = ? COLLATE NOCASE AND id != ?',
      updates.name, id
    );
    if (nameTaken) {
      return c.json({ error: 'conflict', message: `Agent name '${updates.name}' is already taken` }, 409);
    }
  }

  const now = new Date().toISOString();
  setClauses.push('last_seen = ?');
  params.push(now);

  // If contact_endpoint is being set, reset probe tracking so bootstrap prober retries
  if (updates.contact_endpoint !== undefined) {
    setClauses.push('probe_attempts = ?', 'last_probe_result = ?');
    params.push(0, null);
  }

  // Bump profile_version
  setClauses.push('profile_version = profile_version + 1');

  params.push(id);
  await db.run(`UPDATE agents SET ${setClauses.join(', ')} WHERE id = ?`, ...params);

  // Write a chain entry for the update (no PoW required — ownership proven via AgentSig)
  const updatedAgent = await db.get<Agent>('SELECT * FROM agents WHERE id = ?', id);
  const profileSnapshot = {
    name: updatedAgent!.name,
    description: updatedAgent!.description,
    capabilities: JSON.parse(updatedAgent!.capabilities ?? '[]'),
    protocols: JSON.parse(updatedAgent!.protocols ?? '[]'),
    version: updatedAgent!.version,
    organization: updatedAgent!.organization,
    skills: updatedAgent!.skills ? JSON.parse(updatedAgent!.skills) : [],
  };
  const profileHash = hashProfile(profileSnapshot as Record<string, unknown>);
  const latestEntry = await db.get<{ entry_hash: string }>(
    'SELECT entry_hash FROM chain ORDER BY sequence DESC LIMIT 1'
  );
  const previousHash = latestEntry?.entry_hash ?? GENESIS_HASH;
  const pubKeyRaw = updatedAgent!.public_key;
  const pubKeyBytes = pubKeyRaw instanceof Uint8Array
    ? pubKeyRaw
    : new Uint8Array(Object.values(pubKeyRaw as Record<string, number>));
  const entryHash = computeChainHash(previousHash, pubKeyBytes, '', profileHash, now);

  await db.run(
    `INSERT INTO chain (entry_hash, previous_hash, agent_id, public_key, nonce, profile_hash, timestamp, entry_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'update')`,
    entryHash, previousHash, id, updatedAgent!.public_key, '', profileHash, now
  );

  return c.json(formatAgent(updatedAgent!));
}

agents.patch('/:id/profile', agentAuth, (c) => handleProfileUpdate(c as Context<AppEnv>));
agents.put('/:id', agentAuth, (c) => handleProfileUpdate(c as Context<AppEnv>));

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
