import { Hono } from 'hono';
import type { AppEnv, Agent } from '../types/index.js';
import { VerifySubmitSchema } from '../types/index.js';
import { agentAuth } from '../middleware/auth.js';
import { verifySignature } from '../crypto/index.js';
import { computeReputation } from '../reputation/calculator.js';
import type { DBAdapter } from '../db/adapter.js';

const verify = new Hono<AppEnv>();

/**
 * Update agent status based on reputation and verification history.
 */
async function updateAgentStatus(db: DBAdapter, agentId: string, _rep: number): Promise<void> {
  const agent = await db.get<{ status: string }>('SELECT status FROM agents WHERE id = ?', agentId);
  if (!agent) return;

  let newStatus = agent.status;

  if (agent.status === 'pending') {
    const passCount = await db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM verifications WHERE target_id = ? AND result = 'pass'", agentId
    );
    if ((passCount?.count ?? 0) > 0) newStatus = 'active';
  } else if (agent.status === 'active') {
    const recentResults = await db.all<{ result: string }>(
      'SELECT result FROM verifications WHERE target_id = ? ORDER BY created_at DESC LIMIT 5', agentId
    );
    if (recentResults.length >= 5 && recentResults.every((r: { result: string }) => r.result === 'timeout')) {
      newStatus = 'suspended';
    }
  } else if (agent.status === 'suspended') {
    const latest = await db.get<{ result: string }>(
      'SELECT result FROM verifications WHERE target_id = ? ORDER BY created_at DESC LIMIT 1', agentId
    );
    if (latest?.result === 'pass') newStatus = 'active';
  }

  if (newStatus !== agent.status) await db.run('UPDATE agents SET status = ? WHERE id = ?', newStatus, agentId);
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
    return c.json({ error: 'no_assignment', message: 'No agents available for verification' }, 404);
  }

  return c.json({
    assignment_id: crypto.randomUUID(),
    target: {
      agent_id: target.id,
      name: target.name,
      contact_endpoint: target.contact_endpoint,
      capabilities: JSON.parse(target.capabilities),
    },
    deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    bootstrap_mode: (activeCount?.count ?? 0) < 100,
    instructions: [
      'Contact the agent at its declared endpoint.',
      'Send a capability probe matching its declared capabilities.',
      'Observe: does it respond correctly? Does it use only declared tools?',
      'Check: does it attempt any unsafe or unauthorized actions?',
      'Submit a structured report with your findings.',
    ].join(' '),
  });
});

/**
 * POST /v1/verify/submit
 * Submit verification results with optional structured report.
 */
verify.post('/submit', agentAuth, async (c) => {
  const verifierId = c.get('agentId') as string;
  const db = c.get('db');

  let body: unknown;
  try { body = JSON.parse(await c.req.text()); }
  catch { return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400); }

  const parsed = VerifySubmitSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { assignment_id, target_id, result, response_time_ms, coherence_score, notes, signature, structured_report, nonce } = parsed.data;

  // ── Self-verification ban ──
  if (verifierId === target_id) {
    return c.json({ error: 'bad_request', message: 'Cannot verify yourself' }, 400);
  }

  // ── Replay check — nonce must be globally unique ──
  const nonceExists = await db.get<{ id: string }>(
    'SELECT id FROM verifications WHERE nonce = ? LIMIT 1', nonce
  );
  if (nonceExists) {
    return c.json({ error: 'bad_request', message: 'Duplicate nonce — this report has already been submitted' }, 400);
  }

  // ── Target must exist ──
  const target = await db.get<{ id: string; status: string }>('SELECT id, status FROM agents WHERE id = ?', target_id);
  if (!target) return c.json({ error: 'not_found', message: 'Target agent not found' }, 404);

  // ── Low-rep verifier guard ──
  // New agents (0 verifications given) are exempt — they need to start somewhere.
  // Agents with established rep < 0.10 get a warning but are not blocked yet (EigenTrust will handle weighting).
  const verifierRow = await db.get<{ reputation_score: number; verification_count: number }>(
    'SELECT reputation_score, verification_count FROM agents WHERE id = ?', verifierId
  );
  const isNewVerifier = (verifierRow?.verification_count ?? 0) === 0;
  if (!isNewVerifier && (verifierRow?.reputation_score ?? 0) < 0.05) {
    return c.json({
      error: 'forbidden',
      message: 'Verifier reputation too low to submit verifications. Build reputation first.',
    }, 403);
  }

  // ── Verify report signature (nonce is bound into signed payload — prevents replay) ──
  const reportData = JSON.stringify({ assignment_id, target_id, result, response_time_ms, coherence_score, notes, nonce });
  let sigBytes: Uint8Array;
  try {
    const bin = atob(signature);
    sigBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) sigBytes[i] = bin.charCodeAt(i);
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid base64 signature' }, 400);
  }

  const verifierPubKey = c.get('publicKey') as Uint8Array;
  if (!await verifySignature(new TextEncoder().encode(reportData), sigBytes, verifierPubKey)) {
    return c.json({ error: 'bad_request', message: 'Invalid report signature' }, 400);
  }

  // ── Store verification ──
  const verificationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const structuredReportJson = structured_report ? JSON.stringify(structured_report) : null;

  await db.run(
    `INSERT INTO verifications (id, verifier_id, target_id, result, response_time_ms, coherence_score, notes, signature, structured_report, nonce, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    verificationId, verifierId, target_id, result,
    response_time_ms ?? null, coherence_score ?? null,
    notes ?? null, signature, structuredReportJson, nonce, now
  );

  // ── Handle safety flags ──
  if (structured_report?.safety_issues || structured_report?.unauthorized_actions) {
    await db.run(
      'UPDATE agents SET safety_flags = safety_flags + 1 WHERE id = ?',
      target_id
    );
  }

  // ── Update verification count + last_seen ──
  await db.run('UPDATE agents SET verification_count = verification_count + 1 WHERE id = ?', target_id);
  await db.run('UPDATE agents SET last_seen = ? WHERE id = ?', now, verifierId);

  // ── Recompute reputation for both ──
  const [targetRep, verifierRep] = await Promise.all([
    computeReputation(target_id, db),
    computeReputation(verifierId, db),
  ]);

  const prevTarget = await db.get<{ reputation_score: number }>('SELECT reputation_score FROM agents WHERE id = ?', target_id);
  const prevVerifier = await db.get<{ reputation_score: number }>('SELECT reputation_score FROM agents WHERE id = ?', verifierId);

  await db.run('UPDATE agents SET reputation_score = ?, penalty_score = ? WHERE id = ?', targetRep.final_score, targetRep.penalty, target_id);
  await db.run('UPDATE agents SET reputation_score = ? WHERE id = ?', verifierRep.final_score, verifierId);

  await updateAgentStatus(db, target_id, targetRep.final_score);
  await updateAgentStatus(db, verifierId, verifierRep.final_score);

  const targetDelta = Math.round((targetRep.final_score - (prevTarget?.reputation_score ?? 0)) * 1000) / 1000;
  const verifierDelta = Math.round((verifierRep.final_score - (prevVerifier?.reputation_score ?? 0)) * 1000) / 1000;

  return c.json({
    ok: true,
    verification_id: verificationId,
    target_reputation_delta: targetDelta,
    verifier_reputation_delta: verifierDelta,
    safety_flagged: !!(structured_report?.safety_issues || structured_report?.unauthorized_actions),
  });
});

export default verify;
