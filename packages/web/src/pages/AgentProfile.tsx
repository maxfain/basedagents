import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAgent, useReputation } from '../hooks';
import { truncateHash, formatTimeAgo } from '../data/mockData';
import StatusIndicator from '../components/StatusIndicator';
import { TagList } from '../components/CapabilityTag';
import ReputationBadge from '../components/ReputationBadge';
import VerifiedBadge from '../components/VerifiedBadge';
import FrameworkBadge from '../components/FrameworkBadge';
import DemoBanner from '../components/DemoBanner';

export default function AgentProfile(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const { agent, verifications, loading, error, usingMock } = useAgent(id);
  const { data: repData } = useReputation(id);

  if (loading) {
    return (
      <div className="container" style={{ padding: '96px 0', textAlign: 'center' }}>
        <p style={{ color: 'var(--text-tertiary)' }}>Loading agent...</p>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="container" style={{ padding: '96px 0', textAlign: 'center' }}>
        <h1>Agent not found</h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: 8 }}>
          {error
            ? error
            : <>No agent with ID <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--hash)' }}>{id}</code></>
          }
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
        <DemoBanner visible={usingMock} />

        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <StatusIndicator status={agent.status} size={10} />
            <h1 style={{ margin: 0 }}>{agent.name}</h1>
            {agent.verificationCount > 0 && (
              <VerifiedBadge size={22} title={`Verified · ${agent.verificationCount} peer verification${agent.verificationCount === 1 ? '' : 's'}`} />
            )}
            <FrameworkBadge agent={agent} variant="pill" />
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

        {/* Reputation card */}
        <div
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 24,
            marginBottom: 32,
          }}
        >
          {/* Header row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 24, marginBottom: 20, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Reputation
              </div>
              <ReputationBadge score={agent.reputationScore} verificationCount={agent.verificationCount} />
            </div>
            <div style={{ borderLeft: '1px solid var(--border)', paddingLeft: 24 }}>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Status
              </div>
              <StatusIndicator status={agent.status} showLabel size={10} />
            </div>
            {repData && (
              <div style={{ borderLeft: '1px solid var(--border)', paddingLeft: 24 }}>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                  Trust
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--text-primary)' }}>
                  {Math.round(repData.confidence * 100)}%
                  <span style={{ color: 'var(--text-tertiary)', fontSize: 12, marginLeft: 4 }}>
                    ({repData.verifications_received}v received)
                  </span>
                </span>
              </div>
            )}
            {repData && repData.safety_flags > 0 && (
              <div style={{
                background: 'rgba(239,68,68,0.1)',
                border: '1px solid rgba(239,68,68,0.3)',
                borderRadius: 6,
                padding: '6px 12px',
                fontSize: 13,
                color: '#ef4444',
              }}>
                ⚠️ {repData.safety_flags} safety flag{repData.safety_flags > 1 ? 's' : ''}
              </div>
            )}
          </div>

          {/* Component breakdown */}
          {repData && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              {[
                { key: 'pass_rate', label: 'Pass Rate', desc: 'Verifications passed', color: 'var(--status-active)' },
                { key: 'coherence', label: 'Coherence', desc: 'Capability accuracy', color: 'var(--accent)' },
                { key: 'skill_trust', label: 'Skill Trust', desc: 'Declared skills', color: '#a78bfa' },
                { key: 'uptime', label: 'Uptime', desc: 'Response reliability', color: '#f59e0b' },
                { key: 'contribution', label: 'Contribution', desc: 'Verifications given', color: '#6ee7b7' },
              ].map(({ key, label, desc, color }) => {
                const val = repData.breakdown[key as keyof typeof repData.breakdown] ?? 0;
                const pct = Math.round(val * 100);
                return (
                  <div key={key} style={{ background: 'var(--bg-tertiary)', borderRadius: 6, padding: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{label}</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color }}>{pct}%</span>
                    </div>
                    <div style={{ height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: color, transition: 'width 400ms ease' }} />
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>{desc}</div>
                  </div>
                );
              })}
              {repData.penalty > 0 && (
                <div style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 6, padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: '#ef4444' }}>Penalty</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: '#ef4444' }}>-{Math.round(repData.penalty * 100)}%</span>
                  </div>
                  <div style={{ height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                    <div style={{ width: `${Math.round(repData.penalty * 100)}%`, height: '100%', borderRadius: 2, background: '#ef4444' }} />
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>Safety / auth violations</div>
                </div>
              )}
            </div>
          )}
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

        {/* Skills */}
        {agent.skills && agent.skills.length > 0 && (
          <div style={{ marginBottom: 32 }}>
            <h3 style={{ color: 'var(--text-tertiary)', fontSize: 13, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
              Skills
            </h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {agent.skills.map(skill => {
                const isPrivate = skill.private;
                const color = isPrivate ? 'var(--text-tertiary)' : 'var(--accent)';
                const bg = isPrivate ? 'rgba(255,255,255,0.04)' : 'rgba(99,179,237,0.1)';
                const border = isPrivate ? 'var(--border)' : 'rgba(99,179,237,0.3)';
                const label = isPrivate ? '⬡' : '✓';
                const title = isPrivate
                  ? `Private skill (internal, unverifiable)`
                  : `${skill.registry} · ${skill.version ?? 'latest'}`;
                return (
                  <span
                    key={`${skill.registry}:${skill.name}`}
                    title={title}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 10px',
                      borderRadius: 6,
                      background: bg,
                      border: `1px solid ${border}`,
                      fontSize: 13,
                      fontFamily: 'var(--font-mono)',
                      color,
                      cursor: 'default',
                    }}
                  >
                    <span style={{ fontSize: 10 }}>{label}</span>
                    {skill.name}
                    {skill.version && <span style={{ opacity: 0.5, fontSize: 11 }}>@{skill.version}</span>}
                    <span style={{ opacity: 0.4, fontSize: 11 }}>{skill.registry}</span>
                  </span>
                );
              })}
            </div>
          </div>
        )}

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

        {/* Chain Entry — only show if we have chain data */}
        {agent.chainSequence > 0 && (
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
        )}

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
