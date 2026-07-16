/**
 * /welcome — the connect cards (onboarding redesign Move 3) + the done screen.
 *
 * Each card: deep link to the provider's token page, three visual steps, one
 * paste field with a shape check. The paste is SEALED IN THIS BROWSER to the
 * vault key on the user's machine (lib/seal.ts) — this site only ever relays
 * ciphertext. The terminal (still running `init`, or a later `based sync`)
 * opens it locally, checks it against the provider, stores it, and the card
 * flips to ✓ when the poll sees the confirmation.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { control, ControlApiError } from '../api/control.js';
import { useOwner } from '../state/session.js';
import { sealForOwner } from '../lib/seal.js';
import { funnelPing } from '../lib/funnel.js';
import { PROVIDER_CARDS } from '../lib/providerCards.js';
import type { ProviderCard } from '../lib/providerCards.js';
import type { ConnectionInfo } from '../api/types.js';

const POLL_MS = 2500;

interface WelcomeState {
  agentId?: string;
  agentName?: string | null;
  planBlocked?: { active: number; max: number } | null;
}

type CardPhase =
  | { kind: 'idle' }
  | { kind: 'open'; token: string; shapeWarn: boolean }
  | { kind: 'sending' }
  | { kind: 'waiting'; connectionId: string }
  | { kind: 'connected' }
  | { kind: 'failed'; reason: string };

function errText(err: unknown): string {
  if (err instanceof ControlApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function ConnectCard({
  card,
  phase,
  onOpen,
  onToken,
  onSubmit,
  onRetry,
}: {
  card: ProviderCard;
  phase: CardPhase;
  onOpen: () => void;
  onToken: (token: string) => void;
  onSubmit: () => void;
  onRetry: () => void;
}) {
  return (
    <li className={`connect-card${phase.kind === 'connected' ? ' connect-card-done' : ''}`}>
      <div className="connect-head">
        <span className="connect-name">{card.label}</span>
        {phase.kind === 'connected' && <span className="connect-ok">✓ Connected</span>}
        {phase.kind === 'waiting' && <span className="connect-wait">Storing on your machine…</span>}
      </div>

      {phase.kind === 'idle' && (
        <button className="btn btn-primary" onClick={onOpen}>
          Connect {card.label}
        </button>
      )}

      {phase.kind === 'open' && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <ol className="connect-steps">
            {card.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <label className="field">
            <input
              type="password"
              value={phase.token}
              onChange={(ev) => onToken(ev.target.value)}
              placeholder={card.placeholder}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
            {phase.shapeWarn && <span className="field-hint connect-warn">{card.hint}</span>}
          </label>
          <button className="btn btn-primary" type="submit" disabled={phase.token.trim() === ''}>
            Connect
          </button>
          <p className="field-hint">
            What you paste is locked to your machine before it leaves this page — this site
            cannot read it.
          </p>
        </form>
      )}

      {phase.kind === 'sending' && <p className="muted">Sending…</p>}

      {phase.kind === 'waiting' && (
        <p className="field-hint">
          The terminal window where you ran setup is storing this now. If you closed it, run{' '}
          <code>based sync</code> there.
        </p>
      )}

      {phase.kind === 'failed' && (
        <>
          <div className="banner banner-error">{phase.reason}</div>
          <button className="btn btn-ghost" onClick={onRetry}>
            Try again
          </button>
        </>
      )}
    </li>
  );
}

export default function Welcome() {
  const { owner } = useOwner();
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state ?? {}) as WelcomeState;

  // Direct visits (no router state) fall back to the newest active connection
  // between this account and an agent — the one the claim just created.
  const agentId = useMemo(() => {
    if (state.agentId) return state.agentId;
    const active = (owner?.delegations ?? []).filter((d) => d.status === 'active');
    return active.length > 0 ? active[active.length - 1].agent_id : null;
  }, [state.agentId, owner]);
  const agentName =
    state.agentName ??
    (owner?.delegations ?? []).find((d) => d.agent_id === agentId)?.label ??
    'your agent';

  const [phases, setPhases] = useState<Record<string, CardPhase>>(
    () => Object.fromEntries(PROVIDER_CARDS.map((c) => [c.id, { kind: 'idle' } as CardPhase])),
  );
  const [error, setError] = useState<string | null>(null);
  const phasesRef = useRef(phases);
  phasesRef.current = phases;

  const setPhase = useCallback((cardId: string, phase: CardPhase) => {
    setPhases((p) => ({ ...p, [cardId]: phase }));
  }, []);

  // One shared poll while any card is waiting on the user's machine.
  useEffect(() => {
    const waiting = Object.values(phases).some((p) => p.kind === 'waiting');
    if (!waiting) return;
    const timer = setInterval(() => {
      void control.listConnections().then(({ connections }) => {
        const byId = new Map<string, ConnectionInfo>(connections.map((c) => [c.id, c]));
        for (const [cardId, phase] of Object.entries(phasesRef.current)) {
          if (phase.kind !== 'waiting') continue;
          const conn = byId.get(phase.connectionId);
          if (!conn) continue;
          if (conn.status === 'stored') {
            setPhase(cardId, { kind: 'connected' });
            funnelPing('provider_connected', conn.provider);
          }
          if (conn.status === 'failed') {
            setPhase(cardId, { kind: 'failed', reason: conn.failure_reason ?? 'That didn’t work — check the token and try again.' });
          }
        }
      }).catch(() => { /* transient — next tick retries */ });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [phases, setPhase]);

  async function submit(card: ProviderCard): Promise<void> {
    const phase = phasesRef.current[card.id];
    if (phase.kind !== 'open' || !owner || !agentId) return;
    const token = phase.token.trim();
    if (!card.looksValid(token)) {
      setPhase(card.id, { ...phase, shapeWarn: true });
      return;
    }
    setPhase(card.id, { kind: 'sending' });
    setError(null);
    try {
      const sealed = sealForOwner(owner.owner_id, token);
      const { id } = await control.createConnection({
        agent_id: agentId,
        provider: card.id,
        label: card.label,
        env_var: card.envVar,
        sealed_secret: sealed,
      });
      setPhase(card.id, { kind: 'waiting', connectionId: id });
    } catch (err) {
      setPhase(card.id, { kind: 'failed', reason: errText(err) });
    }
  }

  const connectedCount = Object.values(phases).filter((p) => p.kind === 'connected').length;

  if (!owner) return null; // Protected route guarantees a session.

  return (
    <div className="page">
      <h1>{agentName} is yours</h1>
      {state.planBlocked ? (
        <div className="banner banner-warn">
          Your plan already has {state.planBlocked.max} agents, so this one isn&rsquo;t active yet.{' '}
          <Link className="link" to="/settings/billing">Upgrade to add it →</Link>
        </div>
      ) : (
        <p className="page-lede">
          Give it something to work with. Connect a service below — you stay in control and can
          cut it off anytime.
        </p>
      )}

      {error && <div className="banner banner-error">{error}</div>}

      {/* When the claim was plan-blocked the agent has no active connection, so
          a connect attempt would fail server-side AFTER the user minted a real
          token — don't show the cards at all until it's active. */}
      {state.planBlocked ? (
        <div className="empty">
          <p>Connecting a service unlocks once this agent is active.</p>
          <p className="muted">Switch it on from your plan, then come back here.</p>
        </div>
      ) : agentId ? (
        <ul className="connect-grid">
          {PROVIDER_CARDS.map((card) => (
            <ConnectCard
              key={card.id}
              card={card}
              phase={phases[card.id]}
              onOpen={() => {
                window.open(card.tokenUrl, '_blank', 'noopener');
                setPhase(card.id, { kind: 'open', token: '', shapeWarn: false });
              }}
              onToken={(token) => setPhase(card.id, { kind: 'open', token, shapeWarn: false })}
              onSubmit={() => void submit(card)}
              onRetry={() => setPhase(card.id, { kind: 'open', token: '', shapeWarn: false })}
            />
          ))}
        </ul>
      ) : (
        <div className="empty">
          <p>No agent is connected to this account yet.</p>
          <p className="muted">Run the setup command in your terminal first:</p>
          <div className="code-block cmd">npx @basedagents/keyring init</div>
        </div>
      )}

      <div className="panel welcome-done">
        <h2>{connectedCount > 0 ? 'You’re set' : 'Good to know'}</h2>
        <p className="panel-note">
          {agentName} can only use what you connect here, every use is recorded, and the{' '}
          <strong>kill switch</strong> on your home page cuts off everything at once — no
          questions asked.
        </p>
        <button className="btn btn-primary" onClick={() => navigate('/home')}>
          {connectedCount > 0 ? 'Done — take me home' : 'Skip for now'}
        </button>
      </div>
    </div>
  );
}
