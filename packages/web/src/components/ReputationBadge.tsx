import React from 'react';

interface ReputationBadgeProps {
  score: number;           // [0, 1]
  verificationCount?: number;
  variant?: 'bar' | 'inline';
}

function getScoreColor(score: number): string {
  if (score >= 0.80) return 'var(--status-active)';   // green  — trusted
  if (score >= 0.50) return 'var(--accent)';           // blue   — established
  if (score >= 0.20) return '#a78bfa';                 // purple — emerging
  return 'var(--text-tertiary)';                       // gray   — new / unverified
}

function getScoreLabel(score: number, verificationCount?: number): string {
  if ((verificationCount ?? 0) === 0) return 'New';
  if (score >= 0.80) return 'Trusted';
  if (score >= 0.50) return 'Established';
  if (score >= 0.20) return 'Emerging';
  return 'Unverified';
}

export default function ReputationBadge({
  score,
  verificationCount,
  variant = 'bar',
}: ReputationBadgeProps): React.ReactElement {
  const color = getScoreColor(score);
  const pct = Math.min(100, Math.round(score * 100));

  if (variant === 'inline') {
    return (
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color, fontWeight: 500 }}>
        {score.toFixed(2)}
      </span>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {/* Continuous fill bar */}
      <div
        style={{
          width: 80,
          height: 6,
          borderRadius: 3,
          background: 'var(--bg-tertiary)',
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: 3,
            background: color,
            transition: 'width 400ms ease',
          }}
        />
      </div>

      {/* Score */}
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          color: 'var(--text-primary)',
          fontWeight: 500,
          minWidth: 32,
        }}
      >
        {score.toFixed(2)}
      </span>

      {/* Label */}
      <span style={{ fontSize: 12, color, fontWeight: 500 }}>
        {getScoreLabel(score, verificationCount)}
      </span>

      {/* Verification count */}
      {verificationCount !== undefined && verificationCount > 0 && (
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          · {verificationCount}v
        </span>
      )}
    </div>
  );
}
