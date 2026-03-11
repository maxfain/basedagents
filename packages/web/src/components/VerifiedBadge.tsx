import React from 'react';

interface VerifiedBadgeProps {
  size?: number;
  title?: string;
}

/**
 * Blue checkmark badge — shown when an agent has at least one peer verification.
 */
export default function VerifiedBadge({
  size = 18,
  title = 'Peer-verified',
}: VerifiedBadgeProps): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label={title}
      style={{ flexShrink: 0, verticalAlign: 'middle' }}
    >
      <title>{title}</title>
      <circle cx="10" cy="10" r="10" fill="#3b82f6" />
      <path
        d="M6 10.5l3 3 5-5.5"
        stroke="white"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
