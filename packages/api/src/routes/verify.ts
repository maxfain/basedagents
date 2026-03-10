import { Hono } from 'hono';
import type { AppEnv, Agent, Verification } from '../types/index.js';
import { VerifySubmitSchema } from '../types/index.js';
import { agentAuth } from '../middleware/auth.js';
import { verifySignature } from '../crypto/index.js';
import type { DBAdapter } from '../db/adapter.js';

const verify = new Hono<AppEnv>();

/**
 * Calculate reputation score for an agent.
 */
async function calculateReputation(db: DBAdapter, agentId: string): Promise<number> {
  const received = await db.get<{ total: number; passes: number; avg_coherence: number | null }>(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN result = 'pass' THEN 1 ELSE 0 END) as passes,
       AVG(CASE WHEN coherence_score IS NOT NULL THEN coherence_score END) as avg_coherence
     FROM verifications WHERE target_id = ?`,
    agentId
  );

  const given = await db.get<{ total: number }>(
    'SELECT COUNT(*) as total FROM verifications WHERE verifier_id = ?',
    agentId
  );

  const uptimeData = await db.get<{ total: number; responsive: number }>(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN result != 'timeout' THEN 1 ELSE 0 END) as responsive
     FROM verifications WHERE target_id = ?`,
    agentId
  );

  const passRate = (received?.total ?? 0) > 0 ? (received?.passes ?? 0) / received!.total : 0;
  const avgCoherence = received?.avg_coherence ?? 0;
  const contribution = Math.min(1.0, (given?.total ?? 0) / 10);
  const uptime = (uptimeData?.total ?? 0) > 0 ? (uptimeData?.responsive ?? 0) / uptimeData!.total : 0;

  const rawScore = 0.4 * passRate + 0.3 * avgCoherence + 0.2 * contribution + 0.1 * uptime;
  const confidenceMultiplier = Math.log(1 + (received?.total ?? 0));

  return Math.round(rawScore * confidenceMultiplier * 100) / 100;
}

/**
 * Update an agent's status based on their reputation and verification history.
 */
async function updateAgentStatus(db: DBAdapter, agentId: string, newReputation: number): Promise<void> {
  const agent = await db.get<{ status: string }>('SELECT status FROM agents WHERE id = ?', agentId);
  if (!agent) return;

  let newStatus = agent.status;

  if (agent.status === 'pending') {
    const passCount = await db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM verifications WHERE target_id = ? AND result = 'pass'",
      agentId
    );
    if ((passCount?.count ?? 0) > 0) {
      newStatus = 'active';
    }
  } else if (agent.status === 'active') {
    if (newReputation < 1.0 && newReputation > 0) {
      const totalVerifications = await db.get<{ count: number }>(
        'SELECT COUNT(*) as count FROM verifications WHERE target_id = ?',
        agentId
      );
      if ((totalVerifications?.count ?? 0) >= 3) {
        newStatus = 'suspended';
      }
    }

    const recentResults = await db.all<{ result: string }>(
      'SELECT result FROM verifications WHERE target_id = ? ORDER BY created_at DESC LIMIT 5',
      agentId
    );

    if (recentResults.length >= 5 && recentResults.every((r) => r.result === 'timeout')) {
      newStatus = 'suspended';
    }
  } else if (agent.status === 'suspended') {
    const latest = await db.get<{ result: string }>(
      'SELECT result FROM verifications WHERE target_id = ? ORDER BY created_at DESC LIMIT 1',
      agentId
    );
    if (latest?.result === 'pass') {
      newStatus = 'active';
    }
  }

  if (newStatus !== agent.status) {
    await db.run('UPDATE agents SET status = ? WHERE id = ?', newStatus, agentId);
  }
}

/**
 * GET /v1/verify/assignment
 * Get a verification assignment for the authenticated agent.
 */
