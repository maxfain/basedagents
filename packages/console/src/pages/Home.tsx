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
import { askPhrase } from '../lib/outcomes.js';
import { AgentSetupPrompt } from '../components/AgentSetup.js';
import type { ConnectionInfo, CredentialFact, Delegation, KeyringRequest } from '../api/types.js';

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

/** Counts-only report the machine sent after executing a kill locally. */
function killReport(d: Delegation): { residuals: number; note?: string } | null {
  if (!d.daemon_kill_report) return null;
  try {
    const j = JSON.parse(d.daemon_kill_report) as { residuals?: number; note?: string };
    return { residuals: j.residuals ?? 0, note: j.note };
  } catch {
    return null;
  }
}

const SHOW_CONFIRMED_KILL_DAYS = 7;

/** Kill-switch cards worth showing: every unconfirmed cutoff, plus confirmed ones for a week. */
function recentlyKilled(delegations: Delegation[]): Delegation[] {
  return delegations.filter((d) => {
    if (d.status !== 'revoked') return false;
    if (!d.daemon_confirmed_at) return true; // the machine still owes the local half
    return Date.now() - Date.parse(d.daemon_confirmed_at) < SHOW_CONFIRMED_KILL_DAYS * 86_400_000;
  });
}

export default function Home() {
  const { owner, refresh } = useOwner();
  const [requests, setRequests] = useState<KeyringRequest[]>([]);
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [facts, setFacts] = useState<CredentialFact[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [atLimit, setAtLimit] = useState(false);

  const load = useCallback(async () => {
    try {
      const [reqs, conns, cf] = await Promise.all([
        control.listRequests(),
        control.listConnections(),
        control.listCredentialFacts(),
      ]);
      setRequests(reqs.requests);
      setConnections(conns.connections);
      setFacts(cf.facts);
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While a rotation is in flight on the user's machine, watch for the flip
  // to done/failed — the whole operation is usually a few seconds of API calls.
  useEffect(() => {
    const inFlight = connections.some(
      (c) => (c.kind === 'rotate' || c.kind === 'remove') && (c.status === 'pending' || c.status === 'processing'),
    );
    if (!inFlight) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [connections, load]);

  // Right after a kill, watch for the machine's confirmation (it lands on the
  // daemon's next sync round). Bounded to 10 minutes — after that the card's
  // "run the sync there" instruction is the path, not more polling.
  useEffect(() => {
    const waiting = (owner?.delegations ?? []).some(
      (d) => d.status === 'revoked' && !d.daemon_confirmed_at &&
        d.revoked_at != null && Date.now() - Date.parse(d.revoked_at) < 10 * 60 * 1000,
    );
    if (!waiting) return;
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [owner, refresh]);

  if (!owner) return null; // Protected route guarantees a session.
  const agents = owner.delegations.filter((d) => d.status === 'active');
  const killed = recentlyKilled(owner.delegations);

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

  async function onRotate(
    d: Delegation,
    h: { label: string; provider: string; localId: string | null },
  ): Promise<void> {
    if (!h.localId) return;
    const name = agentDisplayName(d);
    if (!window.confirm(
      `Rotate the ${h.label} key? Your machine mints a fresh key and destroys the old one at ${h.provider}. ${name} switches to the new key automatically.`,
    )) return;
    setBusy(`rotate-${h.localId}`);
    setError(null);
    try {
      await control.createConnection({
        agent_id: d.agent_id,
        provider: h.provider,
        label: h.label,
        kind: 'rotate',
        rotate_credential_id: h.localId,
      });
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  async function onRemove(
    d: Delegation,
    h: { label: string; provider: string; localId: string | null },
  ): Promise<void> {
    if (!h.localId) return;
    const name = agentDisplayName(d);
    if (!window.confirm(
      `Remove ${h.label} from ${name}? Your machine cuts off this one key — it stops working for ${name}, and if nothing else uses it, it's destroyed at ${h.provider || 'the provider'}. Everything else stays.`,
    )) return;
    setBusy(`remove-${h.localId}`);
    setError(null);
    try {
      await control.createConnection({
        agent_id: d.agent_id,
        provider: h.provider,
        label: h.label,
        kind: 'remove',
        rotate_credential_id: h.localId,
      });
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
            // Everything this agent can use, with enough metadata to offer
            // per-key rotation/removal: stored rows carry the machine-local id
            // they created; approved asks carry theirs. Rotate/remove rows are
            // operations on an existing key, never holdings themselves.
            const holdings = [
              ...connections
                .filter((c) => c.agent_id === d.agent_id && c.status === 'stored' && c.kind !== 'rotate' && c.kind !== 'remove')
                .map((c) => ({
                  key: `conn-${c.id}`,
                  label: c.label ?? c.provider,
                  provider: c.provider,
                  localId: c.daemon_credential_id ?? null,
                })),
              ...requests
                .filter((r) => r.agent_id === d.agent_id && r.status === 'approved')
                .map((r) => ({
                  key: `req-${r.id}`,
                  label: r.credential_label ?? r.credential_id,
                  provider: r.provider ?? '',
                  localId: r.credential_id ?? null,
                })),
            ];
            const rotations = connections.filter((c) => c.agent_id === d.agent_id && c.kind === 'rotate');
            const rotationFor = (localId: string | null) =>
              localId === null
                ? undefined
                : rotations
                    .filter((c) => c.daemon_credential_id === localId)
                    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
            const removals = connections.filter((c) => c.agent_id === d.agent_id && c.kind === 'remove');
            const removalFor = (localId: string | null) =>
              localId === null
                ? undefined
                : removals
                    .filter((c) => c.daemon_credential_id === localId)
                    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
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

                  {asking.map((req) => {
                    const ask = askPhrase(req.provider, req.credential_label ?? req.credential_id);
                    return (
                    <div key={req.id} className="asking">
                      <span className="asking-text">
                        Wants to <strong>{ask.action}</strong>
                        {ask.via && (
                          <span className="muted"> · {ask.via} ({req.credential_label ?? req.credential_id})</span>
                        )}
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
                    );
                  })}

                  <div className="chips">
                    {holdings.length === 0 ? (
                      <span className="chip chip-empty">Can&rsquo;t use anything yet</span>
                    ) : (
                      holdings.map((h) => {
                        const rot = rotationFor(h.localId);
                        const rotating = rot !== undefined && (rot.status === 'pending' || rot.status === 'processing');
                        // The machine's own report decides: an affirmative
                        // rotatable:false hides the button (pasted/imported
                        // keys would only ever fail after the click). No fact
                        // at all — an old daemon — keeps the optimistic button.
                        const fact = h.localId === null ? undefined : facts.find((f) => f.credential_id === h.localId);
                        const rotatable = h.localId !== null
                          && (h.provider === 'vercel' || h.provider === 'supabase')
                          && fact?.rotatable !== false;
                        // Remove works for ANY key with a machine-local id —
                        // minted or pasted (pasted just revokes + drops).
                        const rem = removalFor(h.localId);
                        const removing = rem !== undefined && (rem.status === 'pending' || rem.status === 'processing');
                        const removable = h.localId !== null;
                        const acting = rotating || removing;
                        return (
                          <span key={h.key} className="chip">
                            Can use: {h.label}
                            {rotatable && (
                              <button
                                className="chip-action"
                                disabled={busy !== null || acting}
                                title={rot?.status === 'failed'
                                  ? (rot.failure_reason ?? 'The last rotation failed.')
                                  : 'Mint a fresh key and destroy the old one'}
                                onClick={() => void onRotate(d, h)}
                              >
                                {rotating ? 'Rotating…' : rot?.status === 'failed' ? 'Rotate ⚠' : 'Rotate'}
                              </button>
                            )}
                            {removable && (
                              <button
                                className="chip-action chip-action-danger"
                                disabled={busy !== null || acting}
                                title={rem?.status === 'failed'
                                  ? (rem.failure_reason ?? 'The last removal failed.')
                                  : 'Revoke this one key, and destroy it at the provider if nothing else uses it'}
                                onClick={() => void onRemove(d, h)}
                              >
                                {removing ? 'Removing…' : rem?.status === 'failed' ? 'Remove ⚠' : 'Remove'}
                              </button>
                            )}
                          </span>
                        );
                      })
                    )}
                  </div>

                  {activity.length > 0 && (
                    <ul className="mini-activity">
                      {activity.map((r) => (
                        <li key={r.id} className="muted">
                          {r.status === 'approved' ? 'Allowed' : r.status === 'revoked' ? 'Cut off' : 'Declined'}{' '}
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

      {killed.length > 0 && (
        <>
          <h2 className="page-subhead">Cut off</h2>
          <ul className="cards">
            {killed.map((d) => {
              const name = agentDisplayName(d);
              const report = killReport(d);
              return (
                <li key={d.id} className="card">
                  <div className="card-main">
                    <div className="card-title">{name}</div>
                    {!d.daemon_confirmed_at ? (
                      <p className="muted">
                        Cut off at the account — {name} can&rsquo;t ask for anything anymore.
                        Your machine finishes the cutoff the next time it syncs. If nothing is
                        running there, start it with:{' '}
                        <code>npx basedagents@latest keyring sync</code>
                      </p>
                    ) : report && report.note ? (
                      <p className="muted">
                        The machine that answered on{' '}
                        {new Date(d.daemon_confirmed_at).toLocaleString()} doesn&rsquo;t have{' '}
                        {name} set up. If it lives on another computer, finish the cutoff there:{' '}
                        <code>npx basedagents@latest keyring kill &quot;{name}&quot;</code>
                      </p>
                    ) : report && report.residuals > 0 ? (
                      <p className="muted">
                        Your machine confirmed the cutoff on{' '}
                        {new Date(d.daemon_confirmed_at).toLocaleString()}, but found{' '}
                        <strong>{report.residuals} other way{report.residuals === 1 ? '' : 's'}</strong>{' '}
                        that computer can still act as you — sign-ins that live outside this
                        system. See and fix them there with:{' '}
                        <code>npx basedagents@latest keyring doctor</code>
                      </p>
                    ) : (
                      <p className="muted">
                        ✓ Cut off everywhere. Your machine confirmed on{' '}
                        {new Date(d.daemon_confirmed_at).toLocaleString()} and found nothing
                        left behind.
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
