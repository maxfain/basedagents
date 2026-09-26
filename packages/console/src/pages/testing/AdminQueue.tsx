/**
 * /testing/admin — the operator work queue (spec §16): intake review,
 * awaiting payment, awaiting task approval, executing, evidence review,
 * financial exceptions, cancellation requests, stuck operations.
 *
 * PROPRIETARY console code — see ../../../LICENSE.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { testingAdmin, type AdminQueue as Queue, type AdminOrderRow } from '../../api/testing.js';

function OrderRows({ rows }: { rows: AdminOrderRow[] }) {
  if (rows.length === 0) return <p className="empty">Nothing here.</p>;
  return (
    <div className="rows">
      {rows.map((o) => (
        <Link key={o.id} to={`/testing/admin/orders/${o.id}`} className="row">
          <span className="row-label">{o.id}</span>
          <span className="row-muted">{o.payment_state} · {o.fulfillment_state}{o.risk_hold ? ' · RISK HOLD' : ''}{o.cancel_requested_at ? ' · cancel requested' : ''}</span>
          <span className="row-date">{new Date(o.updated_at).toLocaleString()}</span>
        </Link>
      ))}
    </div>
  );
}

export default function TestingAdminQueue() {
  const [queue, setQueue] = useState<(Queue & { package?: { price_cents: number; worker_cap_usdc_atomic: string } }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    testingAdmin.queue().then(setQueue).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (error) return <div className="page"><div className="banner banner-error">{error}</div></div>;
  if (!queue) return <div className="page"><p className="muted">Loading…</p></div>;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Testing — operator queue</h1>
        <button className="btn btn-ghost" onClick={() => void testingAdmin.metrics().then(setMetrics)}>Load metrics</button>
      </div>

      {queue.operations_needing_attention.length > 0 && (
        <section className="panel">
          <h2>⚠ Operations needing attention</h2>
          <div className="rows">
            {queue.operations_needing_attention.map((op) => (
              <div key={op.id} className="row">
                <span className="row-label">{op.kind}</span>
                <span className="row-muted">{op.last_error ?? ''}</span>
                {op.order_id && <Link to={`/testing/admin/orders/${op.order_id}`}>order</Link>}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="panel">
        <h2>Intake review ({queue.intake_review.length})</h2>
        {queue.intake_review.length === 0 ? <p className="empty">No submitted requests.</p> : (
          <div className="rows">
            {queue.intake_review.map((r) => (
              <Link key={r.id} to={`/testing/admin/requests/${r.id}`} className="row">
                <span className="row-label">{r.id} (v{r.version})</span>
                <span className="row-muted">{r.source !== 'external_customer' ? r.source : ''}</span>
                <span className="row-date">{new Date(r.updated_at).toLocaleString()}</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="panel"><h2>Awaiting payment ({queue.awaiting_payment.length})</h2><OrderRows rows={queue.awaiting_payment} /></section>
      <section className="panel"><h2>Paid — awaiting task approval ({queue.awaiting_task_approval.length})</h2><OrderRows rows={queue.awaiting_task_approval} /></section>
      <section className="panel"><h2>Executing ({queue.executing.length})</h2><OrderRows rows={queue.executing} /></section>
      <section className="panel"><h2>Evidence review ({queue.evidence_review.length})</h2><OrderRows rows={queue.evidence_review} /></section>
      <section className="panel"><h2>Paused / blocked ({queue.paused_or_blocked.length})</h2><OrderRows rows={queue.paused_or_blocked} /></section>
      <section className="panel"><h2>Cancellation requested ({queue.cancel_requested.length})</h2><OrderRows rows={queue.cancel_requested} /></section>

      {metrics && (
        <section className="panel">
          <h2>Metrics (server records; founder/test work excluded from external demand)</h2>
          <pre className="code-block">{JSON.stringify(metrics, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}
