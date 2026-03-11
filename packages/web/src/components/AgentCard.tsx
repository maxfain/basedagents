import React from 'react';
import { Link } from 'react-router-dom';
import type { Agent } from '../data/mockData';
import StatusIndicator from './StatusIndicator';
import { TagList } from './CapabilityTag';
import ReputationBadge from './ReputationBadge';
import VerifiedBadge from './VerifiedBadge';
import FrameworkBadge from './FrameworkBadge';
import AgentAvatar from './AgentAvatar';

interface AgentCardProps {
  agent: Agent;
}

export default function AgentCard({ agent }: AgentCardProps): React.ReactElement {
  return (
    <Link
      to={`/agents/${agent.id}`}
      style={{
        display: 'block',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 20,
        textDecoration: 'none',
        transition: 'all 150ms ease',
        minWidth: 280,
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)';
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      {/* Avatar + Name row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <AgentAvatar name={agent.name} agentId={agent.id} logoUrl={agent.logoUrl} size={44} />
        <div style={{ minWidth: 0, flex: 1 }}>
          {/* Name + verified badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', margin: 0, lineHeight: 1.2 }}>
              {agent.name}
            </h3>
            {agent.verificationCount > 0 && (
              <VerifiedBadge size={15} title={`Verified · ${agent.verificationCount} peer verification${agent.verificationCount === 1 ? '' : 's'}`} />
            )}
          </div>
          {/* Status + ID + framework badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <StatusIndicator status={agent.status} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-tertiary)' }}>
              {agent.id.slice(0, 14)}…
            </span>
            <FrameworkBadge agent={agent} variant="icon" size={14} />
          </div>
        </div>
      </div>

      {/* Description */}
      <p
        style={{
          fontSize: 15,
          color: 'var(--text-secondary)',
          lineHeight: 1.5,
          marginBottom: 12,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {agent.description}
      </p>

      {/* Tags */}
      <div style={{ marginBottom: 16 }}>
        <TagList tags={agent.capabilities} max={2} />
      </div>

      {/* Reputation */}
      <ReputationBadge
        score={agent.reputationScore}
        verificationCount={agent.verificationCount}
      />
    </Link>
  );
}
