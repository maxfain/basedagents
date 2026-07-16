/**
 * /login — both rungs of the ladder, email first (spec v0.2 §5.1).
 *
 * The email magic link mints a LOOK-ONLY session: you can see everything,
 * but nothing moves without a passkey signature (approve endpoints arm no
 * usable challenge under it). The passkey button is the second rung for
 * people who already have one. Magic-link tokens arrive on THIS page as
 * #t=… in the URL fragment — never in a query string, never logged.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { control, ControlApiError } from '../api/control.js';
import { getAssertion, passkeysSupported } from '../lib/webauthn.js';
import { useOwner } from '../state/session.js';

function errText(err: unknown): string {
  if (err instanceof ControlApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export default function Login() {
  const { refresh } = useOwner();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState<'email' | 'passkey' | 'finish' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  // A magic-link click lands here as /login#t=… — finish it once.
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const token = new URLSearchParams(window.location.hash.slice(1)).get('t');
    if (!token) return;
    window.history.replaceState(null, '', window.location.pathname);
    setBusy('finish');
    void control
      .loginEmailFinish(token)
      .then(async () => {
        await refresh();
        navigate('/home', { replace: true });
      })
      .catch(() => {
        setBusy(null);
        setError('That sign-in link is invalid or has expired — request a fresh one below.');
      });
  }, [navigate, refresh]);

  async function onEmail(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy('email');
    setError(null);
    try {
      await control.loginEmail(email.trim());
      setSentTo(email.trim());
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  async function onPasskey(): Promise<void> {
    setBusy('passkey');
    setError(null);
    try {
      const begin = await control.loginBegin({ email: email.trim() });
      const assertion = await getAssertion({
        challenge: begin.challenge,
        rpId: begin.rpId,
        allowCredentials: begin.allowCredentials,
        userVerification: begin.userVerification,
        timeout: begin.timeout,
      });
      await control.loginFinish(assertion);
      await refresh();
      navigate('/home', { replace: true });
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  if (busy === 'finish') {
    return <div className="boot">Signing you in…</div>;
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark">◈</span> BasedAgents
        </div>

        {sentTo ? (
          <>
            <h1 className="auth-title">Check your email</h1>
            <p className="auth-lede">
              If <strong>{sentTo}</strong> has an account, a sign-in link is on its way. Click it
              within 15 minutes. You can close this page.
            </p>
          </>
        ) : (
          <>
            <h1 className="auth-title">Sign in</h1>
            <p className="auth-lede">See what your agents are doing and stay in control.</p>

            <form onSubmit={onEmail} className="form">
              <label className="field">
                <span className="field-label">Email</span>
                <input
                  type="email"
                  autoComplete="username webauthn"
                  value={email}
                  onChange={(ev) => setEmail(ev.target.value)}
                  placeholder="you@example.com"
                  required
                />
              </label>
              <button className="btn btn-primary" type="submit" disabled={busy !== null}>
                {busy === 'email' ? 'Sending…' : 'Email me a sign-in link'}
              </button>
              {passkeysSupported() && (
                <button
                  className="btn btn-ghost"
                  type="button"
                  disabled={busy !== null || email.trim() === ''}
                  onClick={() => void onPasskey()}
                >
                  {busy === 'passkey' ? 'Waiting for passkey…' : 'Sign in with a passkey'}
                </button>
              )}
            </form>

            {error && <div className="banner banner-error">{error}</div>}

            <div className="auth-switch">
              <Link className="link" to="/signup">New here? Get started</Link>
              <span className="auth-sep">·</span>
              <Link className="link" to="/recover">Lost your passkeys?</Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
