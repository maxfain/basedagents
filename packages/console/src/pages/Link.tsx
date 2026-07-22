/**
 * /link?code=XXXX — the ONE page `npx @basedagents/keyring@latest init` opens.
 *
 * Base-case surface: one email field under "Take control of this agent".
 * Submitting sends the magic link; the click in the inbox (the /claim page)
 * is what ratifies. This page never holds authority — it only starts the
 * email round trip, then tells the user where to look.
 *
 * Banned-words rule (onboarding redesign): nothing here may render the words
 * grant/lease/delegation/identity/credential/owner. Enforced by
 * scripts/lint-ui-words.mjs.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { control, ControlApiError } from '../api/control.js';
import type { LinkInfo } from '../api/types.js';
import { AuthBrand } from '../components/AuthBrand.js';

function errText(err: unknown): string {
  if (err instanceof ControlApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export default function LinkPage() {
  const [params] = useSearchParams();
  const code = params.get('code') ?? '';
  const [link, setLink] = useState<LinkInfo | null | 'missing'>(null);
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [otherEmail, setOtherEmail] = useState(false); // "use a different email"
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) {
      setLink('missing');
      return;
    }
    control
      .linkStatus(code)
      .then(setLink)
      .catch(() => setLink('missing'));
  }, [code]);

  if (link === null) {
    return <div className="boot">Loading…</div>;
  }

  const agentName = link !== 'missing' ? (link.agent_name ?? 'your agent') : 'your agent';
  const dead = link === 'missing' || link.status === 'expired';
  const alreadyClaimed = link !== 'missing' && link.status === 'claimed';
  // Masked address carried over from the /start page (never the full email).
  const emailHint = link !== 'missing' ? (link.email_hint ?? null) : null;
  const prefilled = emailHint !== null && !otherEmail;

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // Pre-filled: no email in the request — the server sends to the address
    // the start code attached. Typed: that address wins.
    const typed = prefilled ? undefined : email.trim();
    try {
      await control.linkClaim(code, typed);
      setSentTo(typed ?? emailHint);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <AuthBrand />

        {dead ? (
          <>
            <h1 className="auth-title">This link has expired</h1>
            <p className="auth-lede">
              Run the setup command again in your terminal — everything you already set up is
              saved, and a fresh link opens right away.
            </p>
            <div className="code-block cmd">npx @basedagents/keyring@latest init</div>
          </>
        ) : alreadyClaimed ? (
          <>
            <h1 className="auth-title">{agentName} is already in your hands</h1>
            <p className="auth-lede">This agent was claimed. You can close this page.</p>
          </>
        ) : sentTo ? (
          <>
            <h1 className="auth-title">Check your email</h1>
            <p className="auth-lede">
              We sent a link to <strong>{sentTo}</strong>. Click it within 15 minutes to take
              control of {agentName}. You can close this page.
            </p>
          </>
        ) : prefilled ? (
          <>
            <h1 className="auth-title">Take control of this agent</h1>
            <p className="auth-lede">
              <strong>{agentName}</strong> is set up on your machine and waiting for you. We
              already have your email from the page where you started — we&rsquo;ll send the link
              that puts you in charge to <strong>{emailHint}</strong>.
            </p>
            <form onSubmit={onSubmit} className="form">
              <button className="btn btn-primary" type="submit" disabled={busy} autoFocus>
                {busy ? 'Sending…' : 'Send me the link'}
              </button>
            </form>
            {error && <div className="banner banner-error">{error}</div>}
            <p className="field-hint" style={{ marginTop: '1rem' }}>
              Not you?{' '}
              <button type="button" className="link" onClick={() => setOtherEmail(true)}>
                Use a different email
              </button>
            </p>
            <p className="field-hint">
              Nothing happens without the link — and everything sensitive stays on your machine.
            </p>
          </>
        ) : (
          <>
            <h1 className="auth-title">Take control of this agent</h1>
            <p className="auth-lede">
              <strong>{agentName}</strong> is set up on your machine and waiting for you.
              Enter your email and we&rsquo;ll send you a link that puts you in charge.
            </p>
            <form onSubmit={onSubmit} className="form">
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
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {busy ? 'Sending…' : 'Send me the link'}
              </button>
            </form>
            {error && <div className="banner banner-error">{error}</div>}
            <p className="field-hint" style={{ marginTop: '1rem' }}>
              Nothing happens without the link — and everything sensitive stays on your machine.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
