/**
 * /start — the web "Get started" door (onboarding redesign §2, page-copy v1).
 *
 * Three doors, terminal-primary:
 *   • "Start with your agent" (default): the paste-into-Claude-Code block — the
 *     agent installs its own keyring. This is the ICP path.
 *   • "Start in your browser": one email field → magic link. No password, no
 *     profile fields, no plan picker — one field is not a signup form.
 *   • "Codex / cloud": the setup-script recipe. Codex-style sandboxes cut egress
 *     at task time, so a cold `npx` there is blocked (§4.6) — the install has to
 *     run in the environment's setup phase. Showing a Codex user the plain
 *     one-liner is a dead end, so this door hands them the one that works.
 *
 * The magic-link click lands back here as /start#t=…:
 *   • a returning account → a look session, straight to home;
 *   • a brand-new visitor → the command to hand their AGENT (not a raw terminal
 *     instruction), because setup still happens where the agent lives — the
 *     browser never holds a vault key.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { control, ControlApiError } from '../api/control.js';
import { useOwner } from '../state/session.js';
import { AgentSetupPrompt } from '../components/AgentSetup.js';
import { AuthNav } from '../components/AuthNav.js';
import { funnelPing } from '../lib/funnel.js';

function errText(err: unknown): string {
  if (err instanceof ControlApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

// Runs in the Codex environment's setup phase (network open), so a fresh `npx`
// at task time never has to reach the registry. Install only — nothing
// interactive; the agent runs keyring init and hands you off at task time.
const CODEX_SETUP = 'npm install --save-dev basedagents';

/** The Codex / cloud-sandbox door: install during setup, not at task time. */
function CloudSetup() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="agent-setup">
      <div className="start-prompt-label">1. Paste this into your Codex environment&rsquo;s Setup script:</div>
      <div className="code-block cmd-row">
        <pre className="start-script">{CODEX_SETUP}</pre>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() =>
            void navigator.clipboard.writeText(CODEX_SETUP).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
          }
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <p className="field-hint start-or">
        Codex switches the internet off while your agent works, so a fresh <code>npx</code> at task
        time is blocked — install during setup. 2. Add <code>api.basedagents.ai</code> and{' '}
        <code>app.basedagents.ai</code> to the environment&rsquo;s allowed domains.
      </p>
      <p className="field-hint">
        3. Then, in your first task, tell your agent:{' '}
        <em>&ldquo;set up BasedAgents Keyring and give me the link to connect keys.&rdquo;</em> It runs{' '}
        <code>keyring init</code> and hands you the page to finish.
      </p>
      <p className="field-hint">
        Full guide:{' '}
        <a className="link" href="https://basedagents.ai/docs/agents#codex">
          basedagents.ai/docs/agents#codex
        </a>
      </p>
    </div>
  );
}

type Door = 'terminal' | 'browser' | 'cloud';
type Phase = 'doors' | 'sending' | 'sent' | 'finishing' | 'command';

export default function Start() {
  const navigate = useNavigate();
  const { refresh } = useOwner();
  const [door, setDoor] = useState<Door>('terminal');
  const [phase, setPhase] = useState<Phase>('doors');
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [startCode, setStartCode] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false); // StrictMode: consume the token once

  // A magic-link click lands as /start#t=… — finish it.
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const token = new URLSearchParams(window.location.hash.slice(1)).get('t');
    if (!token) return;
    window.history.replaceState(null, '', window.location.pathname);
    setPhase('finishing');
    void control
      .startFinish(token)
      .then(async ({ has_account, start_code }) => {
        if (has_account) {
          await refresh();
          navigate('/home', { replace: true });
        } else {
          // First-time visitor → hand the command to the agent. The start
          // code inside it carries the just-verified email to the final step,
          // so the finish page already knows where to send the confirmation.
          setStartCode(start_code);
          setPhase('command');
        }
      })
      .catch(() => {
        setPhase('doors');
        setError('That link is invalid or has expired — request a fresh one below.');
      });
  }, [navigate, refresh]);

  async function onEmail(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setPhase('sending');
    setError(null);
    funnelPing('email_door');
    try {
      await control.startEmail(email.trim());
      setSentTo(email.trim());
      setPhase('sent');
    } catch (err) {
      setError(errText(err));
      setPhase('doors');
    }
  }

  if (phase === 'finishing') {
    return <div className="boot">One moment…</div>;
  }

  return (
    <>
    <AuthNav />
    <div className="auth-wrap auth-wrap-nav">
      <div className="auth-card auth-card-wide">
        {phase === 'command' ? (
          <>
            <h1 className="auth-title">You&rsquo;re in — one step to finish</h1>
            <p className="auth-lede">
              Hand this to your coding agent (Claude Code, Codex, or Cursor). It sets everything up
              where it works — and the code inside remembers your email, so the last step is one
              click, not another form.
            </p>
            <AgentSetupPrompt label="Paste this to your agent:" startCode={startCode} />
            <div className="start-preview">
              <span className="muted">Then connect what it can use —</span>
              <span className="start-tags">
                <span className="pill">Vercel</span>
                <span className="pill">Supabase</span>
                <span className="muted">more coming</span>
              </span>
            </div>
          </>
        ) : phase === 'sent' ? (
          <>
            <h1 className="auth-title">Check your email</h1>
            <p className="auth-lede">
              We sent a link to <strong>{sentTo}</strong>. Click it within 15 minutes to pick up
              from here. You can close this page.
            </p>
          </>
        ) : (
          <>
            <h1 className="auth-title">Get started</h1>
            <p className="auth-lede">
              Your agent sets itself up in about a minute. Start where you already are.
            </p>

            <div className="start-doors" role="tablist">
              <button
                role="tab"
                className={`start-door ${door === 'terminal' ? 'active' : ''}`}
                onClick={() => setDoor('terminal')}
              >
                Start with your agent
              </button>
              <button
                role="tab"
                className={`start-door ${door === 'browser' ? 'active' : ''}`}
                onClick={() => setDoor('browser')}
              >
                Start in your browser
              </button>
              <button
                role="tab"
                className={`start-door ${door === 'cloud' ? 'active' : ''}`}
                onClick={() => setDoor('cloud')}
              >
                Codex / cloud
              </button>
            </div>

            {door === 'terminal' ? (
              <div className="start-panel">
                <AgentSetupPrompt />
              </div>
            ) : door === 'cloud' ? (
              <div className="start-panel">
                <CloudSetup />
              </div>
            ) : (
              <form onSubmit={onEmail} className="form start-panel">
                <label className="field">
                  <span className="field-label">Email</span>
                  <input
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(ev) => setEmail(ev.target.value)}
                    placeholder="you@example.com"
                    required
                    autoFocus
                  />
                </label>
                <button className="btn btn-primary" type="submit" disabled={phase === 'sending'}>
                  {phase === 'sending' ? 'Sending…' : 'Email me a link'}
                </button>
                <p className="field-hint">One field, no password. We&rsquo;ll email you a link.</p>
              </form>
            )}

            {error && <div className="banner banner-error">{error}</div>}

            <div className="auth-switch">
              <a className="link" href="/login">Already set up? Sign in</a>
            </div>
          </>
        )}
      </div>
    </div>
    </>
  );
}
