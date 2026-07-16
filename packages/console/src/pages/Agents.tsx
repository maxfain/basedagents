import { useState } from 'react';
import { Link } from 'react-router-dom';
import { control, ControlApiError } from '../api/control.js';
import { runAction } from '../lib/ceremony.js';
import { useOwner } from '../state/session.js';

function errText(err: unknown): string {
  if (err instanceof ControlApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function isPlanLimit(err: unknown): boolean {
  return err instanceof ControlApiError && err.status === 402;
}

function shortId(id: string): string {
  return id.length > 22 ? `${id.slice(0, 14)}…${id.slice(-5)}` : id;
}

/**
 * Delegations manager — the owner→agent edges (CONTROL_PLANE.md increment 1).
 * An agent can only *request* credentials once it is delegated to you, and an
 * approval can only be armed for a delegated agent. Create/revoke are both
 * passkey ceremonies; there is no daemon re-check for these edges, so the
 * ceremony helper's client-side WYSIWYS check is load-bearing here.
 */
export default function Agents() {
  const { owner, refresh } = useOwner();
  const [agentId, setAgentId] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null); // 'create' | delegation id
  const [error, setError] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState<string | null>(null);

  if (!owner) return null; // Protected route guarantees a session; satisfies TS.
  const delegations = owner.delegations;

  async function onCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!owner) return;
    const agent = agentId.trim();
    const lbl = label.trim() || null;
    setBusy('create');
    setError(null);
    setLimitHit(null);
    try {
      // Ceremony params mirror the server canonical exactly: {agent_id, label}.
      const { nonce, assertion } = await runAction(owner.owner_id, 'create_delegation', {
        agent_id: agent,
        label: lbl,
      });
      await control.createDelegation(agent, lbl, nonce, assertion);
      setAgentId('');
      setLabel('');
      await refresh();
    } catch (err) {
      // 402 plan_limit is not an error state — it's the upgrade moment.
      if (isPlanLimit(err)) setLimitHit(errText(err));
      else setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  async function onRevoke(delegationId: string, agentRef: string): Promise<void> {
    if (!owner) return;
    if (!window.confirm(`Revoke the delegation for ${agentRef}? The agent can no longer request credentials.`)) return;
    setBusy(delegationId);
    setError(null);
    try {
      const { nonce, assertion } = await runAction(owner.owner_id, 'revoke_delegation', {
        delegation_id: delegationId,
      });
      await control.revokeDelegation(delegationId, nonce, assertion);
      await refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  const active = delegations.filter((d) => d.status === 'active');
  const revoked = delegations.filter((d) => d.status !== 'active');

  return (
    <div className="page">
      <div className="page-head">
        <h1>Agents</h1>
      </div>
      <p className="page-lede">
        Delegating an agent lets it request credentials from your vault. Every delegation and
        revocation is a passkey signature over that exact edge, recorded on your authority chain.
      </p>

      {error && <div className="banner banner-error">{error}</div>}
      {limitHit && (
        <div className="banner banner-warn">
          {limitHit}{' '}
          <Link className="link" to="/settings/billing">Upgrade to Pro →</Link>
        </div>
      )}

      <form onSubmit={onCreate} className="form form-inline">
        <label className="field">
          <span className="field-label">Agent ID</span>
          <input
            type="text"
            value={agentId}
            onChange={(ev) => setAgentId(ev.target.value)}
            placeholder="ag_…  (from the BasedAgents registry)"
            spellCheck={false}
            required
          />
        </label>
        <label className="field">
          <span className="field-label">Label <span className="muted">(optional)</span></span>
          <input
            type="text"
            value={label}
            onChange={(ev) => setLabel(ev.target.value)}
            placeholder="ci-bot"
          />
        </label>
        <button className="btn btn-primary" type="submit" disabled={busy !== null}>
          {busy === 'create' ? 'Waiting for passkey…' : 'Delegate with passkey'}
        </button>
      </form>

      {active.length === 0 ? (
        <div className="empty">
          <p>No delegated agents yet.</p>
          <p className="muted">Delegate an agent above, then it can file credential requests.</p>
        </div>
      ) : (
        <ul className="rows rows-spaced">
          {active.map((d) => (
            <li key={d.id} className="row">
              <span className="status status-approved">active</span>
              <span className="row-label">{d.label ?? shortId(d.agent_id)}</span>
              <code className="muted" title={d.agent_id}>{shortId(d.agent_id)}</code>
              <span className="muted row-date">{new Date(d.created_at).toLocaleDateString()}</span>
              <button
                className="btn btn-ghost btn-sm row-action"
                disabled={busy !== null}
                onClick={() => void onRevoke(d.id, d.label ?? d.agent_id)}
              >
                {busy === d.id ? 'Waiting…' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {revoked.length > 0 && (
        <section className="decided">
          <h2>Revoked</h2>
          <ul className="rows">
            {revoked.map((d) => (
              <li key={d.id} className="row row-muted">
                <span className="status status-denied">revoked</span>
                <span className="row-label">{d.label ?? shortId(d.agent_id)}</span>
                <code className="muted">{shortId(d.agent_id)}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
