/**
 * /claim#t=TOKEN — the magic-link landing, the ratifying moment of the ladder.
 *
 * One POST consumes the token; the server creates everything at once (account,
 * agent connection, machine binding) and mints the look-session. On success we
 * land on /welcome with the agent's name so the connect cards know who they
 * are for. The token rides the URL FRAGMENT, so it never appears in server
 * logs or Referer headers.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { control, ControlApiError } from '../api/control.js';
import { useOwner } from '../state/session.js';
import { AuthBrand } from '../components/AuthBrand.js';

export default function Claim() {
  const navigate = useNavigate();
  const { refresh } = useOwner();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false); // StrictMode double-mount must not double-consume

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const token = new URLSearchParams(window.location.hash.slice(1)).get('t');
    if (!token) {
      setError('This link is incomplete — use the one from your email.');
      return;
    }
    // Drop the token from the address bar before anything else happens.
    window.history.replaceState(null, '', window.location.pathname);

    void (async () => {
      try {
        const result = await control.claimFinish(token);
        await refresh();
        navigate('/welcome', {
          replace: true,
          state: {
            agentId: result.agent_id,
            agentName: result.agent_name,
            planBlocked: result.delegation_blocked,
          },
        });
      } catch (err) {
        if (err instanceof ControlApiError && err.status === 409) {
          setError('This agent was already claimed. If that was you, just sign in.');
        } else {
          setError('This link is invalid or has expired. Run the setup command again for a fresh one.');
        }
      }
    })();
  }, [navigate, refresh]);

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <AuthBrand />
        {error ? (
          <>
            <h1 className="auth-title">That didn&rsquo;t work</h1>
            <p className="auth-lede">{error}</p>
            <div className="code-block cmd">npx @basedagents/keyring init</div>
            <div className="auth-switch">
              <a className="link" href="/login">Sign in</a>
            </div>
          </>
        ) : (
          <>
            <h1 className="auth-title">Taking control…</h1>
            <p className="auth-lede">One moment — connecting this agent to you.</p>
          </>
        )}
      </div>
    </div>
  );
}
