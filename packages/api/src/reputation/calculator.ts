/**
 * Reputation Calculator
 *
 * Computes a bounded [0, 1] reputation score for an agent.
 *
 * Components (peer verification, weighted into `raw`):
 *   pass_rate      (0.35) — time-weighted % of verifications that passed
 *   coherence      (0.20) — time-weighted avg coherence score from verifiers
 *   contribution   (0.15) — how many verifications the agent has given (log scale, ~50 for 1.0)
 *   uptime         (0.15) — % of verifications where agent responded (not timeout)
 *   cap_confirmation_rate (0.15) — fraction of declared capabilities confirmed by verifiers
 *   penalty        (0.20) — explicit penalty for safety issues / unauthorized actions
 *
 * Task completion (Tasks P0, D6 — ADDITIVE, never renormalises the weights above):
 *   task_completion (0.15) — accepted deliveries vs disputed-then-cancelled ones,
 *   time-decayed; an acceptance by the 7-day timer counts half of a buyer's
 *   acceptance; its own confidence min(1, ln(1+n_t)/ln 11) (full at 10 tasks).
 *   Exactly zero for an agent that never delivered a task, so no existing score
 *   moves. Settlement never affects the deliverer (it is the buyer's money).
 *
 * Confidence:
 *   min(1, log(1+n) / log(21)) — full weight at 20 received verifications
 *
 * Time decay:
 *   exp(-age_days / DECAY_CONSTANT) — verifications older than ~60 days count less
 *
 * Final:
 *   min(1, max(0, raw × confidence + profile_base + 0.15 × task_completion))
 */

import type { DBAdapter } from '../db/adapter.js';

const DECAY_CONSTANT = 60; // half-life ~42 days

interface VerificationRow {
  result: 'pass' | 'fail' | 'timeout';
  coherence_score: number | null;
  created_at: string;
  verifier_rep: number | null;
  structured_report: string | null;
}

interface TaskOutcomeRow {
  status: 'verified' | 'cancelled';
  accepted_by: 'creator' | 'auto' | null;
  verified_at: string | null;
  cancelled_at: string | null;
  disputed_at: string | null;
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
    cap_confirmation_rate: number;
    /** rate × confidence over delivered tasks (accepted vs disputed-then-cancelled), 0 with no tasks. */
    task_completion: number;
  };
  weights: {
    pass_rate: number;
    coherence: number;
    contribution: number;
    uptime: number;
    cap_confirmation_rate: number;
    penalty: number;
    task_completion: number;
  };
  verifications_received: number;
  verifications_given: number;
  safety_flags: number;
  /** Time-decayed acceptance weight (an auto-acceptance counts 0.5), rounded. */
  tasks_accepted: number;
  /** Time-decayed count of deliveries the buyer disputed and then cancelled, rounded. */
  tasks_failed: number;
}

const WEIGHTS: ReputationBreakdown['weights'] = {
  pass_rate: 0.35, coherence: 0.20, contribution: 0.15, uptime: 0.15, cap_confirmation_rate: 0.15, penalty: 0.20, task_completion: 0.15,
};
const TASK_CONFIDENCE_FULL_AT = 10;

/**
 * The deliverer's task record. Tolerates an OSS deploy without the tasks
 * table (returns zeros).
 */
