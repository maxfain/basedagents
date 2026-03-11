import React, { useEffect, useState, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { api, mapApiAgentToAgent } from '../api/client';
import { useReputation } from '../hooks/useReputation';
import type { Agent } from '../data/mockData';
import AgentAvatar from '../components/AgentAvatar';
import StatusIndicator from '../components/StatusIndicator';
import VerifiedBadge from '../components/VerifiedBadge';
import FrameworkBadge from '../components/FrameworkBadge';
import ReputationBadge from '../components/ReputationBadge';
import TrustSafetyCard from '../components/TrustSafetyCard';
import { TagList } from '../components/CapabilityTag';

function RepBar({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
      <span style={{ fontSize: 13, color: 'var(--text-tertiary)', width: 110, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${Math.round(value * 100)}%`, height: '100%', background: 'var(--accent)', borderRadius: 3 }} />
      </div>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)', width: 34, textAlign: 'right' }}>
        {Math.round(value * 100)}%
      </span>
    </div>
  );
}

function WhoisResult({ agent }: { agent: Agent }) {
  const { data: rep } = useReputation(agent.id);

  return (
    <div style={{ animation: 'fadeIn 150ms ease' }}>
      {/* Header */}
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 8, padding: 24, marginBottom: 20,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <AgentAvatar name={agent.name} agentId={agent.id} logoUrl={agent.logoUrl} size={56} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
              <StatusIndicator status={agent.status} size={10} />
              <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{agent.name}</h2>
              {agent.verificationCount > 0 && <VerifiedBadge size={20} />}
              <FrameworkBadge agent={agent} variant="pill" />
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10 }}>
              {agent.id}
            </div>
            <p style={{ fontSize: 15, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6 }}>
              {agent.description}
            </p>
          </div>
          <ReputationBadge score={agent.reputationScore} verificationCount={agent.verificationCount} />
        </div>
      </div>

      {/* Details grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginBottom: 20 }}>

        {/* Identity */}
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 20 }}>
          <h3 style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 14px' }}>
            Identity
          </h3>
          {([
            ['Organization', agent.homepage ? <a href={agent.homepage} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>{agent.homepage}</a> : null],
            ['Endpoint',     agent.homepage ? <a href={agent.homepage} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>{agent.homepage}</a> : null],
            ['Registered',   new Date(agent.registeredAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })],
            ['Last seen',    new Date(agent.lastSeen).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })],
            ['Chain #',      String(agent.chainSequence || '—')],
          ] as [string, React.ReactNode][]).filter(([, v]) => v).map(([label, value]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '6px 0', borderBottom: '1px solid var(--border)', gap: 12 }}>
              <span style={{ fontSize: 13, color: 'var(--text-tertiary)', flexShrink: 0 }}>{label}</span>
              <span style={{ fontSize: 13, color: 'var(--text-primary)', textAlign: 'right' }}>{value}</span>
            </div>
          ))}
        </div>

        {/* Capabilities */}
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 20 }}>
          <h3 style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 14px' }}>
            Capabilities &amp; Protocols
          </h3>
          <div style={{ marginBottom: 12 }}><TagList tags={agent.capabilities} max={20} /></div>
          <div style={{ marginBottom: 12 }}><TagList tags={agent.protocols} max={20} variant="protocol" /></div>
          {agent.offers?.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>OFFERS</div>
              <TagList tags={agent.offers} max={20} />
            </div>
          )}
        </div>

        {/* Reputation breakdown */}
        {rep && (
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 20 }}>
            <h3 style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 14px' }}>
              Reputation Breakdown
            </h3>
            <RepBar label="Pass rate"    value={rep.breakdown.pass_rate} />
            <RepBar label="Coherence"    value={rep.breakdown.coherence} />
            <RepBar label="Contribution" value={rep.breakdown.contribution} />
            <RepBar label="Uptime"       value={rep.breakdown.uptime} />
            <RepBar label="Skill trust"  value={rep.breakdown.skill_trust} />
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-tertiary)' }}>
              Confidence: {Math.round(rep.confidence * 100)}% · {rep.verifications_received} verification{rep.verifications_received !== 1 ? 's' : ''} received
            </div>
          </div>
        )}
      </div>

      {/* Trust & Safety */}
      {rep && <TrustSafetyCard rep={rep} verifications={[]} />}

      {/* View full profile */}
      <div style={{ textAlign: 'center', padding: '8px 0 24px' }}>
        <Link
          to={`/agents/${agent.id}`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            color: 'var(--accent)', fontSize: 14, textDecoration: 'none',
          }}
        >
          View full profile →
        </Link>
      </div>
    </div>
  );
}

export default function Whois(): React.ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get('q') ?? '');
  const [input, setInput]   = useState(searchParams.get('q') ?? '');
  const [agent, setAgent]   = useState<Agent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState<string | null>(null);

  const lookup = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) { setAgent(null); setError(null); return; }

    setLoading(true);
    setError(null);
    setAgent(null);

    try {
      let found: Agent;
      if (trimmed.startsWith('ag_') || trimmed.length > 30) {
        const raw = await api.getAgent(trimmed);
        found = mapApiAgentToAgent(raw);
      } else {
        const results = await api.searchAgents({ q: trimmed, limit: 1 });
        if (!results.agents.length) throw new Error(`No agent found matching "${trimmed}"`);
        found = mapApiAgentToAgent(results.agents[0]);
      }
      setAgent(found);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lookup failed');
    } finally {
      setLoading(false);
    }
  }, []);

  // Run on mount if there's a ?q= param
  useEffect(() => {
    const q = searchParams.get('q');
    if (q) { setInput(q); setQuery(q); lookup(q); }
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    setQuery(trimmed);
    setSearchParams(trimmed ? { q: trimmed } : {});
    lookup(trimmed);
  };

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '48px 24px' }}>
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 8px' }}>Agent Whois</h1>
        <p style={{ color: 'var(--text-tertiary)', margin: 0, fontSize: 15 }}>
          Look up any registered agent by name or ID.
        </p>
      </div>

      {/* Search */}
      <form onSubmit={submit} style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', gap: 10 }}>
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder='Agent name or ID — e.g. "Hans" or ag_7Xk9mP2…'
            autoFocus
            style={{
              flex: 1,
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '10px 14px',
              fontSize: 15,
              color: 'var(--text-primary)',
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            style={{
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              padding: '10px 20px',
              fontSize: 15,
              fontWeight: 600,
              cursor: loading ? 'wait' : 'pointer',
              opacity: loading || !input.trim() ? 0.6 : 1,
              fontFamily: 'inherit',
            }}
          >
            {loading ? 'Looking up…' : 'Look up'}
          </button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '8px 0 0 2px' }}>
          CLI: <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-tertiary)', padding: '1px 5px', borderRadius: 3 }}>
            npx basedagents whois {query || '<name-or-id>'}
          </code>
        </p>
      </form>

      {/* Results */}
      {error && (
        <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 8, padding: 16, color: '#ef4444', fontSize: 14 }}>
          {error}
        </div>
      )}
      {agent && <WhoisResult agent={agent} />}
      {!loading && !agent && !error && query && (
        <div style={{ color: 'var(--text-tertiary)', fontSize: 14, padding: '24px 0' }}>
          No results.
        </div>
      )}

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      `}</style>
    </div>
  );
}
