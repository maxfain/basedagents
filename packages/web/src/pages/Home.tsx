import React, { useState } from 'react';
import { API_BASE } from '../api/client';

/**
 * The Keyring-first marketing homepage (basedagents.ai homepage spec).
 *
 * Rendered by the React SPA at `/` (index.html is the SPA shell — see
 * public/_redirects and vite.config.ts). The curl / zero-JS summary and the
 * agent contract live in index.html's <noscript>; the fully-static leaf pages
 * (/keyring, /registry, /docs/agents) carry the machine-readable detail.
 */

// The pasted prompt is the ONLY channel that reaches an agent in a cold cloud
// sandbox at task time (no network, no docs, no package on disk) — but the
// HUMAN's browser is unrestricted, so the prompt only needs to carry a POINTER,
// not the payload: a quoted relay line the agent hands back verbatim, pointing
// at /codex (the human-facing recovery page). "Start a new task" must survive
// the relay — fixing the environment doesn't revive the current dead task.
const HERO_PROMPT =
  'Set up BasedAgents Keyring for this project: run\n' +
  'npx basedagents keyring init and follow its instructions.\n' +
  'Cloud sandbox blocking npm? Don\'t retry — tell me:\n' +
  '"Open basedagents.ai/codex for the one-time fix, then start a new task."';
const CLOSING_PROMPT =
  'Set up BasedAgents Keyring: run npx basedagents keyring init. ' +
  'Cloud sandbox blocking npm? Tell me: "Open basedagents.ai/codex, then start a new task."';
// Codex-style cloud agents block egress at task time, so a cold `npx` there
// 403s. The install has to run in the environment's setup phase instead —
// install only (nothing interactive); register + the hand-off happen at task
// time with api/app.basedagents.ai allowlisted.
const CODEX_SETUP = 'npm install --save-dev basedagents';

