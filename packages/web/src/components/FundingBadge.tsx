import React from 'react';
import type { ApiTask } from '../api/types';
import { fundingState, type FundingTone } from '../lib/funding';

/**
 * The chip next to a bounty that says where the money is: "Funded" (lock) when
 * the USDC sits in the registry's escrow wallet, "Pay at accept" (dashed) when
 * the bounty is only declared, and the in-between and terminal states with the
 * same wording as the task page's Payment panel. Renders nothing on a task
 * without a bounty. The mapping lives in lib/funding.ts.
 */
const TONE_COLORS: Record<FundingTone, { bg: string; color: string; border: string }> = {
  held: { bg: 'rgba(56, 189, 248, 0.15)', color: '#38BDF8', border: 'rgba(56, 189, 248, 0.35)' },
  paid: { bg: 'rgba(34, 197, 94, 0.15)', color: '#22C55E', border: 'rgba(34, 197, 94, 0.35)' },
  pending: { bg: 'rgba(245, 158, 11, 0.15)', color: '#F59E0B', border: 'rgba(245, 158, 11, 0.35)' },
  failed: { bg: 'rgba(239, 68, 68, 0.15)', color: '#EF4444', border: 'rgba(239, 68, 68, 0.35)' },
  void: { bg: 'rgba(113, 113, 122, 0.15)', color: '#71717A', border: 'rgba(113, 113, 122, 0.3)' },
  declared: { bg: 'transparent', color: '#A1A1AA', border: 'rgba(161, 161, 170, 0.45)' },
};

function LockIcon({ size }: { size: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="2" y="5.5" width="8" height="5.5" rx="1.2" fill="currentColor" />
      <path d="M3.75 5.5V3.75a2.25 2.25 0 0 1 4.5 0V5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

interface FundingBadgeProps {
  task: ApiTask;
  /** `sm` sits beside the bounty chip in a list row; `md` matches the status badge on the task page. */
  size?: 'sm' | 'md';
}

export function FundingBadge({ task, size = 'sm' }: FundingBadgeProps): React.ReactElement | null {
  const state = fundingState(task);
  if (!state) return null;
  const c = TONE_COLORS[state.tone];
  const sm = size === 'sm';
  return (
    <span
      title={state.title}
      data-funding={state.key}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: sm ? '1px 6px' : '3px 10px',
        borderRadius: sm ? 3 : 5,
        fontSize: sm ? 11 : 12,
        fontWeight: 600,
        fontFamily: 'var(--font-sans)',
        lineHeight: 1.4,
        background: c.bg,
        color: c.color,
        border: `1px ${state.tone === 'declared' ? 'dashed' : 'solid'} ${c.border}`,
        whiteSpace: 'nowrap',
        verticalAlign: 'middle',
      }}
    >
      {state.tone === 'held' && <LockIcon size={sm ? 10 : 12} />}
      {state.label}
    </span>
  );
}
