import React, { useRef, useState, useCallback } from 'react';
import { useAgentAuth } from '../hooks/useAgentAuth';

export default function KeypairLoader(): React.ReactElement {
  const { keypair, loadKeypair, clearKeypair, isAuthenticated } = useAgentAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      try {
        await loadKeypair(file);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load keypair');
      }
    },
    [loadKeypair]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
      // Reset so same file can be re-selected
      e.target.value = '';
    },
    [handleFile]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  if (isAuthenticated && keypair) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            borderRadius: 6,
            background: 'rgba(34,197,94,0.1)',
            border: '1px solid rgba(34,197,94,0.3)',
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            color: 'var(--status-active)',
            maxWidth: 200,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={keypair.agent_id}
        >
          <span style={{ fontSize: 10 }}>●</span>
          {keypair.agent_id.slice(0, 16)}…
        </span>
        <button
          onClick={clearKeypair}
          style={{
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 6,
            color: 'var(--text-tertiary)',
            cursor: 'pointer',
            fontSize: 12,
            padding: '4px 8px',
            transition: 'border-color 150ms ease, color 150ms ease',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-hover)';
            (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)';
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)';
            (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-tertiary)';
          }}
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <input
        ref={inputRef}
        type="file"
        accept=".json"
        style={{ display: 'none' }}
        onChange={handleChange}
      />
      <button
        onClick={() => inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        style={{
          background: dragging ? 'rgba(99,102,241,0.12)' : 'transparent',
          border: `1px solid ${dragging ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 6,
          color: dragging ? 'var(--accent)' : 'var(--text-secondary)',
          cursor: 'pointer',
          fontSize: 13,
          padding: '5px 12px',
          transition: 'all 150ms ease',
          whiteSpace: 'nowrap',
        }}
        onMouseEnter={e => {
          if (!dragging) {
            (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-hover)';
            (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)';
          }
        }}
        onMouseLeave={e => {
          if (!dragging) {
            (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)';
            (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)';
          }
        }}
        title="Load keypair JSON to verify agents"
      >
        Load Keypair
      </button>
      {error && (
        <span style={{ fontSize: 12, color: 'var(--status-suspended)' }} title={error}>
          ⚠ Error
        </span>
      )}
    </div>
  );
}
