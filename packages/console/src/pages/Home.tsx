/**
 * /home — the novice home (onboarding redesign Move 5).
 *
 * One card per agent: what it's asking for (Allow / Don't allow), what it can
 * use, recent activity, and the kill switch. The full console still exists
 * behind "Advanced" (the Layout link) — this page is the whole product for
 * the base case, in base-case words.
 *
 * The FIRST Allow mints the passkey (lib/approve.ts): the browser's creation
 * prompt fires at the exact moment the user first exercises authority, which
 * is when it makes sense to them.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { useCallback, useEffect, useState } from 'react';
import { control, ControlApiError } from '../api/control.js';
import { useOwner } from '../state/session.js';
import { approveRequest } from '../lib/approve.js';
import { runAction } from '../lib/ceremony.js';
import { ensurePasskey } from '../lib/firstApproval.js';
import { AgentSetupPrompt } from '../components/AgentSetup.js';
import type { ConnectionInfo, Delegation, KeyringRequest } from '../api/types.js';

function errText(err: unknown): string {
  if (err instanceof ControlApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Over the plan's agent limit — a distinct, base-case-worded state (never the
 *  raw 402 message, which contains power-user vocabulary). */
function isPlanLimit(err: unknown): boolean {
  return err instanceof ControlApiError && err.status === 402;
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id;
}

function agentDisplayName(d: Delegation): string {
  return d.label ?? shortId(d.agent_id);
}

export default function Home() {
  const { owner, refresh } = useOwner();
  const [requests, setRequests] = useState<KeyringRequest[]>([]);
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [atLimit, setAtLimit] = useState(false);

  const load = useCallback(async () => {
    try {
      const [reqs, conns] = await Promise.all([control.listRequests(), control.listConnections()]);
      setRequests(reqs.requests);
      setConnections(conns.connections);
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!owner) return null; // Protected route guarantees a session.
  const agents = owner.delegations.filter((d) => d.status === 'active');

  async function onAllow(req: KeyringRequest): Promise<void> {
    if (!owner) return;
    setBusy(req.id);
    setError(null);
    setAtLimit(false);
    try {
      // refresh runs the instant a passkey is minted (see lib/approve.ts).
      await approveRequest(owner, req.id, refresh);
      await load();
    } catch (err) {
      if (isPlanLimit(err)) setAtLimit(true); // never render the raw 402 copy
      else setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  async function onDontAllow(req: KeyringRequest): Promise<void> {
    setBusy(req.id);
    setError(null);
    try {
      await control.deny(req.id);
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  async function onKill(d: Delegation): Promise<void> {
    if (!owner) return;
    const name = agentDisplayName(d);
    if (!window.confirm(`Cut off ${name}? It immediately loses the ability to ask for anything, and your machine drops its access on the next sync.`)) {
      return;
    }
    setBusy(d.id);
    setError(null);
    try {
      await ensurePasskey(owner);
      const { nonce, assertion } = await runAction(owner.owner_id, 'revoke_delegation', {
        delegation_id: d.id,
      });
      await control.revokeDelegation(d.id, nonce, assertion);
      await refresh();
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Your agents</h1>
        <button className="btn btn-ghost" onClick={() => void load()} disabled={busy !== null}>
          Refresh
        </button>
      </div>

      {error && <div className="banner banner-error">{error}</div>}
      {atLimit && (
        <div className="banner banner-warn">
          You&rsquo;re at your plan&rsquo;s limit for active agents, so this one can&rsquo;t be
          switched on yet.{' '}
          <a className="link" href="/settings/billing">See your plan →</a>
        </div>
      )}
      {!owner.has_passkey && agents.length > 0 && (
        <div className="banner banner-warn">
          The first time you allow something, your browser will ask you to create a passkey —
          that becomes your signature, and nothing moves without it.
        </div>
      )}

      {agents.length === 0 ? (
        <div className="empty">
          <p>No agent is connected to this account yet.</p>
          <p className="muted">Set it up — hand this to your agent, or run it yourself:</p>
          <AgentSetupPrompt />
        </div>
      ) : (
        <ul className="cards">
          {agents.map((d) => {
            const asking = requests.filter((r) => r.agent_id === d.agent_id && r.status === 'pending');
            const canUse = [
              ...connections
                .filter((c) => c.agent_id === d.agent_id && c.status === 'stored')
                .map((c) => c.label ?? c.provider),
              ...requests
                .filter((r) => r.agent_id === d.agent_id && r.status === 'approved')
                .map((r) => r.credential_label ?? r.credential_id),
            ];
            const activity = requests
              .filter((r) => r.agent_id === d.agent_id && r.status !== 'pending')
              .slice(0, 5);
            return (
              <li key={d.id} className="card agent-card">
                <div className="card-main">
                  <div className="card-title">{agentDisplayName(d)}</div>
                  <div className="card-meta">
                    <span>since {new Date(d.created_at).toLocaleDateString()}</span>
                  </div>

                  {asking.map((req) => (
                    <div key={req.id} className="asking">
                      <span className="asking-text">
                        Wants to use <strong>{req.credential_label ?? req.credential_id}</strong>
                        {req.note && <em className="muted"> — “{req.note}”</em>}
                      </span>
                      <span className="asking-actions">
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={busy !== null}
                          onClick={() => void onAllow(req)}
                        >
                          {busy === req.id ? 'Waiting…' : 'Allow'}
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={busy !== null}
                          onClick={() => void onDontAllow(req)}
                        >
                          Don&rsquo;t allow
                        </button>
                      </span>
                    </div>
                  ))}

                  <div className="chips">
                    {canUse.length === 0 ? (
                      <span className="chip chip-empty">Can&rsquo;t use anything yet</span>
                    ) : (
                      canUse.map((label, i) => (
                        <span key={`${label}-${i}`} className="chip">Can use: {label}</span>
                      ))
                    )}
                  </div>

                  {activity.length > 0 && (
                    <ul className="mini-activity">
                      {activity.map((r) => (
                        <li key={r.id} className="muted">
                          {r.status === 'approved' ? 'Allowed' : 'Declined'}{' '}
                          {r.credential_label ?? r.credential_id} ·{' '}
                          {new Date(r.decided_at ?? r.created_at).toLocaleString()}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="card-actions">
                  <button
                    className="btn btn-danger"
                    disabled={busy !== null}
                    onClick={() => void onKill(d)}
                  >
                    {busy === d.id ? 'Waiting…' : 'Kill switch'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