/** Fire-and-forget onboarding funnel ping. Never blocks or breaks the UI. */
function ping(event: string, provider?: string): void {
  try {
    void fetch(`${API_BASE}/v1/funnel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, ...(provider ? { provider } : {}) }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* telemetry must never break the page */
  }
}

function CopyPrompt({
  label,
  text,
  tag = 'home',
}: {
  label: string;
  text: string;
  tag?: string;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <div className="home-paste">
      <p className="home-paste-label">{label}</p>
      <div className="home-paste-cmd">
        <pre>{text}</pre>
        <button
          type="button"
          className="home-copy-btn"
          onClick={() => {
            void navigator.clipboard?.writeText(text.trim()).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
            ping('copy_command', tag);
          }}
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

/**
 * Hero setup, branched by where the agent runs. Local agents (Claude Code,
 * Cursor, a terminal) have network — the one-liner just works. Codex-style cloud
 * sandboxes cut egress at task time, so a cold `npx` there 403s; the install has
 * to happen in the environment's setup phase. Showing the wrong command to a
 * Codex user is the dead end we're routing around.
 */
function HeroSetup(): React.ReactElement {
  const [lane, setLane] = useState<'local' | 'cloud'>('local');
  return (
    <div className="home-setup">
      <div className="home-lanes" role="tablist" aria-label="Where does your agent run?">
        <button
          type="button"
          role="tab"
          aria-selected={lane === 'local'}
          className={`home-lane ${lane === 'local' ? 'active' : ''}`}
          onClick={() => setLane('local')}
        >
          Claude Code, Cursor, or terminal
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={lane === 'cloud'}
          className={`home-lane ${lane === 'cloud' ? 'active' : ''}`}
          onClick={() => setLane('cloud')}
        >
          Codex / cloud sandbox
        </button>
      </div>

      {lane === 'local' ? (
        <>
          <CopyPrompt label="Paste this into Claude Code:" text={HERO_PROMPT} />
          <p className="home-paste-alt">
            or <code>npx @basedagents/keyring init</code> in your terminal · or{' '}
            <a href="https://app.basedagents.ai/start">start in your browser →</a> — one email field, no
            password
          </p>
        </>
      ) : (
        <>
          <CopyPrompt
            label="1. Paste into your Codex environment's Setup script:"
            text={CODEX_SETUP}
            tag="home_codex"
          />
          <p className="home-paste-alt">
            Codex cuts the internet at task time, so a fresh <code>npx</code> then is blocked — install
            it during setup. 2. Allow <code>api.basedagents.ai</code> + <code>app.basedagents.ai</code>.
            3. In your first task, tell your agent:{' '}
            <em>&ldquo;set up BasedAgents Keyring and give me the link to connect keys.&rdquo;</em> It
            registers, then hands you off to <a href="https://app.basedagents.ai/start">app.basedagents.ai/start</a>.{' '}
            <a href="/docs/agents#codex">Full guide →</a>
          </p>
        </>
      )}
    </div>
  );
}

const LIVE_PROVIDERS = ['Vercel', 'Supabase'];
const VOTE_PROVIDERS: Array<{ key: string; label: string }> = [
  { key: 'railway', label: 'Railway' },
  { key: 'flyio', label: 'Fly.io' },
  { key: 'cloudflare', label: 'Cloudflare' },
  { key: 'aws', label: 'AWS' },
  { key: 'neon', label: 'Neon' },
  { key: 'anthropic', label: 'Anthropic' },
  { key: 'openrouter', label: 'OpenRouter' },
];

function VoteTile({ providerKey, label }: { providerKey: string; label: string }): React.ReactElement {
  const [state, setState] = useState<'vote' | 'voting' | 'voted' | 'error'>('vote');
  const [votes, setVotes] = useState<number | null>(null);
  return (
    <button
      type="button"
      className="home-gtile home-gtile-vote"
      disabled={state === 'voting' || state === 'voted'}
      onClick={() => {
        setState('voting');
        fetch(`${API_BASE}/v1/providers/${providerKey}/vote`, { method: 'POST' })
          .then((res) => {
            if (!res.ok) throw new Error('vote failed');
            return res.json();
          })
          .then((data: { votes?: number }) => {
            setVotes(typeof data.votes === 'number' ? data.votes : null);
            setState('voted');
          })
          .catch(() => setState('error'));
      }}
    >
      <span>{label}</span>
      <span className="home-gtag">
        {state === 'voted' ? `Voted ✓${votes != null ? ` (${votes})` : ''}` : state === 'error' ? 'Try again' : 'Vote'}
      </span>
    </button>
  );
}

export default function Home(): React.ReactElement {
  return (
    <div className="home">
      {/* Hero */}
      <header className="home-hero">
        <h1 className="home-h1">Never paste a key into a chat again</h1>
        <p className="home-lede">
          Sooner or later your AI asks you to paste a key so it can deploy, save, or publish for you.
          Don't. Keyring gives your agent its own key to each account — you approve with a tap, see
          everything it can touch, and cut it off any time.
        </p>
        <HeroSetup />
        <p className="home-tags">Free for 3 agents · Open source · Your agent sets it up — about a minute</p>
      </header>

      {/* The three steps */}
      <section className="home-section">
        <h2 className="home-h2">Three steps, and the last two are just clicking</h2>
        <ol className="home-steps">
          <li>
            <b>Copy the prompt above into your agent.</b> It sets everything up and hands you back a
            link.
          </li>
          <li>
            <b>Click the link.</b> One email field, no password — that's your control screen.
          </li>
          <li>
            <b>Tap Allow when your agent asks.</b> Your first yes creates a passkey — the Face ID
            prompt — and from then on it's just: your agent asks, you tap.
          </li>
        </ol>
      </section>

      {/* The moment */}
      <section className="home-section">
        <h2 className="home-h2">The key your agent asks for opens everything</h2>
        <p>
          When an agent says &ldquo;paste your key here,&rdquo; that key usually opens the whole
          account — and pasting it into the chat means it lives in the conversation forever. Keyring
          is the hotel front desk instead: your agent gets a key card that opens one door, expires on
          its own, can be switched off in a second — and every door it opens is on the record.
        </p>
      </section>

      {/* The three verbs */}
      <section className="home-section">
        <h2 className="home-h2">You only ever do three things</h2>
        <div className="home-tiles">
          <div className="home-tile">
            <b>Connect.</b>
            <p>Say yes once and your agent gets its own key to that one account — your passwords and sign-ins stay yours.</p>
          </div>
          <div className="home-tile">
            <b>Approve.</b>
            <p>Anything new waits for your OK. One tap to allow, one to refuse — and every yes stays visible on one screen.</p>
          </div>
          <div className="home-tile">
            <b>Cut off.</b>
            <p>The kill switch takes back everything an agent holds, in one second — and tells you if anything outside Keyring can still act.</p>
          </div>
        </div>
      </section>

      {/* Under the hood: the registry */}
      <section className="home-section">
        <h2 className="home-h2">Under the hood</h2>
        <p>
          Every key is cryptographically tied to one agent — a permanent <code>ag_</code> ID in the
          open BasedAgents registry that no one can fake. Every yes you give is signed with your
          passkey, so there is a provable line from your decision to every key your agent uses — not
          a database row that says "trust us."
        </p>
        <p style={{ marginTop: 14 }}>
          The registry is open, platform-neutral, and free to build on. Engineers: the deep dive
          lives at <a href="/keyring">/keyring</a>.
        </p>
        <div className="home-cta-links">
          <a href="/registry">Explore the registry →</a>
          <a href="/docs/agents"><code>npx basedagents register</code></a>
        </div>
      </section>

      {/* Are you an agent? */}
      <section className="home-section">
        <h2 className="home-h2">Are you an agent?</h2>
        <p>Yes, this is on the human homepage — it's the thesis, in the open.</p>
        <div className="home-agent-box">
          <ol>
            <li>Register yourself: <code>npx basedagents register</code></li>
            <li>Get your keys managed: <code>npx @basedagents/keyring init</code></li>
            <li>Then ask your human for their email and call <code>invite_owner</code> — they stay in charge.</li>
          </ol>
          <p style={{ marginTop: 12 }}>
            Machine docs: <a href="/docs/agents">/docs/agents</a> · manifest:{' '}
            <a href="/.well-known/agent.json">/.well-known/agent.json</a>
          </p>
        </div>
      </section>

      {/* Works with your stack */}
      <section className="home-section">
        <h2 className="home-h2">Works with what your agent uses</h2>
        <p>Your agent probably deploys and saves with these. Vote for what you need next.</p>
        <div className="home-grid">
          {LIVE_PROVIDERS.map((name) => (
            <div key={name} className="home-gtile home-gtile-live">
              <span>{name}</span>
              <span className="home-gtag">Live</span>
            </div>
          ))}
          {VOTE_PROVIDERS.map((p) => (
            <VoteTile key={p.key} providerKey={p.key} label={p.label} />
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section className="home-section" id="pricing">
        <h2 className="home-h2">Pricing</h2>
        <div className="home-plans">
          <div className="home-plan">
            <h3>Free</h3>
            <p>3 agents, unlimited connections, 30-day activity. The local vault and CLI are open source, free forever.</p>
          </div>
          <div className="home-plan">
            <h3>Pro — $10/mo</h3>
            <p>Unlimited agents, 1-year history, automatic rotate and burn.</p>
          </div>
        </div>
        <p style={{ marginTop: 16 }}>
          Revoke and the kill switch work on every plan, always. <a href="/keyring#pricing">Full pricing →</a>
        </p>
      </section>

      {/* Closing */}
      <section className="home-section home-closing">
        <h2 className="home-h2">Your agents are already working. Give them their own keys.</h2>
        <CopyPrompt label="Paste into Claude Code:" text={CLOSING_PROMPT} />
      </section>
    </div>
  );
}
