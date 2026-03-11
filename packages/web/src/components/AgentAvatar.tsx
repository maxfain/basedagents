import React, { useState } from 'react';

interface AgentAvatarProps {
  name: string;
  agentId: string;
  logoUrl?: string | null;
  size?: number;
}

/** Derive a consistent hue from a string (agent ID). */
function idToHue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

/** 1–2 initials from agent name. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export default function AgentAvatar({
  name,
  agentId,
  logoUrl,
  size = 44,
}: AgentAvatarProps): React.ReactElement {
  const [imgError, setImgError] = useState(false);

  const hue = idToHue(agentId);
  const bg = `hsl(${hue}, 55%, 32%)`;
  const fg = `hsl(${hue}, 80%, 88%)`;
  const border = `hsl(${hue}, 50%, 42%)`;

  const showImage = !!logoUrl && !imgError;

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        overflow: 'hidden',
        border: `1.5px solid ${showImage ? 'var(--border)' : border}`,
        background: showImage ? 'var(--bg-tertiary)' : bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 600,
        fontSize: size * 0.36,
        color: fg,
        letterSpacing: '-0.02em',
        userSelect: 'none',
      }}
    >
      {showImage ? (
        <img
          src={logoUrl!}
          alt={name}
          onError={() => setImgError(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        initials(name)
      )}
    </div>
  );
}
