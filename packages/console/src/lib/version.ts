/**
 * Stale-tab guard (field-hit): a tab left open for days keeps running its old
 * bundle — old prompts, old flows — because SPA navigations never refetch
 * index.html. Compare the build id baked into this bundle against the
 * /version.json the current deploy serves; when they diverge, the app shows a
 * refresh banner (App.tsx). Checks run on an interval and whenever the tab
 * regains visibility (the exact moment a dusty tab comes back). Every failure
 * mode is silent — a guard must never break the page it guards (dev server
 * has no version.json; offline fetches just miss a beat).
 */
import { useEffect, useState } from 'react';

declare const __BUILD_ID__: string;

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

async function deployedBuild(): Promise<string | null> {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const json = (await res.json()) as { build?: string };
    return typeof json.build === 'string' ? json.build : null;
  } catch {
    return null;
  }
}

/** True once the deployed build no longer matches the one this tab is running. */
export function useStaleTabGuard(): boolean {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (stale) return; // latched — no need to keep checking

    let cancelled = false;
    async function check(): Promise<void> {
      const deployed = await deployedBuild();
      if (!cancelled && deployed !== null && deployed !== __BUILD_ID__) setStale(true);
    }

    void check();
    const interval = setInterval(() => void check(), CHECK_INTERVAL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [stale]);

  return stale;
}
