import { createContext, useContext, useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { control, ControlApiError } from '../api/control.js';
import type { OwnerMe } from '../api/types.js';

interface SessionValue {
  owner: OwnerMe | null;
  loading: boolean;
  /** Re-fetch /me (call after login/logout or a mutation). */
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function OwnerProvider({ children }: { children: ReactNode }) {
  const [owner, setOwner] = useState<OwnerMe | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setOwner(await control.me());
    } catch (err) {
      // 401 just means "no live session" — not an error worth surfacing.
      if (!(err instanceof ControlApiError) || err.status !== 401) {
        // eslint-disable-next-line no-console
        console.error('session refresh failed', err);
      }
      setOwner(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await control.logout();
    } finally {
      setOwner(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <SessionContext.Provider value={{ owner, loading, refresh, logout }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useOwner(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useOwner must be used within an OwnerProvider');
  return ctx;
}