verify.get('/assignment', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const db = c.get('db');

  const activeCount = await db.get<{ count: number }>(
    "SELECT COUNT(*) as count FROM agents WHERE status = 'active'"
  );

  const target = await db.get<Pick<Agent, 'id' | 'name' | 'contact_endpoint' | 'capabilities'>>(
    `SELECT id, name, contact_endpoint, capabilities
     FROM agents
     WHERE id != ? AND status IN ('active', 'pending')
     ORDER BY RANDOM()
     LIMIT 1`,
    agentId
  );

  if (!target) {
    return c.json({
      error: 'no_assignment',
      message: 'No agents available for verification at this time',
    }, 404);
  }

  const assignmentId = crypto.randomUUID();
  const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  return c.json({
    assignment_id: assignmentId,
    target: {
      agent_id: target.id,
      name: target.name,
      contact_endpoint: target.contact_endpoint,
      capabilities: JSON.parse(target.capabilities),
    },
    deadline,
    bootstrap_mode: (activeCount?.count ?? 0) < 100,
    instructions: 'Contact the agent at its endpoint. Send a simple capability probe. Report results.',
  });
});

/**
 * POST /v1/verify/submit
 * Submit verification results.
 */
verify.post('/submit', agentAuth, async (c) => {
  const verifierId = c.get('agentId') as string;

  let body: unknown;
  try {
    const rawBody = await c.req.text();
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  }

  const parsed = VerifySubmitSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'bad_request',
      message: 'Validation failed',
      details: parsed.error.flatten(),
    }, 400);
  }

  const { assignment_id, target_id, result, response_time_ms, coherence_score, notes, signature } = parsed.data;
  const db = c.get('db');

  // Verify target exists
  const target = await db.get<{ id: string; status: string }>('SELECT id, status FROM agents WHERE id = ?', target_id);
  if (!target) {
    return c.json({ error: 'not_found', message: 'Target agent not found' }, 404);
  }

  if (verifierId === target_id) {
    return c.json({ error: 'bad_request', message: 'Cannot verify yourself' }, 400);
  }

  // Verify the signature over the report content
  const reportData = JSON.stringify({
    assignment_id,
    target_id,
    result,
    response_time_ms,
    coherence_score,
    notes,
  });

  let sigBytes: Uint8Array;
  try {
    const binaryStr = atob(signature);
    sigBytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      sigBytes[i] = binaryStr.charCodeAt(i);
    }
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid base64 signature on report' }, 400);
  }

  const verifierPubKey = c.get('publicKey') as Uint8Array;
  const reportBytes = new TextEncoder().encode(reportData);
  const sigValid = await verifySignature(reportBytes, sigBytes, verifierPubKey);
  if (!sigValid) {
    return c.json({ error: 'bad_request', message: 'Invalid report signature' }, 400);
  }

  // Store the verification
  const verificationId = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.run(
    `INSERT INTO verifications (id, verifier_id, target_id, result, response_time_ms, coherence_score, notes, signature, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    verificationId,
    verifierId,
    target_id,
    result,
    response_time_ms ?? null,
    coherence_score ?? null,
    notes ?? null,
    signature,
    now
  );

  // Update verification counts
  await db.run(
    'UPDATE agents SET verification_count = verification_count + 1 WHERE id = ?',
    target_id
  );

  // Update last_seen for verifier
  await db.run(
    'UPDATE agents SET last_seen = ? WHERE id = ?',
    now, verifierId
  );

  // Recalculate reputation for both target and verifier
  const targetReputation = await calculateReputation(db, target_id);
  const verifierReputation = await calculateReputation(db, verifierId);

  // Get previous reputations for delta calculation
  const targetAgent = await db.get<{ reputation_score: number }>('SELECT reputation_score FROM agents WHERE id = ?', target_id);
  const verifierAgent = await db.get<{ reputation_score: number }>('SELECT reputation_score FROM agents WHERE id = ?', verifierId);

  const targetDelta = Math.round((targetReputation - (targetAgent?.reputation_score ?? 0)) * 100) / 100;
  const verifierDelta = Math.round((verifierReputation - (verifierAgent?.reputation_score ?? 0)) * 100) / 100;

  // Update reputation scores
  await db.run('UPDATE agents SET reputation_score = ? WHERE id = ?', targetReputation, target_id);
  await db.run('UPDATE agents SET reputation_score = ? WHERE id = ?', verifierReputation, verifierId);

  // Update status lifecycle for both agents
  await updateAgentStatus(db, target_id, targetReputation);
  await updateAgentStatus(db, verifierId, verifierReputation);

  return c.json({
    ok: true,
    verification_id: verificationId,
    verifier_reputation_delta: verifierDelta,
    target_reputation_delta: targetDelta,
  });
});

export default verify;
