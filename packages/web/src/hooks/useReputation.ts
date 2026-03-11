import { useState, useEffect } from 'react';
import { api } from '../api/client';

export interface ReputationBreakdown {
  reputation_score: number;
  breakdown: {
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
  penalty: number;
  safety_flags: number;
  raw_score: number;
  confidence: number;
  verifications_received: number;
  verifications_given: number;
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
