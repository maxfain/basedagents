/**
 * /invited#t=TOKEN — landing for an agent-sent invite (spec v0.2 §2b).
 *
 * The click verifies email possession, nothing more: no account exists yet,
 * and the agent that sent this holds authority over NOTHING until the human
 * runs the setup command on their own machine. This page says exactly that,
 * then shows the command. An expired token is a soft failure — the command
 * works regardless.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { useEffect, useRef, useState } from 'react';
import { control } from '../api/control.js';
import { AuthBrand } from '../components/AuthBrand.js';

const COMMAND = 'npx @basedagents/keyring@latest init';

export default function Invited() {
  const [state, setState] = useState<'working' | 'ok' | 'expired'>('working');
  const [copied, setCopied] = useState(false);
  const ran = useRef(false); // StrictMode double-mount must not double-consume

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const token = new URLSearchParams(window.location.hash.slice(1)).get('t');
    window.history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setState('expired');
      return;
    }
    control
      .inviteClaim(token)
      .then(() => setState('ok'))
      .catch(() => setState('expired'));
  }, []);

  function copy(): void {
    void navigator.clipboard.writeText(COMMAND).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (state === 'working') {
    return <div className="boot">One moment…</div>;
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <AuthBrand />
        <h1 className="auth-title">
          {state === 'ok' ? 'An agent is waiting for you' : 'This invite has expired'}
        </h1>
        <p className="auth-lede">
          {state === 'ok'
            ? 'Right now it can hold nothing and access nothing. To take control, run this in your terminal, on your machine:'
            : 'No problem — the setup command works on its own. Run this in your terminal, on your machine:'}
        </p>
        <div className="code-block cmd cmd-row">
          <span className="code-block-select">{COMMAND}</span>
          <button className="btn btn-ghost btn-sm" onClick={copy}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
        <p className="field-hint" style={{ marginTop: '1rem' }}>
          It takes about a minute and opens one page to put you in charge. Everything sensitive
          stays on your machine.
        </p>
      </div>
    </div>
  );
}
