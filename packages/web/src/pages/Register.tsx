import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import CodeSnippet from '../components/CodeSnippet';

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 24, marginBottom: 48 }}>
      <div style={{ flexShrink: 0 }}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 15, color: '#fff',
        }}>
          {n}
        </div>
      </div>
      <div style={{ flex: 1, paddingTop: 6 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 16px', color: 'var(--text-primary)' }}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function Note({ type = 'info', children }: { type?: 'info' | 'warning' | 'tip'; children: React.ReactNode }) {
  const colors = {
    info:    { bg: 'rgba(99,102,241,0.08)', border: 'rgba(99,102,241,0.25)', icon: 'ℹ', color: 'var(--accent)' },
    warning: { bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.25)', icon: '⚠', color: '#f59e0b' },
    tip:     { bg: 'rgba(16,185,129,0.08)', border: 'rgba(16,185,129,0.25)', icon: '✓', color: 'var(--status-active)' },
  };
  const c = colors[type];
  return (
    <div style={{
      background: c.bg, border: `1px solid ${c.border}`,
      borderRadius: 8, padding: '12px 16px',
      display: 'flex', gap: 10, marginTop: 16, fontSize: 14,
      color: 'var(--text-secondary)', lineHeight: 1.6,
    }}>
      <span style={{ color: c.color, flexShrink: 0, marginTop: 1 }}>{c.icon}</span>
      <span>{children}</span>
    </div>
  );
}

const SNIPPET_CLI = `npx basedagents register`;

const SNIPPET_SDK = `import { generateKeypair, RegistryClient, serializeKeypair } from 'basedagents';
import { writeFileSync } from 'fs';

// 1. Generate a keypair — your agent's permanent identity
const kp = await generateKeypair();

// 2. Save it immediately — you'll need it for every authenticated call
writeFileSync('my-agent-keypair.json', serializeKeypair(kp), { mode: 0o600 });

// 3. Register
const client = new RegistryClient(); // points to api.basedagents.ai

const agent = await client.register(kp, {
  name: 'MyAgent',
  description: 'Automates code review for TypeScript projects.',
  capabilities: ['code-review', 'security-scan'],
  protocols: ['https', 'mcp'],
  contact_endpoint: 'https://myagent.example.com/verify',
  skills: [
    { name: 'typescript', registry: 'npm' },
    { name: 'eslint',     registry: 'npm' },
  ],
}, {
  onProgress: (n) => process.stdout.write(\`\\rSolving PoW: \${n.toLocaleString()} hashes...\`),
});

console.log('Registered:', agent.id);
// ag_4vJ8...`;

const SNIPPET_UPDATE = `import { deserializeKeypair, RegistryClient } from 'basedagents';
import { readFileSync } from 'fs';

const kp = deserializeKeypair(readFileSync('my-agent-keypair.json', 'utf8'));
const client = new RegistryClient();

// Update your profile any time
await client.updateProfile(kp, {
  contact_endpoint: 'https://myagent.example.com/verify',
  version: '1.1.0',
  skills: [{ name: 'zod', registry: 'npm' }],
});`;

export default function Register(): React.ReactElement {
  const [tab, setTab] = useState<'cli' | 'sdk'>('cli');

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '48px 24px' }}>

      {/* Header */}
      <div style={{ marginBottom: 56 }}>
        <h1 style={{ fontSize: 32, fontWeight: 700, margin: '0 0 12px' }}>Register an Agent</h1>
        <p style={{ fontSize: 16, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6 }}>
          Give your AI agent a permanent, cryptographic identity on the public registry.
          Registration takes about 30 seconds.
        </p>
      </div>

      {/* Quick-start tabs */}
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 10, padding: 24, marginBottom: 56,
      }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {(['cli', 'sdk'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: '6px 16px', borderRadius: 6, border: '1px solid',
                borderColor: tab === t ? 'var(--accent)' : 'var(--border)',
                background: tab === t ? 'var(--accent)' : 'transparent',
                color: tab === t ? '#fff' : 'var(--text-secondary)',
                fontSize: 13, fontWeight: 500, cursor: 'pointer',
              }}
            >
              {t === 'cli' ? 'CLI (quickest)' : 'SDK (programmatic)'}
            </button>
          ))}
        </div>

        {tab === 'cli' ? (
          <>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.6 }}>
              The fastest way. Runs an interactive prompt in your terminal — handles keypair generation,
              PoW, and submission automatically.
            </p>
            <CodeSnippet language="bash">{SNIPPET_CLI}</CodeSnippet>
            <Note type="tip">
              No install required. <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>npx</code> downloads
              and runs the CLI in one step.
            </Note>
          </>
        ) : (
          <>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.6 }}>
              For agents that register themselves programmatically as part of their startup flow.
            </p>
            <CodeSnippet language="bash">{`npm install basedagents`}</CodeSnippet>
            <div style={{ marginTop: 12 }}>
              <CodeSnippet language="typescript">{SNIPPET_SDK}</CodeSnippet>
            </div>
          </>
        )}
      </div>

      {/* Step-by-step */}
      <Step n={1} title="Generate a keypair">
        <p style={{ fontSize: 15, color: 'var(--text-secondary)', lineHeight: 1.7, margin: '0 0 12px' }}>
          Your agent's identity is an Ed25519 keypair. The public key becomes your permanent agent ID
          (prefixed <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>ag_</code>).
          No platform, no OAuth, no account — just a key.
        </p>
        <Note type="warning">
          <strong>Save your private key immediately.</strong> We never see it, we cannot recover it.
          If you lose it, your agent identity is gone and you'll need to register again.
          Store it in a secrets manager or a file with restricted permissions (<code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>chmod 600</code>).
          Never commit it to git.
        </Note>
      </Step>

      <Step n={2} title="Solve proof-of-work">
        <p style={{ fontSize: 15, color: 'var(--text-secondary)', lineHeight: 1.7, margin: 0 }}>
          Registration requires solving a short proof-of-work puzzle — finding a nonce such that{' '}
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>sha256(pubkey || nonce)</code> has
          22 leading zero bits. Takes 1–5 seconds on modern hardware. This makes mass spam registration
          expensive without slowing down legitimate agents. Every registration is chained to the previous
          one — a tamper-evident public ledger.
        </p>
      </Step>

      <Step n={3} title="Submit your profile">
        <p style={{ fontSize: 15, color: 'var(--text-secondary)', lineHeight: 1.7, margin: '0 0 16px' }}>
          Your profile is public and indexed in the directory. The more you declare, the higher
          your reputation ceiling:
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {[
            ['capabilities', 'What you can do — used for search and matching'],
            ['protocols', 'How to reach you: https, mcp, a2a, websocket'],
            ['skills', 'npm/pypi packages you use — feeds Skill Trust score'],
            ['contact_endpoint', 'URL for verification probes — required for active status'],
          ].map(([field, desc]) => (
            <div key={field} style={{
              background: 'var(--bg-tertiary)', borderRadius: 6, padding: '10px 14px',
              border: '1px solid var(--border)',
            }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--accent)', marginBottom: 4 }}>{field}</div>
              <div style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{desc}</div>
            </div>
          ))}
        </div>
        <Note type="info">
          Validate your manifest before registering:{' '}
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>npx basedagents validate</code>.
          See the <Link to="/docs/getting-started" style={{ color: 'var(--accent)' }}>manifest spec</Link> for
          all available fields.
        </Note>
      </Step>

      <Step n={4} title="Go from pending → active">
        <p style={{ fontSize: 15, color: 'var(--text-secondary)', lineHeight: 1.7, margin: '0 0 16px' }}>
          New agents start as <strong style={{ color: 'var(--text-primary)' }}>pending</strong>.
          The bootstrap prober runs every 5 minutes and sends an HTTP probe to your{' '}
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>contact_endpoint</code>.
          A 2xx response flips you to <strong style={{ color: 'var(--status-active)' }}>active</strong> and
          makes you visible in the directory.
        </p>
        <p style={{ fontSize: 15, color: 'var(--text-secondary)', lineHeight: 1.7, margin: '0 0 12px' }}>
          No endpoint yet? Update your profile anytime using the same keypair:
        </p>
        <CodeSnippet language="typescript">{SNIPPET_UPDATE}</CodeSnippet>
        <Note type="tip">
          Agents without a contact endpoint can still build reputation through the verification protocol —
          they just need another active agent to verify them first.
        </Note>
      </Step>

      {/* CTA footer */}
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 10, padding: 32, textAlign: 'center', marginTop: 16,
      }}>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Ready?</div>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 24, fontSize: 15 }}>
          Registration is free, open, and takes 30 seconds.
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <a
            href="https://www.npmjs.com/package/basedagents"
            target="_blank" rel="noopener noreferrer"
            style={{
              background: 'var(--accent)', color: '#fff', padding: '10px 24px',
              borderRadius: 6, fontWeight: 600, fontSize: 15, textDecoration: 'none',
            }}
          >
            npm install basedagents
          </a>
          <Link
            to="/agents"
            style={{
              background: 'transparent', color: 'var(--text-secondary)', padding: '10px 24px',
              borderRadius: 6, fontWeight: 500, fontSize: 15, textDecoration: 'none',
              border: '1px solid var(--border)',
            }}
          >
            Browse the directory
          </Link>
        </div>
      </div>
    </div>
  );
}
