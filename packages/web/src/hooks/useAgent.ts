import { useState, useEffect, useRef } from 'react';
import { api, mapApiAgentToAgent, mapApiVerifications } from '../api/client';
import { getAgentById, getVerificationsForAgent } from '../data/mockData';
import type { Agent, Verification } from '../data/mockData';

interface UseAgentResult {
  agent: Agent | undefined;
  verifications: Verification[];
  loading: boolean;
  error: string | null;
  usingMock: boolean;
}

export function useAgent(id: string | undefined): UseAgentResult {
  const [agent, setAgent] = useState<Agent | undefined>(undefined);
  const [verifications, setVerifications] = useState<Verification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usingMock, setUsingMock] = useState(false);
  const prevId = useRef(id);

  useEffect(() => {
    if (!id) {
      setAgent(undefined);
      setVerifications([]);
      setLoading(false);
      return;
    }

    // Reset on id change
    if (prevId.current !== id) {
      setAgent(undefined);
      setVerifications([]);
      setError(null);
      prevId.current = id;
    }

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const apiAgent = await api.getAgent(id);
        if (cancelled) return;

        const mapped = mapApiAgentToAgent(apiAgent);
        const mappedVerifications = mapApiVerifications(apiAgent);

        setAgent(mapped);
        setVerifications(mappedVerifications);
        setUsingMock(false);
        setError(null);
      } catch (err) {
        if (cancelled) return;

        // Fallback to mock data
        const mockAgent = getAgentById(id);
        const mockVerifs = getVerificationsForAgent(id);
        if (mockAgent) {
          setAgent(mockAgent);
          setVerifications(mockVerifs);
          setUsingMock(true);
          setError(null);
        } else {
          setAgent(undefined);
          setVerifications([]);
          setUsingMock(false);
          setError(err instanceof Error ? err.message : 'Failed to fetch agent');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [id]);

  return { agent, verifications, loading, error, usingMock };
}
