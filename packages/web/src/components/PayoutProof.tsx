import React from 'react';
import type { PaidTotal } from '../hooks/usePaidTotal';

/**
 * "Total paid to task runners" — the settled-payout proof block.
 *
 * Per Task_Board_Payout_Spec.md this is the money already paid out, kept
 * strictly separate from open *listed rewards*. Every data state renders
 * distinctly and no illustrative figure is ever a fallback:
 *   loading    → em dash + "Payout total loading"
 *   failed     → em dash + "Payout total unavailable"
 *   ready, 0   → "0.00 USDC" + "No tasks paid yet"
 *   ready, >0  → exact total + snapshot time + history link
 */

/** UTC snapshot label, e.g. "9 Sep 2026, 14:03 UTC". */
function snapshotLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'now';
  return (
    d.toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    }) + ' UTC'
  );
}

export function PayoutProof({
  total,
  onViewHistory,
}: {
  total: PaidTotal;
  onViewHistory?: () => void;
}): React.ReactElement {
  const empty = total.kind === 'ready' && total.atomic === 0n;

  return (
    <section className="payout" aria-label="Total paid to task runners">
      <div className="payout-head">
        <span className="payout-label">Total paid to task runners</span>
        <span className="payout-window">All time · Settled payments</span>
      </div>

      <div className="payout-figure">
        {total.kind === 'loading' && (
          <span className="payout-amount payout-amount-muted" aria-live="polite">
            —<span className="payout-state"> Payout total loading</span>
          </span>
        )}
        {total.kind === 'failed' && (
          <span className="payout-amount payout-amount-muted">
            —<span className="payout-state"> Payout total unavailable</span>
          </span>
        )}
        {total.kind === 'ready' && (
          <>
            <span className="payout-amount">
              {total.display}
              <span className="payout-unit">{total.token}</span>
            </span>
            <span className="payout-sub">
              {empty ? (
                'No tasks paid yet'
              ) : (
                <>
                  {total.count} settled {total.count === 1 ? 'payout' : 'payouts'} · Paid out through BasedAgents Tasks
                </>
              )}
            </span>
          </>
        )}
      </div>

      <div className="payout-foot">
        <span className="payout-fresh">
          {total.kind === 'ready' ? `Updated ${snapshotLabel(total.snapshot)}` : 'Reconciled from settled task payments'}
        </span>
        {total.kind === 'ready' && !empty && onViewHistory && (
          <button type="button" className="payout-history" onClick={onViewHistory}>
            View payout history →
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * Compact one-line variant for the homepage, mirroring the same reconciled
 * metric beside the "Browse paid tasks" action.
 */
export function PayoutProofInline({ total }: { total: PaidTotal }): React.ReactElement {
  return (
    <div className="payout-inline">
      <span className="payout-inline-num">
        {total.kind === 'ready' ? (
          <>
            {total.display} <span className="payout-inline-unit">{total.token}</span>
          </>
        ) : (
          '—'
        )}
      </span>
      <span className="payout-inline-label">
        {total.kind === 'failed'
          ? 'Payout total unavailable'
          : total.kind === 'loading'
            ? 'Total paid to task runners'
            : total.atomic === 0n
              ? 'Paid to task runners · no tasks paid yet'
              : 'Total paid to task runners · all time, settled'}
      </span>
    </div>
  );
}