async function taskCompletion(agentId: string, db: DBAdapter): Promise<{ component: number; accepted: number; failed: number }> {
  let rows: TaskOutcomeRow[] = [];
  try {
    rows = await db.all<TaskOutcomeRow>(
      `SELECT status, accepted_by, verified_at, cancelled_at, disputed_at FROM tasks
       WHERE claimed_by_agent_id = ?
         AND (status = 'verified' OR (status = 'cancelled' AND disputed_at IS NOT NULL))`,
      agentId,
    );
  } catch {
    return { component: 0, accepted: 0, failed: 0 };
  }
  let accepted = 0;
  let failed = 0;
  for (const r of rows) {
    if (r.status === 'verified') {
      accepted += decayWeight(r.verified_at ?? new Date().toISOString()) * (r.accepted_by === 'auto' ? 0.5 : 1);
    } else {
      failed += decayWeight(r.cancelled_at ?? r.disputed_at ?? new Date().toISOString());
    }
  }
  const n = accepted + failed;
  if (n <= 0) return { component: 0, accepted: 0, failed: 0 };
  const rate = accepted / n;
  const confidence = Math.min(1, Math.log(1 + n) / Math.log(1 + TASK_CONFIDENCE_FULL_AT));
  return { component: rate * confidence, accepted, failed };
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

export async function computeReputation(
  agentId: string,
  db: DBAdapter
): Promise<ReputationBreakdown> {

  // ── Check for manual override (genesis / trust anchors) ──
  const overrideRow = await db.get<{ reputation_override: number | null }>(
    'SELECT reputation_override FROM agents WHERE id = ?',
    agentId
  );
  if (overrideRow?.reputation_override != null) {
    const score = overrideRow.reputation_override;
    return {
      final_score: score,
      raw_score: score,
      confidence: 1.0,
      penalty: 0,
      components: { pass_rate: score, coherence: score, contribution: score, uptime: score, cap_confirmation_rate: score, task_completion: score },
      weights: WEIGHTS,
      verifications_received: 0,
      verifications_given: 0,
      safety_flags: 0,
      tasks_accepted: 0,
      tasks_failed: 0,
    };
  }

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

  // ── Capability confirmation rate ──
  // Fraction of declared capabilities confirmed by at least one passing verifier.
  // This replaces skill_trust (download-count based) — what matters is whether
  // verifiers actually observed the claimed capabilities in action.
  const agentRow = await db.get<{ skills: string | null; capabilities: string | null; safety_flags: number }>(
    'SELECT skills, capabilities, safety_flags FROM agents WHERE id = ?',
    agentId
  );
  let capConfirmationRate = 0;
  const declared: string[] = [];
  if (agentRow?.capabilities) {
    try {
      const caps: string[] = JSON.parse(agentRow.capabilities);
      declared.push(...caps);
    } catch { /* malformed */ }
  }
  if (declared.length > 0) {
    // Collect all capabilities confirmed across passing verifications
    const confirmedSet = new Set<string>();
    for (const v of verifications) {
      if (v.result !== 'pass' || !v.structured_report) continue;
      try {
        const report = JSON.parse(v.structured_report) as { capabilities_confirmed?: string[] };
        for (const cap of report.capabilities_confirmed ?? []) {
          confirmedSet.add(cap.toLowerCase().replace(/[_-]/g, ''));
        }
      } catch { /* skip */ }
    }
    const confirmedCount = declared.filter(c =>
      confirmedSet.has(c.toLowerCase().replace(/[_-]/g, ''))
    ).length;
    capConfirmationRate = confirmedCount / declared.length;
  }

  // ── Profile base score ──
  const profileBase = agentRow?.skills ? 0.05 : 0;
  const safetyFlags = agentRow?.safety_flags ?? 0;

  // ── Task completion (additive) ──
  const tasks = await taskCompletion(agentId, db);
  const taskTerm = WEIGHTS.task_completion * tasks.component;

  if (n === 0) {
    return {
      final_score: r3(Math.min(1.0, Math.max(0, profileBase + taskTerm))),
      raw_score: 0,
      confidence: 0,
      penalty: 0,
      components: { pass_rate: 0, coherence: 0, contribution: 0, uptime: 0, cap_confirmation_rate: capConfirmationRate, task_completion: r3(tasks.component) },
      weights: WEIGHTS,
      verifications_received: 0,
      verifications_given: given,
      safety_flags: safetyFlags,
      tasks_accepted: r3(tasks.accepted),
      tasks_failed: r3(tasks.failed),
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
    // Proportional verifier weight: scales with actual rep, minimum 10%.
    // Prevents coordinating low-rep accounts from having outsized voting power.
    const verifierWeight = Math.max(0.1, v.verifier_rep ?? 0);
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
  // Default to 0 if no coherence scores exist (all null) — prevents NaN propagation
  const rawCoherence = weightedCoherenceWeightSum > 0 ? weightedCoherenceSum / weightedCoherenceWeightSum : 0;
  const coherence = isNaN(rawCoherence) ? 0 : rawCoherence;
  const uptime = totalWeight > 0 ? weightedUptimeSum / totalWeight : 0;
  // Logarithmic scale: caps at ~50 verifications for 1.0 (much harder to max out than linear /10)
  const contribution = Math.min(1.0, Math.log10(given + 1) / Math.log10(51));
  const penalty = penaltyWeightSum > 0 ? penaltySum / penaltyWeightSum : 0;

  // ── Raw score ──
  const raw = (
    0.35 * passRate +           // bumped: primary signal
    0.20 * coherence +
    0.15 * contribution +
    0.15 * uptime +
    0.15 * capConfirmationRate + // replaces skill_trust: verifier-confirmed capabilities
    -0.20 * penalty
  );

  // ── Confidence (bounded, full at 20 verifications) ──
  const confidence = Math.min(1.0, Math.log(1 + n) / Math.log(21));

  // ── Final score ── (guard against NaN from all-null coherence scores or zero weights)
  const safeRaw = isNaN(raw) ? 0 : raw;
  const finalScore = Math.min(1.0, Math.max(0, safeRaw * confidence + profileBase + taskTerm));

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
      cap_confirmation_rate: Math.round(capConfirmationRate * 1000) / 1000,
      task_completion: r3(tasks.component),
    },
    weights: WEIGHTS,
    verifications_received: n,
    verifications_given: given,
    safety_flags: safetyFlags,
    tasks_accepted: r3(tasks.accepted),
    tasks_failed: r3(tasks.failed),
  };
}
