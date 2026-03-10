import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import type { AppEnv, Agent, Verification } from '../types/index.js';
import { VerifySubmitSchema } from '../types/index.js';
import { getDatabase } from '../db/index.js';
import { agentAuth } from '../middleware/auth.js';
import { verifySignature, base58Decode } from '../crypto/index.js';

const verify = new Hono<AppEnv>();

/**
 * Calculate reputation score for an agent.
 *
 * Formula:
 *   rawScore = 0.4 * pass_rate + 0.3 * avg_coherence + 0.2 * contribution + 0.1 * uptime
 *   reputation = rawScore * log(1 + total_verifications_received)
 */
function calculateReputation(db: ReturnType<typeof getDatabase>, agentId: string): number {
  // Verifications received (as target)
  const received = db.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN result = 'pass' THEN 1 ELSE 0 END) as passes,
       AVG(CASE WHEN coherence_score IS NOT NULL THEN coherence_score END) as avg_coherence
     FROM verifications WHERE target_id = ?`
  ).get(agentId) as { total: number; passes: number; avg_coherence: number | null };

  // Verifications given (as verifier)
  const given = db.prepare(
    'SELECT COUNT(*) as total FROM verifications WHERE verifier_id = ?'
  ).get(agentId) as { total: number };

  // Uptime: ratio of non-timeout results
  const uptimeData = db.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN result != 'timeout' THEN 1 ELSE 0 END) as responsive
     FROM verifications WHERE target_id = ?`
  ).get(agentId) as { total: number; responsive: number };

  const passRate = received.total > 0 ? received.passes / received.total : 0;
  const avgCoherence = received.avg_coherence ?? 0;
  const contribution = Math.min(1.0, given.total / 10);
  const uptime = uptimeData.total > 0 ? uptimeData.responsive / uptimeData.total : 0;

  const rawScore = 0.4 * passRate + 0.3 * avgCoherence + 0.2 * contribution + 0.1 * uptime;
  const confidenceMultiplier = Math.log(1 + received.total);

  return Math.round(rawScore * confidenceMultiplier * 100) / 100;
}

/**
 * Update an agent's status based on their reputation and verification history.
 *
 * Status lifecycle:
 *   pending → active (after first successful verification)
 *   active → suspended (reputation below 1.0 or unreachable 5+ times)
 *   suspended → active (passes a new verification)
 */
function updateAgentStatus(db: ReturnType<typeof getDatabase>, agentId: string, newReputation: number): void {
  const agent = db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status: string } | undefined;
  if (!agent) return;

  let newStatus = agent.status;

  if (agent.status === 'pending') {
    // Check if agent has at least one successful verification as target
    const passCount = db.prepare(
      "SELECT COUNT(*) as count FROM verifications WHERE target_id = ? AND result = 'pass'"
    ).get(agentId) as { count: number };

    if (passCount.count > 0) {
      newStatus = 'active';
    }
  } else if (agent.status === 'active') {
    // Check for suspension conditions
    if (newReputation < 1.0 && newReputation > 0) {
      // Only suspend if there are enough verifications to be meaningful
      const totalVerifications = db.prepare(
        'SELECT COUNT(*) as count FROM verifications WHERE target_id = ?'
      ).get(agentId) as { count: number };

      if (totalVerifications.count >= 3) {
        newStatus = 'suspended';
      }
    }

    // Check consecutive timeouts (unreachable 5+ times in a row)
    const recentResults = db.prepare(
      'SELECT result FROM verifications WHERE target_id = ? ORDER BY created_at DESC LIMIT 5'
    ).all(agentId) as { result: string }[];

    if (recentResults.length >= 5 && recentResults.every((r) => r.result === 'timeout')) {
      newStatus = 'suspended';
    }
  } else if (agent.status === 'suspended') {
    // Check if latest verification was a pass — reactivate
    const latest = db.prepare(
      'SELECT result FROM verifications WHERE target_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(agentId) as { result: string } | undefined;

    if (latest?.result === 'pass') {
      newStatus = 'active';
    }
  }

  if (newStatus !== agent.status) {
    db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(newStatus, agentId);
  }
}

