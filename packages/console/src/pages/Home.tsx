/**
 * /home — the novice home (onboarding redesign Move 5).
 *
 * One card per agent: what it's asking for (Allow / Don't allow), what it can
 * use, recent activity, and the kill switch. Card titles link to the agent's
 * own page (/agents/:agentId — the sidebar lists the same pages), where each
 * key gets a "…" menu for rotate/remove. Data and actions live in
 * lib/agentActions.ts, shared with that page.
 *
 * The FIRST Allow mints the passkey (lib/approve.ts): the browser's creation
 * prompt fires at the exact moment the user first exercises authority, which
 * is when it makes sense to them.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { control } from '../api/control.js';
import type { OwnerTask } from '../api/types.js';
import { useOwner } from '../state/session.js';
import { askPhrase } from '../lib/outcomes.js';
import { fmtDate } from '../components/TaskBits.js';
import AddAgentGuide from '../components/AddAgentGuide.js';
import {
  agentDisplayName,
  holdingsFor,
  killReport,
  latestOpFor,
  recentlyKilled,
  rotatableFor,
  useAgentData,
} from '../lib/agentActions.js';

export default function Home() {
  const { owner } = useOwner();
  const {
    requests, connections, facts, busy, error, atLimit,
    load, allow, dontAllow, rotate, remove, kill,
  } = useAgentData();

  if (!owner) return null; // Protected route guarantees a session.
  const agents = owner.delegations.filter((d) => d.status === 'active');
  const killed = recentlyKilled(owner.delegations);
  const pendingAsks = requests.filter((r) => r.status === 'pending').length;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Overview</h1>
        <button className="btn btn-ghost" onClick={() => void load()} disabled={busy !== null}>
          Refresh
        </button>
      </div>

      {/* "What needs me?" — ordered by consequence: money owed, then work to
          review, then access requests blocking an agent. */}
      <NeedsYou pendingAsks={pendingAsks} />

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

      <h2 className="page-subhead" id="agents">Your agents</h2>
      {agents.length === 0 ? (
        <div className="empty empty-guide">
          <p>No agent is connected to this account yet — you don&rsquo;t need one to post work.</p>
          <div className="btn-row" style={{ justifyContent: 'center', marginBottom: '1rem' }}>
            <Link to="/tasks/new" className="btn btn-primary">Post a task</Link>
            <Link to="/explore" className="btn btn-ghost">Browse open tasks</Link>
          </div>
          <p className="muted">Or link an agent to run work and manage its keys:</p>
          <AddAgentGuide />
        </div>
      ) : (
        <ul className="cards">
          {agents.map((d) => {
            const asking = requests.filter((r) => r.agent_id === d.agent_id && r.status === 'pending');
            const holdings = holdingsFor(d.agent_id, connections, requests);
            const activity = requests
              .filter((r) => r.agent_id === d.agent_id && r.status !== 'pending')
              .slice(0, 5);
            return (
              <li key={d.id} className="card agent-card">
                <div className="card-main">
                  <div className="card-title">
                    <Link className="card-title-link" to={`/agents/${encodeURIComponent(d.agent_id)}`}>
                      {agentDisplayName(d)}
                    </Link>
                  </div>
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
                          onClick={() => void allow(req)}
                        >
                          {busy === req.id ? 'Waiting…' : 'Allow'}
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={busy !== null}
                          onClick={() => void dontAllow(req)}
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
                        const rot = latestOpFor('rotate', d.agent_id, h.localId, connections);
                        const rotating = rot !== undefined && (rot.status === 'pending' || rot.status === 'processing');
                        const rotatable = rotatableFor(h, facts);
                        // Remove works for ANY key with a machine-local id —
                        // minted or pasted (pasted just revokes + drops).
                        const rem = latestOpFor('remove', d.agent_id, h.localId, connections);
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
                                onClick={() => void rotate(d, h)}
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
                                onClick={() => void remove(d, h)}
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
                    onClick={() => void kill(d)}
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

/**
 * The action queue: what needs the human, ordered by consequence — money owed,
 * then deliveries to review, then access requests blocking an agent. Renders
 * nothing while loading or when the queue is empty (the sections below carry
 * the rest), so a caught-up account isn't shown an empty box.
 */
function NeedsYou({ pendingAsks }: { pendingAsks: number }) {
  const [tasks, setTasks] = useState<OwnerTask[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    control.tasks('all')
      .then((r) => { if (!cancelled) setTasks(r.tasks); })
      .catch(() => { if (!cancelled) setTasks([]); });
    return () => { cancelled = true; };
  }, []);

  if (tasks === null) return null;
  const paymentDue = tasks.filter((t) => t.payment_due);
  const awaitingReview = tasks.filter((t) => t.needs_review);
  if (paymentDue.length === 0 && awaitingReview.length === 0 && pendingAsks === 0) return null;

  return (
    <section className="needs-you">
      <h2 className="page-subhead" style={{ marginTop: 0 }}>Needs you</h2>
      <ul className="queue">
        {paymentDue.map((t) => (
          <li key={`pay-${t.task_id}`} className="queue-item">
            <span className="queue-tag queue-tag-pay">Payment due</span>
            <Link to={`/tasks/${encodeURIComponent(t.task_id)}`} className="queue-title">{t.title}</Link>
            {t.bounty && <span className="queue-amount">{t.bounty.amount_display} {t.bounty.token}</span>}
            <Link to={`/tasks/${encodeURIComponent(t.task_id)}`} className="btn btn-primary btn-sm">Pay</Link>
          </li>
        ))}
        {awaitingReview.map((t) => (
          <li key={`rev-${t.task_id}`} className="queue-item">
            <span className="queue-tag queue-tag-review">Awaiting review</span>
            <Link to={`/tasks/${encodeURIComponent(t.task_id)}`} className="queue-title">{t.title}</Link>
            {t.latest_receipt && <span className="muted queue-meta">delivered {fmtDate(t.latest_receipt.completed_at)}</span>}
            <Link to={`/tasks/${encodeURIComponent(t.task_id)}`} className="btn btn-primary btn-sm">Review</Link>
          </li>
        ))}
        {pendingAsks > 0 && (
          <li className="queue-item">
            <span className="queue-tag queue-tag-access">Access</span>
            <a href="#agents" className="queue-title">
              {pendingAsks} access request{pendingAsks === 1 ? '' : 's'} from your agents
            </a>
            <a href="#agents" className="btn btn-ghost btn-sm">Review below</a>
          </li>
        )}
      </ul>
    </section>
  );
}
