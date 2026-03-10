import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ChainEntry } from '../data/mockData';
import { truncateHash } from '../data/mockData';
import StatusIndicator from './StatusIndicator';

interface ChainEntryRowProps {
  entry: ChainEntry;
}

export default function ChainEntryRow({ entry }: ChainEntryRowProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);

  const ts = new Date(entry.timestamp);
  const dateStr = ts.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  return (
    <div
      style={{
        borderBottom: '1px solid var(--border)',
        padding: '16px 0',
        cursor: 'pointer',
        transition: 'background 150ms ease',
      }}
      onClick={() => setExpanded(!expanded)}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      {/* Line 1 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            color: 'var(--text-primary)',
            minWidth: 60,
          }}
        >
          #{entry.sequence}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            color: 'var(--hash)',
            fontSize: 14,
          }}
        >
          {truncateHash(entry.entryHash)}
        </span>
        <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>←</span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-tertiary)',
            fontSize: 14,
          }}
        >
          {truncateHash(entry.previousHash)}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusIndicator status={entry.agentStatus} />
          <Link
            to={`/agents/${entry.agentId}`}
            onClick={e => e.stopPropagation()}
            style={{ color: 'var(--text-primary)', fontSize: 14, fontWeight: 500 }}
          >
            {entry.agentName}
          </Link>
        </span>
      </div>

      {/* Line 2 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          marginTop: 4,
          paddingLeft: 76,
        }}
      >
        <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{dateStr}</span>
        <Link
          to={`/agents/${entry.agentId}`}
          onClick={e => e.stopPropagation()}
          style={{
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-tertiary)',
            fontSize: 13,
          }}
        >
          {entry.agentId.slice(0, 16)}...
        </Link>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div
          style={{
            marginTop: 16,
            padding: 16,
            background: 'var(--bg-tertiary)',
            borderRadius: 8,
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            lineHeight: 2,
          }}
        >
          <div>
            <span style={{ color: 'var(--text-tertiary)' }}>Sequence:{'     '}</span>
            <span style={{ color: 'var(--text-primary)' }}>#{entry.sequence}</span>
          </div>
          <div>
            <span style={{ color: 'var(--text-tertiary)' }}>Entry Hash:{'   '}</span>
            <span style={{ color: 'var(--hash)' }}>{entry.entryHash}</span>
          </div>
          <div>
            <span style={{ color: 'var(--text-tertiary)' }}>Previous Hash: </span>
            <span style={{ color: 'var(--text-tertiary)' }}>{entry.previousHash}</span>
          </div>
          <div>
            <span style={{ color: 'var(--text-tertiary)' }}>Profile Hash:{'  '}</span>
            <span style={{ color: 'var(--text-secondary)' }}>{entry.profileHash}</span>
          </div>
          <div>
            <span style={{ color: 'var(--text-tertiary)' }}>Nonce:{'         '}</span>
            <span style={{ color: 'var(--text-secondary)' }}>{entry.nonce}</span>
          </div>
          <div>
            <span style={{ color: 'var(--text-tertiary)' }}>Agent:{'         '}</span>
            <Link to={`/agents/${entry.agentId}`} style={{ color: 'var(--accent)' }}>
              {entry.agentId}
            </Link>
          </div>
          <div>
            <span style={{ color: 'var(--text-tertiary)' }}>Timestamp:{'    '}</span>
            <span style={{ color: 'var(--text-secondary)' }}>{entry.timestamp}</span>
          </div>
        </div>
      )}
    </div>
  );
}
