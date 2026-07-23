/**
 * /welcome — the live checklist (ICP redesign): three steps that tick
 * themselves off as the system observes them happen, so a base-case user
 * never wonders "did it work?".
 *
 *   1. Set up your agent          ✓ when an agent is active for this account
 *   2. Connect an account         ✓ when a connection is stored on their machine
 *   3. Say yes when it asks       ✓ when they've decided their first ask
 *
 * Step 2 keeps the connect cards: deep link to the provider's token page,
 * three visual steps, one paste field with a shape check. The paste is SEALED
 * IN THIS BROWSER to the vault key on the user's machine (lib/seal.ts) — this
 * site only ever relays ciphertext. The terminal (still running `init`, or a
 * later `based sync`) opens it locally, checks it against the provider,
 * stores it, and the card flips to ✓ when the poll sees the confirmation.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { control, ControlApiError } from '../api/control.js';
import { useOwner } from '../state/session.js';
import { sealForOwner } from '../lib/seal.js';
import { funnelPing } from '../lib/funnel.js';
import { askPhrase } from '../lib/outcomes.js';
import { AgentSetupPrompt, CopyBlock } from '../components/AgentSetup.js';
import { generateKeypair, openSealedBox } from '@basedagents/keyring/crypto';
import { base58Encode } from '@basedagents/keyring/util';
import { PROVIDER_CARDS } from '../lib/providerCards.js';
import type { ProviderCard } from '../lib/providerCards.js';
import type { ConnectionInfo, KeyringRequest } from '../api/types.js';

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
  | { kind: 'waiting'; connectionId: string; via?: 'seal' | 'provision'; slow?: boolean }
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
  onAuto,
  onToken,
  onSubmit,
  onRetry,
}: {
  card: ProviderCard;
  phase: CardPhase;
  onOpen: () => void;
  onAuto: () => void;
  onToken: (token: string) => void;
  onSubmit: () => void;
  onRetry: () => void;
}) {
  return (
    <li className={`connect-card${phase.kind === 'connected' ? ' connect-card-done' : ''}`}>
      <div className="connect-head">
        <span className="connect-name">{card.label}</span>
        {phase.kind === 'connected' && <span className="connect-ok">✓ Connected</span>}
        {phase.kind === 'waiting' && (
          <span className="connect-wait">
            {phase.via === 'provision' ? 'Working on your machine…' : 'Storing on your machine…'}
          </span>
        )}
      </div>

      {phase.kind === 'idle' && (
        card.automatic?.remote ? (
          <>
            <p className="field-hint">{card.automatic.blurb}</p>
            <div className="connect-actions">
              <button className="btn btn-primary" onClick={onAuto}>
                Do it for me
              </button>
              <button className="btn btn-ghost" onClick={onOpen}>
                Paste a token instead
              </button>
            </div>
            <p className="field-hint">
              or run <code>{card.automatic.command}</code> in a terminal on that computer.
            </p>
          </>
        ) : (
          <>
            {card.automatic && (
              <p className="field-hint">
                {card.automatic.blurb}
                <br />
                <code>{card.automatic.command}</code>
              </p>
            )}
            <button className="btn btn-primary" onClick={onOpen}>
              Connect {card.label}
            </button>
          </>
        )
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
        phase.via === 'provision' ? (
          <p className="field-hint">
            Asked the computer where your agent lives to connect. The first time, a browser
            window opens there — sign in if it asks, then watch it work. This flips to ✓ by
            itself.
            {phase.slow && (
              <>
                <br />
                Still waiting — is that computer awake, with setup running? You can also paste
                a token instead; nothing breaks.
              </>
            )}
          </p>
        ) : (
          <p className="field-hint">
            The terminal window where you ran setup is storing this now. If you closed it, run{' '}
            <code>based sync</code> there.
          </p>
        )
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
  const [serverConnections, setServerConnections] = useState<ConnectionInfo[]>([]);
  const [asks, setAsks] = useState<KeyringRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const phasesRef = useRef(phases);
  phasesRef.current = phases;

  const setPhase = useCallback((cardId: string, phase: CardPhase) => {
    setPhases((p) => ({ ...p, [cardId]: phase }));
  }, []);

  // One load for everything the checklist observes; also flips waiting cards
  // and hydrates cards for connections stored on an earlier visit.
  const load = useCallback(async () => {
    try {
      const [conns, reqs] = await Promise.all([control.listConnections(), control.listRequests()]);
      // Identity-preserving: unchanged payloads must not re-render the tree.
      const fp = (rows: ReadonlyArray<{ id: string; status: string }>) =>
        rows.map((r) => `${r.id}:${r.status}`).join('|');
      setServerConnections((prev) => (fp(prev) === fp(conns.connections) ? prev : conns.connections));
      setAsks((prev) => (fp(prev) === fp(reqs.requests) ? prev : reqs.requests));
      const byId = new Map<string, ConnectionInfo>(conns.connections.map((c) => [c.id, c]));
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
      // Hydrate idle cards from server state (idle only — never stomp an
      // in-progress card): a provider stored on a previous visit shows as
      // connected (no funnel ping — it already counted when it first stored),
      // and a provision request still being worked on resumes its waiting
      // state, so leaving and returning can't fire a duplicate request.
      for (const card of PROVIDER_CARDS) {
        if (phasesRef.current[card.id]?.kind !== 'idle') continue;
        const mine = conns.connections.filter((c) => c.agent_id === agentId && c.provider === card.id);
        if (mine.some((c) => c.status === 'stored')) {
          setPhase(card.id, { kind: 'connected' });
          continue;
        }
        const inflight = mine.find(
          (c) => c.kind === 'provision' && (c.status === 'pending' || c.status === 'processing'),
        );
        if (inflight) {
          setPhase(card.id, { kind: 'waiting', connectionId: inflight.id, via: 'provision' });
        }
      }
    } catch {
      /* transient — next tick retries */
    }
  }, [setPhase, agentId]);

  // The page ticks itself off: fetch immediately, then keep watching while
  // open. Each tick awaits the previous one, so slow responses can't overlap.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await load();
      if (alive) timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [load]);

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

  // "Do it for me": ask the machine where the agent lives to run the
  // Provisioner itself. No secret travels in either direction — the row is
  // just a request; the daemon mints, vaults, and confirms.
  async function submitProvision(card: ProviderCard): Promise<void> {
    if (!owner || !agentId) return;
    setPhase(card.id, { kind: 'sending' });
    setError(null);
    try {
      const { id } = await control.createConnection({
        agent_id: agentId,
        provider: card.id,
        kind: 'provision',
        label: card.label,
        env_var: card.envVar,
      });
      setPhase(card.id, { kind: 'waiting', connectionId: id, via: 'provision' });
      // After 30s with no news, add the "is that computer awake?" hint.
      setTimeout(() => {
        const p = phasesRef.current[card.id];
        if (p.kind === 'waiting' && p.connectionId === id && p.via === 'provision') {
          setPhase(card.id, { ...p, slow: true });
        }
      }, 30_000);
    } catch (err) {
      setPhase(card.id, { kind: 'failed', reason: errText(err) });
    }
  }

  // Cloud passport: sealed to THIS browser's ephemeral key; the value shown
  // for pasting into the workspace's Secrets never touches the server open.
  type PassportPhase =
    | { k: 'idle' }
    | { k: 'working'; id: string; priv: Uint8Array; slow?: boolean }
    | { k: 'ready'; blob: string }
    | { k: 'failed'; reason: string };
  const [pp, setPp] = useState<PassportPhase>({ k: 'idle' });

  async function startPassport(): Promise<void> {
    try {
      const kp = await generateKeypair();
      const { id } = await control.createPassport(base58Encode(kp.publicKey));
      setPp({ k: 'working', id, priv: kp.privateKey });
      setTimeout(() => {
        setPp((prev) => (prev.k === 'working' && prev.id === id ? { ...prev, slow: true } : prev));
      }, 30_000);
    } catch (err) {
      setPp({ k: 'failed', reason: errText(err) });
    }
  }

  useEffect(() => {
    if (pp.k !== 'working') return;
    const t = setInterval(() => {
      void control
        .getPassport(pp.id)
        .then((r) => {
          if (r.status === 'fulfilled' && r.sealed_passport) {
            const blob = new TextDecoder().decode(openSealedBox(pp.priv, r.sealed_passport));
            setPp({ k: 'ready', blob });
          } else if (r.status === 'consumed') {
            setPp({ k: 'failed', reason: 'That one was already used somewhere — start again.' });
          }
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [pp]);

  const connectedCount = Object.values(phases).filter((p) => p.kind === 'connected').length;

  if (!owner) return null; // Protected route guarantees a session.

  const agentAsks = asks.filter((r) => r.agent_id === agentId);
  const pendingAsks = agentAsks.filter((r) => r.status === 'pending');
  const step1Done = Boolean(agentId);
  const step2Done =
    connectedCount > 0 ||
    serverConnections.some((c) => c.agent_id === agentId && c.status === 'stored');
  const step3Done = agentAsks.some((r) => r.status !== 'pending');
  const allDone = step1Done && step2Done && step3Done;

  const stepClass = (done: boolean, active: boolean) =>
    `check-step${done ? ' done' : active ? ' active' : ''}`;

  const firstAsk = pendingAsks[0];
  const firstAskPhrase = firstAsk
    ? askPhrase(firstAsk.provider, firstAsk.credential_label ?? firstAsk.credential_id)
    : null;

  return (
    <div className="page">
      {/* The kill switch lives on /home — the way there must never require
          scrolling past onboarding (field-hit: "i don't know how to reach
          the kill page"). Safety controls are findable from everywhere. */}
      <div className="page-head">
        <h1>{agentName} is yours</h1>
        <Link className="btn btn-ghost" to="/home">Your agents →</Link>
      </div>
      {state.planBlocked ? (
        <div className="banner banner-warn">
          Your plan already has {state.planBlocked.max} agents, so this one isn&rsquo;t active yet.{' '}
          <Link className="link" to="/settings/billing">Upgrade to add it →</Link>
        </div>
      ) : (
        <p className="page-lede">
          Three steps — this page ticks them off by itself as they happen.
        </p>
      )}

      {error && <div className="banner banner-error">{error}</div>}

      {/* When the claim was plan-blocked the agent has no active connection, so
          a connect attempt would fail server-side AFTER the user minted a real
          token — don't show the checklist at all until it's active. */}
      {state.planBlocked ? (
        <div className="empty">
          <p>Connecting a service unlocks once this agent is active.</p>
          <p className="muted">Switch it on from your plan, then come back here.</p>
        </div>
      ) : (
        <ol className="checklist">
          <li className={stepClass(step1Done, true)}>
            <span className="check-mark">{step1Done ? '✓' : '1'}</span>
            <div className="check-body">
              <b>{step1Done ? `${agentName} set itself up` : 'Set up your agent'}</b>
              {step1Done ? (
                <p className="muted">It has its own ID and can ask you for things — nothing more yet.</p>
              ) : (
                <>
                  <p className="muted">Hand this to your agent, or run it yourself:</p>
                  <AgentSetupPrompt />
                </>
              )}
            </div>
          </li>

          <li className={stepClass(step2Done, step1Done)}>
            <span className="check-mark">{step2Done ? '✓' : '2'}</span>
            <div className="check-body">
              <b>Connect an account</b>
              <p className="muted">
                {step2Done
                  ? 'Connected. Add more whenever you like.'
                  : agentId
                    ? `Pick one thing ${agentName} can use. You can take it back any time.`
                    : `Once ${agentName} is set up, you'll pick one thing it can use — and can take it back any time.`}
              </p>
              {agentId && (
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
                      onAuto={() => void submitProvision(card)}
                      onToken={(token) => setPhase(card.id, { kind: 'open', token, shapeWarn: false })}
                      onSubmit={() => void submit(card)}
                      onRetry={() =>
                        setPhase(
                          card.id,
                          // Automatic cards go back to the choice; paste-only cards back to the paste form.
                          card.automatic?.remote ? { kind: 'idle' } : { kind: 'open', token: '', shapeWarn: false },
                        )
                      }
                    />
                  ))}
                </ul>
              )}
            </div>
          </li>

          {/* A pending ask re-activates the step — never "checked off and
              asking at once", and the review-and-allow link is never dimmed. */}
          <li className={stepClass(step3Done && !firstAsk, step2Done || Boolean(firstAsk))}>
            <span className="check-mark">{step3Done && !firstAsk ? '✓' : '3'}</span>
            <div className="check-body">
              <b>Say yes when it asks</b>
              {firstAsk && firstAskPhrase ? (
                <p>
                  {agentName} is asking to <strong>{firstAskPhrase.action}</strong>
                  {firstAskPhrase.via ? <span className="muted"> · {firstAskPhrase.via}</span> : null}
                  {pendingAsks.length > 1 ? ` (and ${pendingAsks.length - 1} more)` : ''} —{' '}
                  <Link className="link" to="/home">review and allow →</Link>
                </p>
              ) : step3Done ? (
                <p className="muted">You&rsquo;ve done this — new asks show up on your home page.</p>
              ) : (
                <p className="muted">
                  When {agentName} needs something new, it asks — right here and on your home
                  page. One tap says yes
                  {owner.has_passkey
                    ? '.'
                    : ', and your first yes creates your passkey — the Face ID prompt, once.'}
                </p>
              )}
            </div>
          </li>
        </ol>
      )}

      <div className="panel welcome-cloud">
        <h2>Working in a cloud workspace (Codex)?</h2>
        {pp.k === 'ready' ? (
          <>
            <p className="panel-note">One paste makes {agentName} permanent:</p>
            <ol className="connect-steps">
              <li>Open your workspace settings and find <strong>Secrets</strong>.</li>
              <li>Add one named <code>BASEDAGENTS_PASSPORT</code> with this value.</li>
              <li>Done — every new task wakes up as the same agent, ready to go.</li>
            </ol>
            <CopyBlock text={pp.blob} />
            <p className="field-hint">
              Treat this like the key it is: whoever holds it can act as {agentName}. It was
              sealed to this browser — basedagents.ai only ever relayed a locked box it cannot
              open.
            </p>
          </>
        ) : (
          <>
            <p className="panel-note">
              Cloud workspaces forget everything between tasks. One paste fixes that: Keyring
              seals {agentName}&rsquo;s keys to this browser — never to basedagents.ai — and you
              put the result in your workspace&rsquo;s settings.
            </p>
            {pp.k === 'working' && (
              <p className="field-hint">
                Waiting for the workspace task that set {agentName} up — keep that task running;
                this fills in by itself.
                {pp.slow && (
                  <>
                    <br />
                    Still waiting? If that task already ended, start a new one, paste the setup
                    prompt, and come back here.
                  </>
                )}
              </p>
            )}
            {pp.k === 'failed' && <div className="banner banner-error">{pp.reason}</div>}
            {(pp.k === 'idle' || pp.k === 'failed') && (
              <button className="btn btn-primary" onClick={() => void startPassport()}>
                Make {agentName} permanent
              </button>
            )}
          </>
        )}
      </div>

      <div className="panel welcome-done">
        <h2>{allDone ? 'You’re set' : 'Good to know'}</h2>
        <p className="panel-note">
          {agentName} can only use what you connect here, every use is recorded, and the{' '}
          <strong>kill switch</strong> on your home page cuts off everything at once — no
          questions asked.
        </p>
        <button className="btn btn-primary" onClick={() => navigate('/home')}>
          {allDone ? 'Done — take me home' : 'Skip for now'}
        </button>
      </div>
    </div>
  );
}
