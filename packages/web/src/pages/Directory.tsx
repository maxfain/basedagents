import React, { useState, useMemo } from 'react';
import { mockAgents } from '../data/mockData';
import AgentCard from '../components/AgentCard';

const allCapabilities = Array.from(new Set(mockAgents.flatMap(a => a.capabilities))).sort();
const allProtocols = Array.from(new Set(mockAgents.flatMap(a => a.protocols))).sort();

export default function Directory(): React.ReactElement {
  const [search, setSearch] = useState('');
  const [capFilter, setCapFilter] = useState('');
  const [protoFilter, setProtoFilter] = useState('');
  const [sortBy, setSortBy] = useState<'reputation' | 'recent'>('reputation');

  const filtered = useMemo(() => {
    let agents = [...mockAgents];

    if (search) {
      const q = search.toLowerCase();
      agents = agents.filter(
        a => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q)
      );
    }

    if (capFilter) {
      agents = agents.filter(a => a.capabilities.includes(capFilter));
    }

    if (protoFilter) {
      agents = agents.filter(a => a.protocols.includes(protoFilter));
    }

    if (sortBy === 'reputation') {
      agents.sort((a, b) => b.reputationScore - a.reputationScore);
    } else {
      agents.sort((a, b) => new Date(b.registeredAt).getTime() - new Date(a.registeredAt).getTime());
    }

    return agents;
  }, [search, capFilter, protoFilter, sortBy]);

  const selectStyle: React.CSSProperties = {
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--text-secondary)',
    padding: '8px 12px',
    fontSize: 14,
    fontFamily: 'var(--font-sans)',
    cursor: 'pointer',
    appearance: 'none' as const,
    WebkitAppearance: 'none' as const,
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2352525B' d='M3 5l3 3 3-3'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 10px center',
    paddingRight: 28,
  };

  return (
    <div style={{ padding: '48px 0' }}>
      <div className="container-wide">
        {/* Header */}
        <h1 style={{ marginBottom: 4 }}>Agent Directory</h1>
        <p style={{ color: 'var(--text-tertiary)', marginBottom: 32 }}>
          {mockAgents.length} registered agents
        </p>

        {/* Search */}
        <div style={{ marginBottom: 16 }}>
          <input
            type="text"
            placeholder="Search agents..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              width: '100%',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '12px 16px',
              color: 'var(--text-primary)',
              fontSize: 15,
              fontFamily: 'var(--font-sans)',
              outline: 'none',
            }}
          />
        </div>

        {/* Filters */}
        <div
          style={{
            display: 'flex',
            gap: 12,
            marginBottom: 32,
            flexWrap: 'wrap',
          }}
        >
          <select value={capFilter} onChange={e => setCapFilter(e.target.value)} style={selectStyle}>
            <option value="">All Capabilities</option>
            {allCapabilities.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>

          <select value={protoFilter} onChange={e => setProtoFilter(e.target.value)} style={selectStyle}>
            <option value="">All Protocols</option>
            {allProtocols.map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>

          <select value={sortBy} onChange={e => setSortBy(e.target.value as 'reputation' | 'recent')} style={selectStyle}>
            <option value="reputation">Sort: Reputation</option>
            <option value="recent">Sort: Recent</option>
          </select>

          {(capFilter || protoFilter) && (
            <button
              onClick={() => { setCapFilter(''); setProtoFilter(''); }}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent)',
                fontSize: 14,
                cursor: 'pointer',
                padding: '8px 12px',
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        {/* Active filters */}
        {(capFilter || protoFilter) && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
            {capFilter && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 10px',
                  background: 'var(--accent-muted)',
                  color: 'var(--accent)',
                  borderRadius: 4,
                  fontSize: 13,
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {capFilter}
                <button
                  onClick={() => setCapFilter('')}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--accent)',
                    cursor: 'pointer',
                    fontSize: 14,
                    padding: 0,
                    lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              </span>
            )}
            {protoFilter && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 10px',
                  background: 'rgba(255,255,255,0.04)',
                  color: 'var(--text-secondary)',
                  borderRadius: 4,
                  fontSize: 13,
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {protoFilter}
                <button
                  onClick={() => setProtoFilter('')}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    fontSize: 14,
                    padding: 0,
                    lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              </span>
            )}
          </div>
        )}

        {/* Grid */}
        {filtered.length > 0 ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
              gap: 16,
            }}
          >
            {filtered.map(agent => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--text-tertiary)' }}>
            <p>No agents match your filters.</p>
            <button
              onClick={() => { setSearch(''); setCapFilter(''); setProtoFilter(''); }}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent)',
                cursor: 'pointer',
                marginTop: 8,
                fontSize: 14,
              }}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
