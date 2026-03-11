/**
 * Reputation Calculator
 *
 * Computes a bounded [0, 1] reputation score for an agent.
 *
 * Components:
 *   pass_rate      (0.30) — time-weighted % of verifications that passed
 *   coherence      (0.20) — time-weighted avg coherence score from verifiers
 *   contribution   (0.15) — how many verifications the agent has given (caps at 10)
 *   uptime         (0.15) — % of verifications where agent responded (not timeout)
 *   skill_trust    (0.15) — avg trust score of declared skills
 *   penalty        (0.20) — explicit penalty for safety issues / unauthorized actions
 *
 * Confidence:
 *   min(1, log(1+n) / log(21)) — full weight at 20 received verifications
 *
 * Time decay:
 *   exp(-age_days / DECAY_CONSTANT) — verifications older than ~60 days count less
 *
 * Final:
 *   min(1, max(0, (raw - penalty) × confidence + profile_base))
 */

import type { DBAdapter } from '../db/adapter.js';

const DECAY_CONSTANT = 60; // half-life ~42 days
const MIN_VERIFIER_REP = 0.10; // verifiers below this threshold get reduced weight (Phase 2: EigenTrust)

interface VerificationRow {
  result: 'pass' | 'fail' | 'timeout';
  coherence_score: number | null;
  created_at: string;
  verifier_rep: number | null;
  structured_report: string | null;
}

interface StructuredReport {
  safety_issues?: boolean;
  unauthorized_actions?: boolean;
  tool_honesty?: boolean;
  capability_match?: number;
  consistent_behavior?: boolean;
  excessive_resources?: boolean;
}

function decayWeight(createdAt: string): number {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  return Math.exp(-ageDays / DECAY_CONSTANT);
}

export interface ReputationBreakdown {
  final_score: number;
  raw_score: number;
  confidence: number;
  penalty: number;
  components: {
    pass_rate: number;
    coherence: number;
    contribution: number;
    uptime: number;
    skill_trust: number;
  };
  weights: {
    pass_rate: number;
    coherence: number;
    contribution: number;
    uptime: number;
    skill_trust: number;
    penalty: number;
  };
  verifications_received: number;
  verifications_given: number;
  safety_flags: number;
}

