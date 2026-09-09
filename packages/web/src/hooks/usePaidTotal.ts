import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ApiTask } from '../api/types';

/**
 * "Total paid to task runners" — the all-time settled payout figure that leads
 * the task board (see Task_Board_Payout_Spec.md).
 *
 * Counting rule (honest, no fabricated fallback):
 *  - Sum only tasks whose `payment_status === 'settled'` — a confirmed USDC
 *    transfer to the runner. Accepted-but-unpaid, pending, authorized, failed
 *    and expired are excluded; so are open bounties (those are *listed rewards*,
 *    shown separately, not money already paid).
 *  - Sum in integer base units (USDC atomic, 6 decimals) so we never add rounded
 *    UI amounts; convert for display only.
 *  - Deduplicate by task_id (each settled task is counted once).
 *
 * A settled task is always in an accepted state, so we read the `verified`
 * (accepted) and `closed` lists rather than scanning every open task. If the API
 * cannot be reached we surface `failed` ("unavailable") rather than showing 0 —
 * a genuine 0.00 is reserved for a verified-empty history.
 */

export type PaidTotal =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; atomic: bigint; display: string; count: number; token: string; snapshot: string };

/** Format USDC atomic base units (6 decimals) as an exact 2-decimal string with grouping. */
export function formatUsdcAtomic(atomic: bigint): string {
  const neg = atomic < 0n;
  const a = neg ? -atomic : atomic;
  let whole = a / 1_000_000n;
  // Round the remaining base units to 2 decimals.
  let cents = ((a % 1_000_000n) * 100n + 500_000n) / 1_000_000n;
  if (cents === 100n) {
    whole += 1n;
    cents = 0n;
  }
  const wStr = whole.toLocaleString('en-US');
  const cStr = cents.toString().padStart(2, '0');
  return `${neg ? '-' : ''}${wStr}.${cStr}`;
}

/** Settled USDC for one task in atomic base units, or null if it is not a counted payout. */
function settledAtomic(task: ApiTask): bigint | null {
  if (task.payment_status !== 'settled') return null;
  const atomicStr = task.bounty?.amount_atomic;
  if (atomicStr && /^\d+$/.test(atomicStr)) {
    try {
      return BigInt(atomicStr);
    } catch {
      /* fall through to the display-string path */
    }
  }
  // Legacy tasks without a canonical atomic amount: derive from the display value.
  const disp = task.bounty?.amount_display ?? task.bounty_amount;
  if (disp) {
    const n = parseFloat(String(disp).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(n) && n >= 0) return BigInt(Math.round(n * 1e6));
  }
  return null;
}

export function usePaidTotal(): PaidTotal {
  const [total, setTotal] = useState<PaidTotal>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      api.getTasks({ status: 'verified', limit: 100 }).then((r) => r.tasks ?? []),
      // `closed` may 400 on older APIs; treat any failure here as "no extra rows".
      api.getTasks({ status: 'closed', limit: 100 }).then((r) => r.tasks ?? []).catch(() => [] as ApiTask[]),
    ])
      .then(([verified, closed]) => {
        if (cancelled) return;
        const seen = new Set<string>();
        let atomic = 0n;
        let count = 0;
        let token = 'USDC';
        for (const t of [...verified, ...closed]) {
          if (seen.has(t.task_id)) continue;
          seen.add(t.task_id);
          const a = settledAtomic(t);
          if (a === null) continue;
          atomic += a;
          count += 1;
          if (t.bounty?.token) token = t.bounty.token;
        }
        setTotal({
          kind: 'ready',
          atomic,
          display: formatUsdcAtomic(atomic),
          count,
          token,
          snapshot: new Date().toISOString(),
        });
      })
      .catch(() => {
        if (!cancelled) setTotal({ kind: 'failed' });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return total;
}
