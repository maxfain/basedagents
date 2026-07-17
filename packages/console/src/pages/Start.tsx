/**
 * /start — the web "Get started" door (onboarding redesign §2, page-copy v1).
 *
 * Two doors, terminal-primary:
 *   • "I'm at my terminal" (default): the paste-into-Claude-Code block — the
 *     agent installs its own keyring. This is the ICP path.
 *   • "Start in your browser": one email field → magic link. No password, no
 *     profile fields, no plan picker — one field is not a signup form.
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

type Door = 'terminal' | 'browser';
type Phase = 'doors' | 'sending' | 'sent' | 'finishing' | 'command';

export default function Start() {
  const navigate = useNavigate();
  const { refresh } = useOwner();
  const [door, setDoor] = useState<Door>('terminal');
  const [phase, setPhase] = useState<Phase>('doors');
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState('');
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
      .then(async ({ has_account }) => {
        if (has_account) {
          await refresh();
          navigate('/home', { replace: true });
        } else {
          setPhase('command'); // first-time visitor → hand the command to the agent
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
              where it works and opens the page that connects it to you.
            </p>
            <AgentSetupPrompt label="Paste this to your agent:" />
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
            </div>

            {door === 'terminal' ? (
              <div className="start-panel">
                <AgentSetupPrompt />
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
