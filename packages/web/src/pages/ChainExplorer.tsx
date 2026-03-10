import React, { useState } from 'react';
import { mockChainEntries } from '../data/mockData';
import ChainEntryRow from '../components/ChainEntryRow';
import CodeSnippet from '../components/CodeSnippet';

const verifyCommand = `$ curl https://agentregistry.org/v1/chain?from=1&to=100 | \\
  agent-registry verify-chain

✓ 100 entries verified
✓ Chain integrity intact`;

export default function ChainExplorer(): React.ReactElement {
  const [jumpTo, setJumpTo] = useState('');

  return (
    <div style={{ padding: '48px 0' }}>
      <div className="container">
        {/* Header */}
        <h1 style={{ marginBottom: 4 }}>Chain Explorer</h1>
        <p style={{ color: 'var(--text-tertiary)', marginBottom: 32 }}>
          {mockChainEntries.length.toLocaleString()} entries ·{' '}
          <span style={{ color: 'var(--status-active)' }}>✓ verified</span>
        </p>

        {/* Jump to */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 32 }}>
          <input
            type="text"
            placeholder="Jump to sequence #"
            value={jumpTo}
            onChange={e => setJumpTo(e.target.value)}
            style={{
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '8px 12px',
              color: 'var(--text-primary)',
              fontSize: 14,
              fontFamily: 'var(--font-mono)',
              width: 180,
              outline: 'none',
            }}
          />
          <button className="btn btn-secondary" style={{ padding: '8px 16px', fontSize: 14 }}>
            Go
          </button>
        </div>

        {/* Entries */}
        <div style={{ marginBottom: 48 }}>
          {mockChainEntries.map(entry => (
            <ChainEntryRow key={entry.sequence} entry={entry} />
          ))}
        </div>

        {/* Navigation */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 64 }}>
          <button className="btn btn-secondary" style={{ fontSize: 14, padding: '8px 16px' }}>
            ← Newer
          </button>
          <button className="btn btn-secondary" style={{ fontSize: 14, padding: '8px 16px' }}>
            Older →
          </button>
        </div>

        {/* Verification info */}
        <div
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 32,
          }}
        >
          <h2 style={{ fontSize: 18, marginBottom: 8 }}>Chain Verification</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 20, fontSize: 15 }}>
            Anyone can verify the full chain:
          </p>
          <CodeSnippet terminal>{verifyCommand}</CodeSnippet>
        </div>
      </div>
    </div>
  );
}
