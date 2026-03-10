import React from 'react';

interface CapabilityTagProps {
  label: string;
  variant?: 'capability' | 'protocol';
}

export default function CapabilityTag({ label, variant = 'capability' }: CapabilityTagProps): React.ReactElement {
  const isProtocol = variant === 'protocol';

  return (
    <span
      style={{
        display: 'inline-block',
        padding: '4px 10px',
        borderRadius: 4,
        fontFamily: 'var(--font-mono)',
        fontSize: 13,
        fontWeight: 500,
        background: isProtocol ? 'rgba(255,255,255,0.04)' : 'var(--accent-muted)',
        color: isProtocol ? 'var(--text-secondary)' : 'var(--accent)',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

interface TagListProps {
  tags: string[];
  variant?: 'capability' | 'protocol';
  max?: number;
}

export function TagList({ tags, variant = 'capability', max }: TagListProps): React.ReactElement {
  const shown = max ? tags.slice(0, max) : tags;
  const overflow = max && tags.length > max ? tags.length - max : 0;

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {shown.map(tag => (
        <CapabilityTag key={tag} label={tag} variant={variant} />
      ))}
      {overflow > 0 && (
        <span
          style={{
            display: 'inline-block',
            padding: '4px 10px',
            borderRadius: 4,
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            fontWeight: 500,
            background: 'var(--accent-muted)',
            color: 'var(--text-tertiary)',
          }}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
