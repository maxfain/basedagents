import { useState, useEffect } from 'react';
import { api } from '../api/client';

/**
 * Shape of GET /v1/agents/:id/reputation (packages/api/src/routes/agents.ts).
 * `breakdown` is the calculator's `components`; the task fields are the
 * Tasks P0 additions and are optional so an older API still renders.
 */
export interface ReputationBreakdown {
  reputation_score: number;
  breakdown: {
    pass_rate: number;
    coherence: number;
    contribution: number;
    uptime: number;
    cap_confirmation_rate: number;
    task_completion?: number;
  };
  weights: {
    pass_rate: number;
    coherence: number;
    contribution: number;
    uptime: number;
    cap_confirmation_rate: number;
    penalty: number;
    task_completion?: number;
  };
  penalty: number;
  safety_flags: number;
  raw_score: number;
  confidence: number;
  verifications_received: number;
  verifications_given: number;
  /** Time-decayed acceptance weight (auto-acceptance counts 0.5), rounded. */
  tasks_accepted?: number;
  /** Time-decayed count of deliveries disputed and then cancelled, rounded. */
  tasks_failed?: number;
}

export function useReputation(agentId: string | undefined) {
  const [data, setData] = useState<ReputationBreakdown | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const result = await api.getReputation(agentId);
        if (!cancelled) setData(result as unknown as ReputationBreakdown);
      } catch {
        // silently fail — AgentProfile shows a fallback
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [agentId]);

  return { data, loading };
}
