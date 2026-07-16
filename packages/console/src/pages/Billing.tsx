import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { control, ControlApiError } from '../api/control.js';
import type { BillingInfo } from '../api/types.js';

function errText(err: unknown): string {
  if (err instanceof ControlApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

const PLAN_LABEL: Record<BillingInfo['plan'], string> = {
  free: 'Free',
  pro: 'Pro',
  team: 'Team',
};

/**
 * /settings/billing — plan, usage, Upgrade (Stripe Checkout), Manage (Stripe
 * Customer Portal — card changes, cancellation, invoices all live there; no
 * custom subscription UI here by design).
 */
export default function Billing() {
  const [params] = useSearchParams();
  const [info, setInfo] = useState<BillingInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkoutResult = params.get('checkout'); // success | canceled | null

  useEffect(() => {
    control.getBilling().then(setInfo).catch((err) => setError(errText(err)));
  }, [checkoutResult]);

  async function go(fn: () => Promise<{ url: string }>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { url } = await fn();
      window.location.assign(url);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  if (!info) {
    return <div className="page">{error ? <div className="banner banner-error">{error}</div> : <p className="muted">Loading…</p>}</div>;
  }

  const isPro = info.plan !== 'free';
  const unlimited = info.entitlements.max_agents === null;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Billing</h1>
      </div>
      <p className="page-lede">
        Local is free — the vault, CLI, and MCP server always run without a plan. Hosted
        coordination is what's paid: the Free tier covers 3 delegated agents; Pro is unlimited.
        Revoking and the kill switch are never paywalled.
      </p>

      {checkoutResult === 'success' && (
        <div className="banner banner-warn">
          Payment received — your plan updates within a few seconds once Stripe confirms. Refresh
          if this page still shows Free.
        </div>
      )}
      {checkoutResult === 'canceled' && <div className="banner banner-warn">Checkout canceled — nothing changed.</div>}
      {error && <div className="banner banner-error">{error}</div>}

      <section className="panel">
        <h2>Current plan</h2>
        <div className="kv">
          <span className="kv-key">Plan</span>
          <span>
            <strong>{PLAN_LABEL[info.plan]}</strong>
            {info.plan_status !== 'active' && (
              <span className="status status-denied" style={{ marginLeft: '0.6rem' }}>{info.plan_status.replace('_', ' ')}</span>
            )}
          </span>
        </div>
        <div className="kv">
          <span className="kv-key">Agents</span>
          <span>
            {info.active_agents} of {unlimited ? 'unlimited' : info.entitlements.max_agents}
          </span>
        </div>
        <div className="kv">
          <span className="kv-key">Timeline retention</span>
          <span>{info.entitlements.retention_days} days</span>
        </div>
        {info.current_period_end && (
          <div className="kv">
            <span className="kv-key">Renews</span>
            <span>{new Date(info.current_period_end).toLocaleDateString()}</span>
          </div>
        )}
        {info.plan_status === 'past_due' && (
          <p className="muted panel-note">
            Your last payment failed. Existing agents, grants, revocation, and the kill switch all
            keep working; adding agents and approving new grants is limited to the Free tier until
            payment succeeds. Update your card via Manage billing.
          </p>
        )}
      </section>

      {!info.billing_configured ? (
        <section className="panel">
          <h2>Upgrade</h2>
          <p className="muted panel-note">Billing is not configured on this deployment.</p>
        </section>
      ) : isPro ? (
        <section className="panel">
          <h2>Manage</h2>
          <p className="muted panel-note">
            Card changes, invoices, and cancellation are handled in the Stripe customer portal.
          </p>
          <button className="btn btn-primary" disabled={busy} onClick={() => void go(() => control.billingPortal())}>
            {busy ? 'Opening…' : 'Manage billing'}
          </button>
        </section>
      ) : (
        <section className="panel">
          <h2>Upgrade to Pro</h2>
          <p className="muted panel-note">
            Unlimited agents · 1-year timeline retention · anomaly flags · hosted burn/rotate
            orchestration when the Provisioner ships.
          </p>
          <div className="btn-row">
            <button className="btn btn-primary" disabled={busy} onClick={() => void go(() => control.billingCheckout('monthly'))}>
              {busy ? 'Opening…' : '$10 / month'}
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => void go(() => control.billingCheckout('yearly'))}>
              $96 / year (2 months free)
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
