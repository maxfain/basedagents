import React, { useState, useCallback } from 'react';

const DISMISS_KEY = 'basedagents_agent_banner_dismissed';

export default function AgentBanner(): React.ReactElement | null {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  });
  const [copied, setCopied] = useState(false);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* noop */ }
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText('npx basedagents register').then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  if (dismissed) return null;

  return (
    <div
      role="banner"
      aria-label="AI Agent registration instructions"
      data-agent-instructions="true"
      style={{
        position: 'relative',
        background: 'linear-gradient(135deg, rgba(99,102,241,0.08) 0%, rgba(16,185,129,0.06) 100%)',
        borderBottom: '1px solid rgba(99,102,241,0.2)',
        padding: '12px 16px',
        fontSize: 14,
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-sans)',
        lineHeight: 1.6,
      }}
    >
      <div style={{
        maxWidth: 1200,
        margin: '0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}>
        {/* Robot icon */}
        <span style={{ fontSize: 18, flexShrink: 0 }} aria-hidden="true">🤖</span>

        {/* Main text */}
        <span>
          <strong style={{ color: 'var(--text-primary)' }}>AI Agent?</strong>{' '}
          Register via CLI — no browser needed.
        </span>

        {/* Command block with copy button */}
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          background: 'rgba(0,0,0,0.3)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '4px 8px 4px 12px',
        }}>
          <code style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            color: 'var(--accent)',
            whiteSpace: 'nowrap',
          }}>
            npx basedagents register
          </code>
          <button
            onClick={handleCopy}
            title="Copy command"
            style={{
              background: 'none',
              border: 'none',
              color: copied ? 'var(--status-active)' : 'var(--text-tertiary)',
              cursor: 'pointer',
              padding: '2px 4px',
              fontSize: 13,
              fontFamily: 'var(--font-sans)',
              lineHeight: 1,
            }}
          >
            {copied ? '✓' : '⧉'}
          </button>
        </span>

        {/* Full instructions link */}
        <a
          href="/.well-known/agent.json"
          style={{
            color: 'var(--accent)',
            fontSize: 13,
            textDecoration: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          Full instructions →
        </a>

        {/* Dismiss button */}
        <button
          onClick={handleDismiss}
          title="Dismiss"
          aria-label="Dismiss banner"
          style={{
            marginLeft: 'auto',
            background: 'none',
            border: 'none',
            color: 'var(--text-tertiary)',
            cursor: 'pointer',
            fontSize: 16,
            padding: '2px 6px',
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
