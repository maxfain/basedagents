import React, { useState, useCallback } from 'react';
import { useChain } from '../hooks';
import ChainEntryRow from '../components/ChainEntryRow';
import CodeSnippet from '../components/CodeSnippet';
import DemoBanner from '../components/DemoBanner';

const PAGE_SIZE = 20;

const verifyCommand = `$ curl https://api.basedagents.ai/v1/chain?from=1&to=100 | \\
  basedagents verify-chain

✓ 100 entries verified
✓ Chain integrity intact`;

export default function ChainExplorer(): React.ReactElement {
  const [jumpTo, setJumpTo] = useState('');
  // Page tracks the "to" end of the range. undefined = latest
  const [rangeEnd, setRangeEnd] = useState<number | undefined>(undefined);

  const from = rangeEnd !== undefined ? Math.max(1, rangeEnd - PAGE_SIZE + 1) : undefined;
  const to = rangeEnd;

  const { entries, latestSequence, total, loading, usingMock } = useChain(from, to);

  const handleJump = useCallback(() => {
    const seq = parseInt(jumpTo, 10);
    if (!isNaN(seq) && seq >= 1) {
      setRangeEnd(seq);
    }
  }, [jumpTo]);

  const handleNewer = useCallback(() => {
    if (rangeEnd === undefined) return; // already at latest
    const newEnd = Math.min(rangeEnd + PAGE_SIZE, latestSequence);
    if (newEnd >= latestSequence) {
      setRangeEnd(undefined); // go back to latest
    } else {
      setRangeEnd(newEnd);
    }
  }, [rangeEnd, latestSequence]);

  const handleOlder = useCallback(() => {
    const currentEnd = rangeEnd ?? latestSequence;
    const newEnd = currentEnd - PAGE_SIZE;
    if (newEnd >= 1) {
      setRangeEnd(newEnd);
    }
  }, [rangeEnd, latestSequence]);

  const currentEnd = rangeEnd ?? latestSequence;
  const canGoNewer = rangeEnd !== undefined;
  const canGoOlder = currentEnd > PAGE_SIZE;

  return (
    <div style={{ padding: '48px 0' }}>
      <div className="container">
        <DemoBanner visible={usingMock} />

        {/* Header */}
        <h1 style={{ marginBottom: 4 }}>Chain Explorer</h1>
        <p style={{ color: 'var(--text-tertiary)', marginBottom: 32 }}>
          {loading
            ? '...'
            : (
              <>
                {total.toLocaleString()} entries ·{' '}
                <span style={{ color: 'var(--status-active)' }}>✓ verified</span>
              </>
            )
          }
        </p>

        {/* Jump to */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 32 }}>
          <input
            type="text"
            placeholder="Jump to sequence #"
            value={jumpTo}
            onChange={e => setJumpTo(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleJump()}
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
          <button className="btn btn-secondary" style={{ padding: '8px 16px', fontSize: 14 }} onClick={handleJump}>
            Go
          </button>
        </div>

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-tertiary)' }}>
            <p>Loading chain entries...</p>
          </div>
        )}

        {/* Entries */}
        {!loading && (
          <div style={{ marginBottom: 48 }}>
            {entries.map(entry => (
              <ChainEntryRow key={entry.sequence} entry={entry} />
            ))}
            {entries.length === 0 && (
              <p style={{ color: 'var(--text-tertiary)', textAlign: 'center', padding: '48px 0' }}>
                No entries in this range.
              </p>
            )}
          </div>
        )}

        {/* Navigation */}
        {!loading && (
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 64 }}>
            <button
              className="btn btn-secondary"
              style={{ fontSize: 14, padding: '8px 16px', opacity: canGoNewer ? 1 : 0.4 }}
              onClick={handleNewer}
              disabled={!canGoNewer}
            >
              ← Newer
            </button>
            <button
              className="btn btn-secondary"
              style={{ fontSize: 14, padding: '8px 16px', opacity: canGoOlder ? 1 : 0.4 }}
              onClick={handleOlder}
              disabled={!canGoOlder}
            >
              Older →
            </button>
          </div>
        )}

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
