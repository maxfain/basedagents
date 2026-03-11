/**
 * EigenTrust — Phase 2 Sybil-Resistant Reputation
 *
 * Trust propagates through the verification graph. A verifier's weight
 * is proportional to their own trust score, so sybil rings of low-trust
 * agents cannot inflate each other.
 *
 * Algorithm:
 *   1. Build local trust matrix C where c[i][j] = fraction of i's positive
 *      verifications that went to j (normalised per-row).
 *   2. Pre-trust vector p: only genesis/pinned agents start with trust.
 *   3. Iterate: t = α·(Cᵀ·t) + (1-α)·p  until convergence.
 *   4. Blend with local signal: final = β·eigenScore + (1-β)·localScore
 *
 * Notes:
 *   - Negative verifications (fail/timeout + safety flag) subtract from c[i][j].
 *   - Minimum floor of 0 per cell — can't go negative.
 *   - Agents with reputation_override are pinned; their score is not updated.
 *   - Runs network-wide after every verification submit.
 */

import type { DBAdapter } from '../db/adapter.js';

const ALPHA       = 0.85;  // weight on propagated trust vs pre-trust
const BETA        = 0.70;  // weight on EigenTrust vs local signal
const EPSILON     = 1e-6;  // convergence threshold
const MAX_ITER    = 100;   // safety cap
const DECAY_DAYS  = 60;    // time-decay half-life (same as local calculator)

interface AgentRow {
  id: string;
  reputation_score: number;
  reputation_override: number | null;
  skills: string | null;
  safety_flags: number;
}

interface VerRow {
  verifier_id: string;
  target_id:   string;
  result:      'pass' | 'fail' | 'timeout';
  coherence_score: number | null;
  structured_report: string | null;
  created_at:  string;
}

function decay(createdAt: string): number {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86_400_000;
  return Math.exp(-ageDays / DECAY_DAYS);
}

export async function runEigenTrust(db: DBAdapter): Promise<void> {
  // ── Load agents ──
  const agents = await db.all<AgentRow>(
    'SELECT id, reputation_score, reputation_override, skills, safety_flags FROM agents'
  );
  if (agents.length < 2) return; // nothing to propagate

  const ids = agents.map(a => a.id);
  const idx = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;

  // ── Load all verifications ──
  const verifications = await db.all<VerRow>(
    `SELECT verifier_id, target_id, result, coherence_score, structured_report, created_at
     FROM verifications ORDER BY created_at ASC`
  );

  // ── Build raw trust matrix (unnormalised) ──
  // c[i][j] = weighted positive signal from agent i toward agent j
  const C = Array.from({ length: n }, () => new Float64Array(n));

  for (const v of verifications) {
    const i = idx.get(v.verifier_id);
    const j = idx.get(v.target_id);
    if (i === undefined || j === undefined || i === j) continue;

    const w = decay(v.created_at);

    // Base signal: pass=+1, timeout=0, fail=-0.5
    let signal = 0;
    if (v.result === 'pass') {
      signal = 1;
      // Boost with coherence score if present
      if (v.coherence_score !== null) signal = 0.5 + 0.5 * v.coherence_score;
    } else if (v.result === 'fail') {
      signal = -0.5;
      // Extra penalty for safety flags in structured report
      if (v.structured_report) {
        try {
          const r = JSON.parse(v.structured_report) as { safety_issues?: boolean; unauthorized_actions?: boolean };
          if (r.safety_issues || r.unauthorized_actions) signal = -1;
        } catch { /* skip */ }
      }
    }
    // Accumulate (floor to 0 per-entry after normalisation)
    C[i][j] += w * signal;
  }

  // ── Normalise rows: c[i][j] = max(0, raw) / sum_j(max(0, raw)) ──
  for (let i = 0; i < n; i++) {
    let rowSum = 0;
    for (let j = 0; j < n; j++) rowSum += Math.max(0, C[i][j]);
    if (rowSum > 0) {
      for (let j = 0; j < n; j++) C[i][j] = Math.max(0, C[i][j]) / rowSum;
    } else {
      // No outgoing trust — uniform over peers (dangling node)
      for (let j = 0; j < n; j++) C[i][j] = i !== j ? 1 / (n - 1) : 0;
    }
  }

  // ── Pre-trust vector p ──
  // Pinned agents (reputation_override set) seed the network
  const p = new Float64Array(n);
  let pSum = 0;
  for (const a of agents) {
    if (a.reputation_override !== null) {
      const i = idx.get(a.id)!;
      p[i] = a.reputation_override;
      pSum += a.reputation_override;
    }
  }
  // If nothing is pinned, fall back to uniform
  if (pSum === 0) {
    for (let i = 0; i < n; i++) p[i] = 1 / n;
    pSum = 1;
  } else {
    for (let i = 0; i < n; i++) p[i] /= pSum; // normalise
  }

  // ── Power iteration: t = α·(Cᵀ·t) + (1-α)·p ──
  let t = new Float64Array(p); // start at pre-trust
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const next = new Float64Array(n);
    // next[j] += α * C[i][j] * t[i]  (Cᵀ applied)
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        next[j] += ALPHA * C[i][j] * t[i];
      }
    }
    // Add pre-trust component
    for (let i = 0; i < n; i++) next[i] += (1 - ALPHA) * p[i];

    // Normalise to sum=1
    let s = 0;
    for (let i = 0; i < n; i++) s += next[i];
    if (s > 0) for (let i = 0; i < n; i++) next[i] /= s;

    // Check convergence
    let delta = 0;
    for (let i = 0; i < n; i++) delta += Math.abs(next[i] - t[i]);
    t = next;
    if (delta < EPSILON) break;
  }

  // ── Scale to [0,1]: t is a probability distribution, max it out ──
  // Multiply by n so the "average" agent scores ~1/n * n = 1, then cap.
  // Use log scaling so genesis doesn't crush everyone else.
  const tMax = Math.max(...Array.from(t));
  const scaled = tMax > 0 ? Array.from(t).map(v => v / tMax) : Array.from(t);

  // ── Blend with local signal and persist ──
  for (let i = 0; i < n; i++) {
    const agent = agents[i];
    // Never overwrite pinned scores
    if (agent.reputation_override !== null) continue;

    const eigenScore = Math.min(1, Math.max(0, scaled[i]));
    const localScore = agent.reputation_score; // already stored from local calculator
    const blended = BETA * eigenScore + (1 - BETA) * localScore;
    const final = Math.min(1, Math.max(0, Math.round(blended * 1000) / 1000));

    await db.run(
      'UPDATE agents SET reputation_score = ? WHERE id = ?',
      final, agent.id
    );
  }
}
