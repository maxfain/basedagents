import React from 'react';
import type { Agent } from '../data/mockData';

/**
 * Detect the runtime framework from an agent's tags and skills.
 * Returns null if no known framework is detected.
 */
export type Framework = 'openclaw' | 'claude-code' | null;

export function detectFramework(agent: Pick<Agent, 'tags' | 'skills'>): Framework {
  const tags = agent.tags ?? [];
  if (tags.includes('openclaw')) return 'openclaw';
  if (tags.includes('claude-code') || tags.includes('claude')) return 'claude-code';
  // Also infer OpenClaw from clawhub skills
  if (agent.skills?.some(s => s.registry === 'clawhub')) return 'openclaw';
  return null;
}

// ─── OpenClaw icon — orange claw/pincer ───
function OpenClawIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0 }}
    >
      {/* Palm */}
      <ellipse cx="10" cy="13" rx="4.5" ry="3.5" fill="#e8713c" />
      {/* Upper claw */}
      <path
        d="M8.5 13 C7 10 5.5 7.5 7 5.5 C8 4 10 4.5 10 6.5 C10 8 9 9.5 9.5 11"
        stroke="#e8713c"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />
      {/* Lower claw */}
      <path
        d="M11.5 13 C13 10 14.5 7.5 13 5.5 C12 4 10 4.5 10 6.5 C10 8 11 9.5 10.5 11"
        stroke="#e8713c"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />
      {/* Claw gap highlight */}
      <path
        d="M9.8 6.5 C9.9 7.2 10.1 7.2 10.2 6.5"
        stroke="#fff"
        strokeWidth="0.8"
        strokeLinecap="round"
        fill="none"
        opacity="0.6"
      />
    </svg>
  );
}

// ─── Claude Code icon — Anthropic's amber spark/diamond ───
function ClaudeIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0 }}
    >
      {/* Anthropic-style diamond/star mark in Claude's signature amber */}
      <path
        d="M10 2 L12.5 8.5 L19 10 L12.5 11.5 L10 18 L7.5 11.5 L1 10 L7.5 8.5 Z"
        fill="#D97757"
      />
      {/* Subtle inner highlight */}
      <path
        d="M10 5 L11.5 9 L15.5 10 L11.5 11 L10 15 L8.5 11 L4.5 10 L8.5 9 Z"
        fill="#F0A882"
        opacity="0.5"
      />
    </svg>
  );
}

const FRAMEWORK_CONFIG = {
  openclaw: {
    label: 'OpenClaw',
    Icon: OpenClawIcon,
    color: '#e8713c',
    bg: 'rgba(232, 113, 60, 0.1)',
    border: 'rgba(232, 113, 60, 0.25)',
  },
  'claude-code': {
    label: 'Claude Code',
    Icon: ClaudeIcon,
    color: '#D97757',
    bg: 'rgba(217, 119, 87, 0.1)',
    border: 'rgba(217, 119, 87, 0.25)',
  },
} as const;

interface FrameworkBadgeProps {
  agent: Pick<Agent, 'tags' | 'skills'>;
  /** 'icon' = icon only (for inline use next to name), 'pill' = icon + label */
  variant?: 'icon' | 'pill';
  size?: number;
}

export default function FrameworkBadge({
  agent,
  variant = 'icon',
  size = 18,
}: FrameworkBadgeProps): React.ReactElement | null {
  const framework = detectFramework(agent);
  if (!framework) return null;

  const cfg = FRAMEWORK_CONFIG[framework];

  if (variant === 'icon') {
    return (
      <span
        title={cfg.label}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size + 4,
          height: size + 4,
          borderRadius: '50%',
          background: cfg.bg,
          border: `1px solid ${cfg.border}`,
          flexShrink: 0,
          cursor: 'default',
        }}
      >
        <cfg.Icon size={size - 2} />
      </span>
    );
  }

  // pill variant
  return (
    <span
      title={cfg.label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 8px 3px 6px',
        borderRadius: 20,
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
        fontSize: 12,
        fontWeight: 500,
        color: cfg.color,
        flexShrink: 0,
        cursor: 'default',
        whiteSpace: 'nowrap',
      }}
    >
      <cfg.Icon size={13} />
      {cfg.label}
    </span>
  );
}
