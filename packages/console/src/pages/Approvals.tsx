import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { control, ControlApiError } from '../api/control.js';
import { approveRequest } from '../lib/approve.js';
import { useOwner } from '../state/session.js';
import type { KeyringRequest, GrantConstraints } from '../api/types.js';

function errText(err: unknown): string {
  if (err instanceof ControlApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function isPlanLimit(err: unknown): boolean {
  return err instanceof ControlApiError && err.status === 402;
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id;
}

function constraintChips(c: GrantConstraints): string[] {
  const out: string[] = [];
  if (c.project) out.push(`project: ${c.project}`);
  if (c.max_uses !== undefined) out.push(`max ${c.max_uses} use${c.max_uses === 1 ? '' : 's'}`);
  if (c.max_lease_ttl_seconds !== undefined) out.push(`lease ≤ ${c.max_lease_ttl_seconds}s`);
  if (c.expires_at) out.push(`expires ${c.expires_at.slice(0, 10)}`);
  if (out.length === 0) out.push('no constraints');
  return out;
}

export default function Approvals() {
  const { owner, refresh } = useOwner();
  const [requests, setRequests] = useState<KeyringRequest[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { requests } = await control.listRequests();
      setRequests(requests);
    } catch (err) {
      setError(errText(err));
      setRequests([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onApprove(req: KeyringRequest): Promise<void> {
    if (!owner) return;
    setBusyId(req.id);
    setError(null);
    setLimitHit(null);
    try {
      // Full ceremony (lib/approve.ts): mint the passkey if this is the very
      // first approval, verify WYSIWYS, assert, submit.
      const { minted } = await approveRequest(owner, req.id);
      if (minted) await refresh();
      await load();
    } catch (err) {
      if (isPlanLimit(err)) setLimitHit(errText(err));
      else setError(errText(err));
    } finally {
      setBusyId(null);
    }
  }

  async function onDeny(req: KeyringRequest): Promise<void> {
    const reason = window.prompt(`Deny ${req.credential_label ?? req.credential_id} for ${shortId(req.agent_id)}?\nOptional reason:`);
    if (reason === null) return; // cancelled
    setBusyId(req.id);
    setError(null);
    try {
      await control.deny(req.id, reason.trim() || undefined);
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusyId(null);
    }
  }

  if (requests === null) {
    return <div className="page"><p className="muted">Loading approvals…</p></div>;
  }

  const pending = requests.filter((r) => r.status === 'pending');
  const decided = requests.filter((r) => r.status !== 'pending').slice(0, 10);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Approvals</h1>
        <button className="btn btn-ghost" onClick={() => void load()} disabled={busyId !== null}>Refresh</button>
      </div>
      <p className="page-lede">
        Each request is a credential your agent asked for. Approving signs a fresh passkey assertion
        bound to the exact grant; your local vault daemon re-verifies it and seals the secret.
        Nothing here can read a secret.
      </p>

      {owner && !owner.has_passkey && pending.length > 0 && (
        <div className="banner banner-warn">
          Your first approval creates your passkey — the browser will prompt you once, then ask
          you to sign with it.
        </div>
      )}
      {error && <div className="banner banner-error">{error}</div>}
      {limitHit && (
        <div className="banner banner-warn">
          {limitHit}{' '}
          <Link className="link" to="/settings/billing">Upgrade to Pro →</Link>
        </div>
      )}

      {pending.length === 0 ? (
        <div className="empty">
          <p>No pending requests.</p>
          <p className="muted">When an agent runs <code>keyring_request</code>, it shows up here.</p>
        </div>
      ) : (
        <ul className="cards">
          {pending.map((req) => (
            <li key={req.id} className="card">
              <div className="card-main">
                <div className="card-title">
                  {req.credential_label ?? req.credential_id}
                  {req.provider && <span className="pill">{req.provider}</span>}
                </div>
                <div className="card-meta">
                  <span>to agent <code title={req.agent_id}>{shortId(req.agent_id)}</code></span>
                  <span className="dot">·</span>
                  <span>{new Date(req.created_at).toLocaleString()}</span>
                </div>
                {req.note && <p className="card-note">“{req.note}”</p>}
                <div className="chips">
                  {constraintChips(req.constraints).map((c) => (
                    <span key={c} className="chip">{c}</span>
                  ))}
                </div>
              </div>
              <div className="card-actions">
                <button
                  className="btn btn-primary"
                  disabled={busyId !== null}
                  onClick={() => void onApprove(req)}
                >
                  {busyId === req.id ? 'Waiting for passkey…' : 'Approve with passkey'}
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={busyId !== null}
                  onClick={() => void onDeny(req)}
                >
                  Deny
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {decided.length > 0 && (
        <section className="decided">
          <h2>Recently decided</h2>
          <ul className="rows">
            {decided.map((req) => (
              <li key={req.id} className="row">
                <span className={`status status-${req.status}`}>{req.status}</span>
                <span className="row-label">{req.credential_label ?? req.credential_id}</span>
                <code className="muted">{shortId(req.agent_id)}</code>
                {req.status === 'approved' && (
                  <span className="row-hint muted">waiting for <code>based sync</code> to seal</span>
                )}
                {req.status === 'denied' && req.deny_reason && (
                  <span className="row-hint muted">{req.deny_reason}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
