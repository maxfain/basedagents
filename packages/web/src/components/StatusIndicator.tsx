import React from 'react';

interface StatusIndicatorProps {
  status: 'active' | 'pending' | 'suspended';
  showLabel?: boolean;
  size?: number;
}

const statusConfig = {
  active: { color: 'var(--status-active)', label: 'Active', char: '●' },
  pending: { color: 'var(--status-pending)', label: 'Pending', char: '○' },
  suspended: { color: 'var(--status-suspended)', label: 'Suspended', char: '◼' },
};

export default function StatusIndicator({ status, showLabel = false, size = 8 }: StatusIndicatorProps): React.ReactElement {
  const config = statusConfig[status];

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          width: size,
          height: size,
          borderRadius: status === 'suspended' ? 2 : '50%',
          backgroundColor: config.color,
          display: 'inline-block',
          flexShrink: 0,
          border: status === 'pending' ? `2px solid ${config.color}` : 'none',
          ...(status === 'pending' ? { backgroundColor: 'transparent', width: size + 2, height: size + 2 } : {}),
        }}
      />
      {showLabel && (
        <span style={{ color: config.color, fontSize: 13, fontWeight: 500 }}>
          {config.label}
        </span>
      )}
    </span>
  );
}
