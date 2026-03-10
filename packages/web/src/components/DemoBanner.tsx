import React from 'react';

interface DemoBannerProps {
  visible: boolean;
}

export default function DemoBanner({ visible }: DemoBannerProps): React.ReactElement | null {
  if (!visible) return null;
  return (
    <div
      style={{
        background: 'rgba(99, 102, 241, 0.1)',
        border: '1px solid rgba(99, 102, 241, 0.2)',
        borderRadius: 8,
        padding: '10px 16px',
        marginBottom: 24,
        fontSize: 14,
        color: 'var(--accent)',
        fontFamily: 'var(--font-mono)',
      }}
    >
      Showing demo data — API unavailable
    </div>
  );
}
