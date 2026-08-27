/**
 * /agents/:agentId — one agent, in full: what it's asking for, everything it
 * can use (each key with a "…" menu for rotate/remove), recent activity, and
 * the cut-off button right in the header. The sidebar (components/Layout.tsx)
 * links here; /home stays the every-agent overview.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useOwner } from '../state/session.js';
import { askPhrase } from '../lib/outcomes.js';
import {
  agentDisplayName,
  holdingsFor,
  killReport,
  latestOpFor,
  rotatableFor,
  useAgentData,
  type Holding,
} from '../lib/agentActions.js';
import type { Delegation } from '../api/types.js';

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface MenuItem {
  key: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  onSelect: () => void;
}

/** The "…" dropdown on a key row. Closes on outside click and Escape. */
function RowMenu({ name, items }: { name: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(ev: MouseEvent) {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (items.length === 0) return null;
  return (
    <div className="rowmenu" ref={ref}>
      <button
        className="btn btn-ghost btn-sm rowmenu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Options for ${name}`}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <div className="rowmenu-pop" role="menu">
          {items.map((it) => (
            <button
              key={it.key}
              role="menuitem"
              className={it.danger ? 'rowmenu-item rowmenu-item-danger' : 'rowmenu-item'}
              disabled={it.disabled}
              title={it.title}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Post-kill status copy — same words as the /home cut-off cards. */
function KilledExplainer({ d }: { d: Delegation }) {
  const name = agentDisplayName(d);
  const report = killReport(d);
  if (!d.daemon_confirmed_at) {
    return (
      <p className="muted">
        Cut off at the account — {name} can&rsquo;t ask for anything anymore. Your machine finishes
        the cutoff the next time it syncs. If nothing is running there, start it with:{' '}
        <code>npx basedagents@latest keyring sync</code>
      </p>
    );
  }
  if (report && report.note) {
    return (
      <p className="muted">
        The machine that answered on {new Date(d.daemon_confirmed_at).toLocaleString()} doesn&rsquo;t
        have {name} set up. If it lives on another computer, finish the cutoff there:{' '}
        <code>npx basedagents@latest keyring kill &quot;{name}&quot;</code>
      </p>
    );
  }
  if (report && report.residuals > 0) {
    return (
      <p className="muted">
        Your machine confirmed the cutoff on {new Date(d.daemon_confirmed_at).toLocaleString()}, but
        found <strong>{report.residuals} other way{report.residuals === 1 ? '' : 's'}</strong> that
        computer can still act as you — sign-ins that live outside this system. See and fix them
        there with: <code>npx basedagents@latest keyring doctor</code>
      </p>
    );
  }
  return (
    <p className="muted">
      ✓ Cut off everywhere. Your machine confirmed on{' '}
      {new Date(d.daemon_confirmed_at).toLocaleString()} and found nothing left behind.
    </p>
  );
}

export default function AgentPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const { owner } = useOwner();
  const { requests, connections, facts, busy, error, atLimit, allow, dontAllow, rotate, remove, kill } =
    useAgentData();

  if (!owner || !agentId) return null; // Protected route guarantees a session.

  // Same agent id can carry several edges over time (cut off, then re-added):
  // show the active one when it exists, else the most recent.
  const edges = owner.delegations
    .filter((x) => x.agent_id === agentId)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const d = edges.find((x) => x.status === 'active') ?? edges[0];

  if (!d) {
    return (
      <div className="page">
        <div className="page-head">
          <h1>Not here</h1>
        </div>
        <p className="page-lede">
          No agent with this id is connected to your account. It may have been from another
          account, or the link is stale.
        </p>
        <p>
          <Link className="link" to="/agents/new">Add an agent →</Link>
        </p>
      </div>
    );
  }

  const name = agentDisplayName(d);
  const active = d.status === 'active';
  const asking = requests.filter((r) => r.agent_id === d.agent_id && r.status === 'pending');
  const holdings = holdingsFor(d.agent_id, connections, requests);
  const activity = requests
    .filter((r) => r.agent_id === d.agent_id && r.status !== 'pending')
    .slice(0, 8);

  function menuFor(dd: Delegation, h: Holding): MenuItem[] {
    const rot = latestOpFor('rotate', dd.agent_id, h.localId, connections);
    const rotating = rot !== undefined && (rot.status === 'pending' || rot.status === 'processing');
    const rem = latestOpFor('remove', dd.agent_id, h.localId, connections);
    const removing = rem !== undefined && (rem.status === 'pending' || rem.status === 'processing');
    const acting = rotating || removing;
    const items: MenuItem[] = [];
    if (rotatableFor(h, facts)) {
      items.push({
        key: 'rotate',
        label: rotating ? 'Rotating…' : rot?.status === 'failed' ? 'Get a fresh key ⚠' : 'Get a fresh key',
        disabled: busy !== null || acting,
        title: rot?.status === 'failed'
          ? (rot.failure_reason ?? 'The last rotation failed.')
          : 'Mint a fresh key and destroy the old one',
        onSelect: () => void rotate(dd, h),
      });
    }
    if (h.localId !== null) {
      items.push({
        key: 'remove',
        label: removing ? 'Removing…' : rem?.status === 'failed' ? 'Remove this key ⚠' : 'Remove this key',
        danger: true,
        disabled: busy !== null || acting,
        title: rem?.status === 'failed'
          ? (rem.failure_reason ?? 'The last removal failed.')
          : 'Revoke this one key, and destroy it at the provider if nothing else uses it',
        onSelect: () => void remove(dd, h),
      });
    }
    return items;
  }

  function stateTextFor(dd: Delegation, h: Holding): string | null {
    const rot = latestOpFor('rotate', dd.agent_id, h.localId, connections);
    if (rot && (rot.status === 'pending' || rot.status === 'processing')) return 'Getting a fresh key…';
    if (rot && rot.status === 'failed') return rot.failure_reason ?? 'The last rotation failed.';
    const rem = latestOpFor('remove', dd.agent_id, h.localId, connections);
    if (rem && (rem.status === 'pending' || rem.status === 'processing')) return 'Removing…';
    if (rem && rem.status === 'failed') return rem.failure_reason ?? 'The last removal failed.';
    return null;
  }

  return (
    <div className="page">
      <div className="page-head agent-head">
        <div>
          <h1>{name}</h1>
          <div className="card-meta">
            <span>since {new Date(d.created_at).toLocaleDateString()}</span>
            {!active && <span className="status status-denied">cut off</span>}
          </div>
        </div>
        {active && (
          <button className="btn btn-danger" disabled={busy !== null} onClick={() => void kill(d)}>
            {busy === d.id ? 'Waiting…' : `Cut off ${name}`}
          </button>
        )}
      </div>

      {error && <div className="banner banner-error">{error}</div>}
      {atLimit && (
        <div className="banner banner-warn">
          You&rsquo;re at your plan&rsquo;s limit for active agents, so this one can&rsquo;t be
          switched on yet.{' '}
          <Link className="link" to="/settings/billing">See your plan →</Link>
        </div>
      )}
      {active && !owner.has_passkey && (
        <div className="banner banner-warn">
          The first time you allow something, your browser will ask you to create a passkey —
          that becomes your signature, and nothing moves without it.
        </div>
      )}

      {!active ? (
        <div className="panel">
          <KilledExplainer d={d} />
        </div>
      ) : (
        <>
          {asking.length > 0 && (
            <section className="panel">
              <h2>Asking you now</h2>
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
            </section>
          )}

          <section className="panel">
            <h2>What {name} can use</h2>
            {holdings.length === 0 ? (
              <p className="muted">
                Nothing yet. When {name} needs something — putting a site live, using a database —
                it asks, and the ask shows up here for you to allow.
              </p>
            ) : (
              <ul className="rows rows-spaced">
                {holdings.map((h) => {
                  const ask = askPhrase(h.provider, h.label);
                  const state = stateTextFor(d, h);
                  return (
                    <li key={h.key} className="row tool-row">
                      <div className="tool-main">
                        <div className="tool-title">{cap(ask.action)}</div>
                        <div className="tool-sub">
                          {ask.via ? `${ask.via} · ` : ''}{h.label}
                          {state && <span className="tool-state"> · {state}</span>}
                        </div>
                      </div>
                      <RowMenu name={h.label} items={menuFor(d, h)} />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {activity.length > 0 && (
            <section className="panel">
              <h2>Recent activity</h2>
              <ul className="mini-activity">
                {activity.map((r) => (
                  <li key={r.id} className="muted">
                    {r.status === 'approved' ? 'Allowed' : r.status === 'revoked' ? 'Cut off' : 'Declined'}{' '}
                    {r.credential_label ?? r.credential_id} ·{' '}
                    {new Date(r.decided_at ?? r.created_at).toLocaleString()}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
