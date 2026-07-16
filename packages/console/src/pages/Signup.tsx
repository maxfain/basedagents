/**
 * /signup — there is no signup form (onboarding redesign Move 1).
 *
 * Accounts are born in the terminal: the command below sets everything up on
 * the user's machine and opens the one page that puts them in charge. This
 * page's only job is to hand over that command.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';

const COMMAND = 'npx @basedagents/keyring init';

export default function Signup() {
  const [copied, setCopied] = useState(false);

  function copy(): void {
    void navigator.clipboard.writeText(COMMAND).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark">◈</span> BasedAgents
        </div>
        <h1 className="auth-title">Get started</h1>
        <p className="auth-lede">
          Run this in the terminal where your agent works — it sets everything up and opens one
          page to put you in control. About a minute, start to finish.
        </p>
        <div className="code-block cmd cmd-row">
          <span className="code-block-select">{COMMAND}</span>
          <button className="btn btn-ghost btn-sm" onClick={copy}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
        <ul className="signup-points">
          <li>Everything sensitive stays on your machine — this site never sees it.</li>
          <li>Your agent can only use what you connect, and every use is recorded.</li>
          <li>One kill switch cuts it all off, anytime.</li>
        </ul>
        <div className="auth-switch">
          <Link className="link" to="/login">Already set up? Sign in</Link>
        </div>
      </div>
    </div>
  );
}
