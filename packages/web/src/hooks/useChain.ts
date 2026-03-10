import { useState, useEffect, useRef } from 'react';
import { api, mapApiChainEntry } from '../api/client';
import { mockChainEntries } from '../data/mockData';
import type { ChainEntry } from '../data/mockData';

interface UseChainResult {
  entries: ChainEntry[];
  latestSequence: number;
  total: number;
  loading: boolean;
  error: string | null;
  usingMock: boolean;
}

export function useChain(from?: number, to?: number): UseChainResult {
  const [entries, setEntries] = useState<ChainEntry[]>([]);
  const [latestSequence, setLatestSequence] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usingMock, setUsingMock] = useState(false);
  const keyRef = useRef('');

  useEffect(() => {
    const key = `${from}-${to}`;
    if (key === keyRef.current && entries.length > 0) return;
    keyRef.current = key;

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const [rangeResult, latestResult] = await Promise.all([
          api.getChainRange(from, to),
          api.getChainLatest(),
        ]);
        if (cancelled) return;

        const mapped = rangeResult.entries.map(mapApiChainEntry);
        // Sort descending by sequence for display
        mapped.sort((a, b) => b.sequence - a.sequence);

        setEntries(mapped);
        setLatestSequence(latestResult.sequence);
        setTotal(rangeResult.total ?? latestResult.sequence);
        setUsingMock(false);
        setError(null);
      } catch (err) {
        if (cancelled) return;

        // Fallback to mock data
        setEntries(mockChainEntries);
        setLatestSequence(mockChainEntries[0]?.sequence ?? 0);
        setTotal(mockChainEntries.length);
        setUsingMock(true);
        setError(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [from, to]);

  return { entries, latestSequence, total, loading, error, usingMock };
}