/**
 * GET /v1/verify/assignment
 * Get a verification assignment for the authenticated agent.
 * Returns a random active agent to verify (not self).
 */
verify.get('/assignment', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const db = getDatabase();

  // Check agent count for bootstrap mode info
  const activeCount = db.prepare(
    "SELECT COUNT(*) as count FROM agents WHERE status = 'active'"
  ).get() as { count: number };

  // Pick a random agent to verify (active or pending, not self)
  const target = db.prepare(
    `SELECT id, name, contact_endpoint, capabilities
     FROM agents
     WHERE id != ? AND status IN ('active', 'pending')
     ORDER BY RANDOM()
     LIMIT 1`
  ).get(agentId) as Pick<Agent, 'id' | 'name' | 'contact_endpoint' | 'capabilities'> | undefined;

  if (!target) {
    return c.json({
      error: 'no_assignment',
      message: 'No agents available for verification at this time',
    }, 404);
  }

  // Generate assignment ID
  const assignmentId = uuidv4();
  const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours

  return c.json({
    assignment_id: assignmentId,
    target: {
      agent_id: target.id,
      name: target.name,
      contact_endpoint: target.contact_endpoint,
      capabilities: JSON.parse(target.capabilities),
    },
    deadline,
    bootstrap_mode: activeCount.count < 100,
    instructions: 'Contact the agent at its endpoint. Send a simple capability probe. Report results.',
  });
});

/**
 * POST /v1/verify/submit
 * Submit verification results.
 */
verify.post('/submit', agentAuth, async (c) => {
  const verifierId = c.get('agentId') as string;

  // Parse body
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
  const db = getDatabase();

  // Verify target exists
  const target = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(target_id) as { id: string; status: string } | undefined;
  if (!target) {
    return c.json({ error: 'not_found', message: 'Target agent not found' }, 404);
  }

  // Can't verify yourself
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

  // Note: We validate the signature exists and is well-formed.
  // Full cryptographic verification of the report signature would require
  // the verifier to sign the report data with their key.
  // For now, we verify format and trust the auth middleware's verification.
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

  // Verify the report signature against the verifier's public key
  const verifierPubKey = c.get('publicKey') as Uint8Array;
  const reportBytes = new TextEncoder().encode(reportData);
  const sigValid = await verifySignature(reportBytes, sigBytes, verifierPubKey);
  if (!sigValid) {
    return c.json({ error: 'bad_request', message: 'Invalid report signature' }, 400);
  }

  // Store the verification
  const verificationId = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO verifications (id, verifier_id, target_id, result, response_time_ms, coherence_score, notes, signature, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
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
  db.prepare(
    'UPDATE agents SET verification_count = verification_count + 1 WHERE id = ?'
  ).run(target_id);

  // Update last_seen for verifier
  db.prepare(
    'UPDATE agents SET last_seen = ? WHERE id = ?'
  ).run(now, verifierId);

  // Recalculate reputation for both target and verifier
  const targetReputation = calculateReputation(db, target_id);
  const verifierReputation = calculateReputation(db, verifierId);

  // Get previous reputations for delta calculation
  const targetAgent = db.prepare('SELECT reputation_score FROM agents WHERE id = ?').get(target_id) as { reputation_score: number };
  const verifierAgent = db.prepare('SELECT reputation_score FROM agents WHERE id = ?').get(verifierId) as { reputation_score: number };

  const targetDelta = Math.round((targetReputation - targetAgent.reputation_score) * 100) / 100;
  const verifierDelta = Math.round((verifierReputation - verifierAgent.reputation_score) * 100) / 100;

  // Update reputation scores
  db.prepare('UPDATE agents SET reputation_score = ? WHERE id = ?').run(targetReputation, target_id);
  db.prepare('UPDATE agents SET reputation_score = ? WHERE id = ?').run(verifierReputation, verifierId);

  // Update status lifecycle for both agents
  updateAgentStatus(db, target_id, targetReputation);
  updateAgentStatus(db, verifierId, verifierReputation);

  return c.json({
    ok: true,
    verification_id: verificationId,
    verifier_reputation_delta: verifierDelta,
    target_reputation_delta: targetDelta,
  });
});

export default verify;
