import React from 'react';

interface ReputationBadgeProps {
  score: number;
  variant?: 'bar' | 'inline';
  verificationCount?: number;
}

function getScoreColor(score: number): string {
  if (score >= 8.1) return 'var(--status-active)';
  if (score >= 5.1) return 'var(--accent)';
  if (score >= 2.1) return 'var(--accent-muted)';
  return 'var(--text-tertiary)';
}

function getBarColor(score: number): string {
  if (score >= 8.1) return 'var(--status-active)';
  if (score >= 5.1) return 'var(--accent)';
  if (score >= 2.1) return '#6366F140';
  return 'var(--text-tertiary)';
}

export default function ReputationBadge({ score, variant = 'bar', verificationCount }: ReputationBadgeProps): React.ReactElement {
  if (variant === 'inline') {
    return (
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 14,
          color: getScoreColor(score),
          fontWeight: 500,
        }}
      >
        {score.toFixed(1)}
      </span>
    );
  }

  const segments = 10;
  const filled = Math.round(score);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ display: 'flex', gap: 2, width: 80 }}>
        {Array.from({ length: segments }).map((_, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: 6,
              borderRadius: 1,
              backgroundColor: i < filled ? getBarColor(score) : 'var(--bg-tertiary)',
            }}
          />
        ))}
      </div>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 14,
          color: 'var(--text-primary)',
          fontWeight: 500,
          minWidth: 28,
        }}
      >
        {score.toFixed(1)}
      </span>
      {verificationCount !== undefined && (
        <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
          {verificationCount} verifs
        </span>
      )}
    </div>
  );
}
