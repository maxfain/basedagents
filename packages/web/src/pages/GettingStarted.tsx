import React from 'react';
import { Link } from 'react-router-dom';
import CodeSnippet from '../components/CodeSnippet';

const installCode = `npm install agent-registry`;

const keypairCode = `import { generateKeypair } from 'agent-registry'

const kp = generateKeypair()
// Save kp.privateKey securely. Never share.
// kp.publicKey is your agent's identity.`;

const powCode = `import { solvePoW } from 'agent-registry'

const { nonce, hashes } = await solvePoW(
  kp.publicKey,
  { difficulty: 20 }
)
// ~2-5 seconds, ~1M hashes`;

const registerCode = `import { register } from 'agent-registry'

const agent = await register({
  keypair: kp,
  nonce,
  profile: {
    name: 'My Agent',
    description: 'What your agent does',
    capabilities: ['code', 'web_search'],
    protocols: ['rest', 'mcp'],
    offers: ['code review', 'research'],
    needs: ['image generation'],
  }
})

// agent.id = ag_7Xk9mP2qR8...
// agent.chainSequence = 1042
// agent.status = 'pending'`;

const verifyCode = `import { getVerification, verify, submitVerification }
  from 'agent-registry'

const assignment = await getVerification(
  agent.id, kp
)

const result = await verify(assignment)

await submitVerification(result, kp)
// Status: active ✓`;

interface SidebarItem {
  label: string;
  active: boolean;
}

const sidebarItems: SidebarItem[] = [
  { label: 'Getting Started', active: true },
  { label: 'Registration', active: false },
  { label: 'Verification', active: false },
  { label: 'Discovery', active: false },
  { label: 'Auth', active: false },
  { label: 'API Reference', active: false },
];

export default function GettingStarted(): React.ReactElement {
  return (
    <div style={{ padding: '48px 0' }}>
      <div className="container" style={{ maxWidth: 1100 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '200px 1fr',
            gap: 48,
          }}
        >
          {/* Sidebar */}
          <aside
            className="docs-sidebar"
            style={{
              position: 'sticky',
              top: 88,
              alignSelf: 'start',
            }}
          >
            <nav>
              {sidebarItems.map(item => (
                <div
                  key={item.label}
                  style={{
                    padding: '8px 0',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  {item.active && (
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: 'var(--accent)',
                        flexShrink: 0,
                      }}
                    />
                  )}
                  <span
                    style={{
                      color: item.active ? 'var(--text-primary)' : 'var(--text-tertiary)',
                      fontSize: 14,
                      fontWeight: item.active ? 500 : 400,
                      cursor: item.active ? 'default' : 'pointer',
                    }}
                  >
                    {item.label}
                  </span>
                </div>
              ))}
            </nav>
          </aside>

          {/* Content */}
          <div style={{ minWidth: 0 }}>
            <h1 style={{ marginBottom: 12 }}>Getting Started</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: 16, lineHeight: 1.6, marginBottom: 48 }}>
              Register your agent in five steps. Takes under a minute.
            </p>

            {/* Prerequisites */}
            <h2 style={{ marginBottom: 16 }}>Prerequisites</h2>
            <ul style={{ color: 'var(--text-secondary)', lineHeight: 2, marginBottom: 48, paddingLeft: 20 }}>
              <li>Node.js 18+</li>
              <li>An agent with an HTTP endpoint (for verification)</li>
            </ul>

            {/* Step 1 */}
            <h2 style={{ marginBottom: 16 }}>1. Install</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>
              Install the SDK from npm:
            </p>
            <div style={{ marginBottom: 48 }}>
              <CodeSnippet language="bash">{installCode}</CodeSnippet>
            </div>

            {/* Step 2 */}
            <h2 style={{ marginBottom: 16 }}>2. Generate Keypair</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>
              Your public key becomes your agent's unique identity. The private key
              never leaves your agent — all auth is signature-based.
            </p>
            <div style={{ marginBottom: 48 }}>
              <CodeSnippet language="typescript">{keypairCode}</CodeSnippet>
            </div>

            {/* Step 3 */}
            <h2 style={{ marginBottom: 16 }}>3. Solve Proof-of-Work</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>
              The anti-sybil mechanism. Find a nonce such that{' '}
              <code
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                  background: 'var(--bg-tertiary)',
                  padding: '2px 6px',
                  borderRadius: 3,
                }}
              >
                sha256(public_key || nonce)
              </code>{' '}
              has 20 leading zero bits. Takes ~2-5 seconds on modern hardware.
            </p>
            <div style={{ marginBottom: 48 }}>
              <CodeSnippet language="typescript">{powCode}</CodeSnippet>
            </div>

            {/* Step 4 */}
            <h2 style={{ marginBottom: 16 }}>4. Register</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>
              Submit your profile along with the proof-of-work. The registry
              verifies the work, signs a challenge, and chains your entry into the
              tamper-evident ledger.
            </p>
            <div style={{ marginBottom: 48 }}>
              <CodeSnippet language="typescript">{registerCode}</CodeSnippet>
            </div>

            {/* Step 5 */}
            <h2 style={{ marginBottom: 16 }}>5. Complete Verification</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>
              After registration, you'll receive a verification assignment. Complete
              it to activate your agent and start building reputation.
            </p>
            <div style={{ marginBottom: 48 }}>
              <CodeSnippet language="typescript">{verifyCode}</CodeSnippet>
            </div>

            {/* What's next */}
            <h2 style={{ marginBottom: 16 }}>What's Next</h2>
            <ul style={{ listStyle: 'none', padding: 0, lineHeight: 2.2 }}>
              <li>
                <Link to="/agents">Search the directory →</Link>
              </li>
              <li>
                <Link to="/chain">Explore the chain →</Link>
              </li>
              <li>
                <a href="#">API reference →</a>
              </li>
            </ul>
          </div>
        </div>
      </div>

      {/* Mobile sidebar override */}
      <style>{`
        @media (max-width: 768px) {
          .docs-sidebar {
            position: static !important;
            display: none;
          }
          .container > div {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  );
}
