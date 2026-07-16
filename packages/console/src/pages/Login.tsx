import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { control, ControlApiError } from '../api/control.js';
import { createPasskey, getAssertion, passkeysSupported } from '../lib/webauthn.js';
import { useOwner } from '../state/session.js';

type Mode = 'signin' | 'register';

function errText(err: unknown): string {
  if (err instanceof ControlApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export default function Login({ initialMode = 'signin' }: { initialMode?: Mode }) {
  const { refresh } = useOwner();
  const navigate = useNavigate();
  const [mode] = useState<Mode>(initialMode); // /login = signin, /signup = register
  const [email, setEmail] = useState('');
  const [vaultKey, setVaultKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supported = passkeysSupported();

  async function finishAndEnter(): Promise<void> {
    await refresh();
    navigate('/approvals', { replace: true });
  }

  async function onSignIn(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
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
      await finishAndEnter();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function onRegister(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const begin = await control.registerBegin(vaultKey.trim(), email.trim() || undefined);
      const reg = await createPasskey(begin.options);
      await control.registerFinish(vaultKey.trim(), reg);
      // A fresh passkey → sign in immediately to mint the look-session.
      const login = await control.loginBegin({ owner_id: begin.owner_id });
      const assertion = await getAssertion({
        challenge: login.challenge,
        rpId: login.rpId,
        allowCredentials: login.allowCredentials,
        userVerification: login.userVerification,
        timeout: login.timeout,
      });
      await control.loginFinish(assertion);
      await finishAndEnter();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark">◈</span> BasedAgents <span className="brand-sub">Console</span>
        </div>
        <h1 className="auth-title">{mode === 'signin' ? 'Sign in' : 'Create your owner account'}</h1>
        <p className="auth-lede">
          {mode === 'signin'
            ? 'Authenticate with the passkey bound to your vault.'
            : 'Bind a passkey to the vault you created with '}
          {mode === 'register' && <code>based init</code>}
          {mode === 'register' && '.'}
        </p>

        {!supported && (
          <div className="banner banner-warn">
            This browser has no WebAuthn/passkey support. Use a passkey-capable browser.
          </div>
        )}

        {mode === 'signin' ? (
          <form onSubmit={onSignIn} className="form">
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
            <button className="btn btn-primary" type="submit" disabled={busy || !supported}>
              {busy ? 'Waiting for passkey…' : 'Sign in with passkey'}
            </button>
          </form>
        ) : (
          <form onSubmit={onRegister} className="form">
            <label className="field">
              <span className="field-label">Vault public key</span>
              <input
                type="text"
                value={vaultKey}
                onChange={(ev) => setVaultKey(ev.target.value)}
                placeholder="base58 Ed25519 key from `based owner show`"
                spellCheck={false}
                required
              />
              <span className="field-hint">
                Your owner identity is derived from this key. It stays on your machine — the console
                never sees your vault's private key or any secret.
              </span>
            </label>
            <label className="field">
              <span className="field-label">Email <span className="muted">(for sign-in + recovery)</span></span>
              <input
                type="email"
                value={email}
                onChange={(ev) => setEmail(ev.target.value)}
                placeholder="you@example.com"
              />
            </label>
            <button className="btn btn-primary" type="submit" disabled={busy || !supported}>
              {busy ? 'Waiting for passkey…' : 'Create account + passkey'}
            </button>
          </form>
        )}

        {error && <div className="banner banner-error">{error}</div>}

        <div className="auth-switch">
          {mode === 'signin' ? (
            <Link className="link" to="/signup">Create account</Link>
          ) : (
            <Link className="link" to="/login">Already have a passkey? Sign in</Link>
          )}
          <span className="auth-sep">·</span>
          <Link className="link" to="/recover">Lost your passkeys?</Link>
        </div>
      </div>
    </div>
  );
}