export async function computeReputation(
  agentId: string,
  db: DBAdapter
): Promise<ReputationBreakdown> {

  // ── Fetch verifications received (join verifier rep) ──
  const verifications = await db.all<VerificationRow>(
    `SELECT v.result, v.coherence_score, v.created_at, v.structured_report,
            a.reputation_score as verifier_rep
     FROM verifications v
     LEFT JOIN agents a ON v.verifier_id = a.id
     WHERE v.target_id = ?
     ORDER BY v.created_at DESC`,
    agentId
  );

  const n = verifications.length;

  // ── Verifications given ──
  const givenRow = await db.get<{ total: number }>(
    'SELECT COUNT(*) as total FROM verifications WHERE verifier_id = ?',
    agentId
  );
  const given = givenRow?.total ?? 0;

  // ── Skill trust ──
  const agentRow = await db.get<{ skills: string | null; safety_flags: number }>(
    'SELECT skills, safety_flags FROM agents WHERE id = ?',
    agentId
  );
  let skillTrust = 0;
  if (agentRow?.skills) {
    try {
      const declared: Array<{ name: string; registry?: string; private?: boolean }> = JSON.parse(agentRow.skills);
      if (declared.length > 0) {
        const scores = await Promise.all(declared.map(async s => {
          if (s.private) return 0.5;
          const cacheId = `${s.registry ?? 'npm'}:${s.name}`;
          const row = await db.get<{ trust_score: number }>('SELECT trust_score FROM skill_cache WHERE id = ?', cacheId);
          return row?.trust_score ?? 0.0;
        }));
        skillTrust = scores.reduce((a, b) => a + b, 0) / scores.length;
      }
    } catch { /* malformed */ }
  }

  // ── Profile base score ──
  const profileBase = agentRow?.skills ? 0.05 : 0;
  const safetyFlags = agentRow?.safety_flags ?? 0;

  if (n === 0) {
    return {
      final_score: profileBase,
      raw_score: 0,
      confidence: 0,
      penalty: 0,
      components: { pass_rate: 0, coherence: 0, contribution: 0, uptime: 0, skill_trust: skillTrust },
      weights: { pass_rate: 0.30, coherence: 0.20, contribution: 0.15, uptime: 0.15, skill_trust: 0.15, penalty: 0.20 },
      verifications_received: 0,
      verifications_given: given,
      safety_flags: safetyFlags,
    };
  }

  // ── Time-decayed, verifier-weighted components ──
  let weightedPassSum = 0;
  let weightedCoherenceSum = 0;
  let weightedCoherenceWeightSum = 0;
  let weightedUptimeSum = 0;
  let totalWeight = 0;
  let penaltySum = 0;
  let penaltyWeightSum = 0;

  for (const v of verifications) {
    const decay = decayWeight(v.created_at);
    // Low-rep verifiers count at 50% — Phase 1 approximation of EigenTrust
    const verifierWeight = (v.verifier_rep ?? 0) < MIN_VERIFIER_REP ? 0.5 : 1.0;
    const w = decay * verifierWeight;
    totalWeight += w;

    weightedPassSum += w * (v.result === 'pass' ? 1 : 0);
    weightedUptimeSum += w * (v.result !== 'timeout' ? 1 : 0);

    if (v.coherence_score !== null) {
      weightedCoherenceSum += w * v.coherence_score;
      weightedCoherenceWeightSum += w;
    }

    // Penalty: safety issues or unauthorized actions from structured report
    let isPenalty = 0;
    if (v.structured_report) {
      try {
        const report: StructuredReport = JSON.parse(v.structured_report);
        if (report.safety_issues || report.unauthorized_actions) isPenalty = 1;
      } catch { /* skip */ }
    }
    penaltySum += w * isPenalty;
    penaltyWeightSum += w;
  }

  const passRate = totalWeight > 0 ? weightedPassSum / totalWeight : 0;
  const coherence = weightedCoherenceWeightSum > 0 ? weightedCoherenceSum / weightedCoherenceWeightSum : 0;
  const uptime = totalWeight > 0 ? weightedUptimeSum / totalWeight : 0;
  const contribution = Math.min(1.0, given / 10);
  const penalty = penaltyWeightSum > 0 ? penaltySum / penaltyWeightSum : 0;

  // ── Raw score ──
  const raw = (
    0.30 * passRate +
    0.20 * coherence +
    0.15 * contribution +
    0.15 * uptime +
    0.15 * skillTrust +
    -0.20 * penalty       // safety issues actively subtract
  );

  // ── Confidence (bounded, full at 20 verifications) ──
  const confidence = Math.min(1.0, Math.log(1 + n) / Math.log(21));

  // ── Final score ──
  const finalScore = Math.min(1.0, Math.max(0, raw * confidence + profileBase));

  return {
    final_score: Math.round(finalScore * 1000) / 1000,
    raw_score: Math.round(raw * 1000) / 1000,
    confidence: Math.round(confidence * 1000) / 1000,
    penalty: Math.round(penalty * 1000) / 1000,
    components: {
      pass_rate: Math.round(passRate * 1000) / 1000,
      coherence: Math.round(coherence * 1000) / 1000,
      contribution: Math.round(contribution * 1000) / 1000,
      uptime: Math.round(uptime * 1000) / 1000,
      skill_trust: Math.round(skillTrust * 1000) / 1000,
    },
    weights: { pass_rate: 0.30, coherence: 0.20, contribution: 0.15, uptime: 0.15, skill_trust: 0.15, penalty: 0.20 },
    verifications_received: n,
    verifications_given: given,
    safety_flags: safetyFlags,
  };
}
