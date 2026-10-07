import React from 'react';

interface AgentIdBadgeProps {
  size?: number;
  title?: string;
}

/**
 * Green checkmark badge — shown when an agent has linked a verified AgentID
 * (agentid.com). Deliberately a different colour from the blue peer-verified
 * VerifiedBadge so the two trust signals never get conflated.
 */
export default function AgentIdBadge({
  size = 18,
  title = 'AgentID verified',
}: AgentIdBadgeProps): React.ReactElement {
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
      <circle cx="10" cy="10" r="10" fill="#16a34a" />
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
