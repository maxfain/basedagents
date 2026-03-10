import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { getAgentById, getVerificationsForAgent, truncateHash, formatTimeAgo } from '../data/mockData';
import StatusIndicator from '../components/StatusIndicator';
import { TagList } from '../components/CapabilityTag';
import ReputationBadge from '../components/ReputationBadge';

export default function AgentProfile(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const agent = getAgentById(id || '');
  const verifications = getVerificationsForAgent(id || '');

  if (!agent) {
    return (
      <div className="container" style={{ padding: '96px 0', textAlign: 'center' }}>
        <h1>Agent not found</h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: 8 }}>
          No agent with ID <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--hash)' }}>{id}</code>
        </p>
        <Link to="/agents" className="btn btn-primary" style={{ marginTop: 24, display: 'inline-flex' }}>
          ← Back to Directory
        </Link>
      </div>
    );
  }

  return (
    <div style={{ padding: '48px 0' }}>
      <div className="container">
        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <StatusIndicator status={agent.status} size={10} />
            <h1 style={{ margin: 0 }}>{agent.name}</h1>
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 14,
              color: 'var(--text-tertiary)',
              marginBottom: 16,
            }}
          >
            {agent.id}
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: 16, lineHeight: 1.6, maxWidth: 640 }}>
            {agent.description}
          </p>
        </div>

        {/* Score card */}
        <div
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 20,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 24,
            marginBottom: 32,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 8 }}>
              Reputation Score
            </div>
            <ReputationBadge score={agent.reputationScore} verificationCount={agent.verificationCount} />
          </div>
          <div style={{ borderLeft: '1px solid var(--border)', paddingLeft: 24 }}>
            <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 8 }}>
              Status
            </div>
            <StatusIndicator status={agent.status} showLabel size={10} />
          </div>
        </div>

        {/* Capabilities */}
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ color: 'var(--text-tertiary)', fontSize: 13, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
            Capabilities
          </h3>
          <TagList tags={agent.capabilities} />
        </div>

        {/* Protocols */}
        <div style={{ marginBottom: 32 }}>
          <h3 style={{ color: 'var(--text-tertiary)', fontSize: 13, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
            Protocols
          </h3>
          <TagList tags={agent.protocols} variant="protocol" />
        </div>

        {/* Offers / Needs */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, marginBottom: 48 }}>
          <div>
            <h3 style={{ color: 'var(--text-tertiary)', fontSize: 13, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
              Offers
            </h3>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {agent.offers.map(o => (
                <li key={o} style={{ color: 'var(--text-secondary)', fontSize: 15, padding: '4px 0' }}>
                  {o}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 style={{ color: 'var(--text-tertiary)', fontSize: 13, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
              Needs
            </h3>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {agent.needs.map(n => (
                <li key={n} style={{ color: 'var(--text-secondary)', fontSize: 15, padding: '4px 0' }}>
                  {n}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Chain Entry */}
        <div
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 24,
            marginBottom: 48,
          }}
        >
          <h2 style={{ fontSize: 18, marginBottom: 16 }}>Chain Entry</h2>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 14,
              lineHeight: 2.2,
            }}
          >
            <div>
              <span style={{ color: 'var(--text-tertiary)', display: 'inline-block', width: 120 }}>Sequence</span>
              <span style={{ color: 'var(--text-primary)' }}>#{agent.chainSequence}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-tertiary)', display: 'inline-block', width: 120 }}>Hash</span>
              <span style={{ color: 'var(--hash)' }}>{truncateHash(agent.entryHash, 20)}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-tertiary)', display: 'inline-block', width: 120 }}>Previous</span>
              <span style={{ color: 'var(--text-tertiary)' }}>{truncateHash(agent.previousHash, 20)}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-tertiary)', display: 'inline-block', width: 120 }}>PoW Nonce</span>
              <span style={{ color: 'var(--text-secondary)' }}>{agent.nonce}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-tertiary)', display: 'inline-block', width: 120 }}>Registered</span>
              <span style={{ color: 'var(--text-tertiary)' }}>{agent.registeredAt}</span>
            </div>
          </div>
          <Link to="/chain" style={{ display: 'inline-block', marginTop: 16, fontSize: 14 }}>
            View in Chain →
          </Link>
        </div>

        {/* Verification History */}
        <div>
          <h2 style={{ fontSize: 18, marginBottom: 16 }}>Verification History</h2>
          {verifications.length > 0 ? (
            <div>
              {verifications.map(v => (
                <div
                  key={v.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 16,
                    padding: '12px 0',
                    borderBottom: '1px solid var(--border)',
                    flexWrap: 'wrap',
                    transition: 'background 150ms ease',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <span
                    style={{
                      color: v.result === 'pass' ? 'var(--status-active)' : 'var(--status-suspended)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 14,
                      minWidth: 60,
                    }}
                  >
                    {v.result === 'pass' ? '✓' : '✗'} {v.result}
                  </span>
                  <span style={{ fontSize: 14, color: 'var(--text-tertiary)' }}>
                    by{' '}
                    <Link
                      to={`/agents/${v.verifierId}`}
                      style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}
                    >
                      {v.verifierId.slice(0, 12)}...
                    </Link>
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--text-secondary)' }}>
                    coherence: {v.coherenceScore.toFixed(2)}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--text-tertiary)' }}>
                    {formatTimeAgo(v.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ color: 'var(--text-tertiary)', fontSize: 14 }}>
              No verifications recorded yet.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
