import { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react';
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
  // Monotonic guard: only the NEWEST refresh may write state. Without it, a
  // slow cookieless GET /me dispatched at mount can resolve (401) AFTER a
  // freshly-claimed session's refresh and clobber the owner back to null,
  // bouncing the just-signed-in user to /login.
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const me = await control.me();
      if (mine === seq.current) setOwner(me);
    } catch (err) {
      // 401 just means "no live session" — not an error worth surfacing.
      if (!(err instanceof ControlApiError) || err.status !== 401) {
        // eslint-disable-next-line no-console
        console.error('session refresh failed', err);
      }
      if (mine === seq.current) setOwner(null);
    } finally {
      if (mine === seq.current) setLoading(false);
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
