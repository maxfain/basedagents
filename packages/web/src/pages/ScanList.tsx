import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { ApiScanListItem } from '../api/types';

function formatTimeAgo(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const seconds = Math.floor((now - date) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function scoreColor(score: number): string {
  if (score >= 80) return '#22C55E';
  if (score >= 60) return '#F59E0B';
  if (score >= 40) return '#F97316';
  return '#EF4444';
}

function ScoreCircle({ score, grade, size = 56 }: { score: number; grade: string; size?: number }) {
  const color = scoreColor(score);
  const r = (size - 6) / 2;
  const circ = 2 * Math.PI * r;
  const pct = score / 100;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={4} />
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none" stroke={color} strokeWidth={4}
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - pct)}
          strokeLinecap="round"
        />
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 0,
      }}>
        <span style={{ fontSize: size * 0.27, fontWeight: 700, color, lineHeight: 1 }}>{grade}</span>
        <span style={{ fontSize: size * 0.2, color: 'var(--text-tertiary)', lineHeight: 1 }}>{score}</span>
      </div>
    </div>
  );
}

export default function ScanList(): React.ReactElement {
  const navigate = useNavigate();
  const [packages, setPackages] = useState<ApiScanListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<'recent' | 'score'>('recent');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.listScanReports({ limit: 50, sort })
      .then(res => { if (!cancelled) setPackages(res.packages || []); })
      .catch(err => { if (!cancelled) setError(err.message || 'Failed to load scan reports'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sort]);

  const filtered = packages.filter(p =>
    !search || p.package_name.toLowerCase().includes(search.toLowerCase())
  );

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const pkg = searchInput.trim();
    if (!pkg) return;
    navigate(`/scan/${encodeURIComponent(pkg)}`);
  }

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    color: 'var(--text-primary)',
    padding: '10px 14px',
    fontSize: 14,
    fontFamily: 'var(--font-mono)',
    width: '100%',
    outline: 'none',
  };

  const btnStyle: React.CSSProperties = {
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '10px 20px',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };

  const cardStyle: React.CSSProperties = {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: '20px 24px',
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    textDecoration: 'none',
    color: 'inherit',
    transition: 'border-color 0.15s',
  };

  return (
    <div style={{ padding: '48px 0' }}>
      <div className="container">
        {/* Header */}
        <div style={{ marginBottom: 40 }}>
          <h1 style={{ marginBottom: 8 }}>Package Scanner</h1>
          <p style={{ color: 'var(--text-tertiary)', margin: 0 }}>
            Security scan reports for npm packages. Powered by BasedAgents.
          </p>
        </div>

        {/* Search box */}
        <div style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 24,
          marginBottom: 40,
        }}>
          <p style={{ marginBottom: 12, fontWeight: 600, fontSize: 15 }}>Scan a package</p>
          <form onSubmit={handleSearch} style={{ display: 'flex', gap: 10 }}>
            <input
              style={inputStyle}
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="@scope/package or package-name"
              spellCheck={false}
            />
            <button type="submit" style={btnStyle}>View Report</button>
          </form>
          <p style={{ marginTop: 10, fontSize: 12, color: 'var(--text-tertiary)', margin: '10px 0 0' }}>
            Don't see your package?{' '}
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
              npx basedagents scan &lt;package&gt;
            </code>
          </p>
        </div>

        {/* Filter bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>
              Recent Scans
              {!loading && <span style={{ color: 'var(--text-tertiary)', fontSize: 14, fontWeight: 400, marginLeft: 8 }}>
                {filtered.length} package{filtered.length !== 1 ? 's' : ''}
              </span>}
            </h2>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input
              style={{ ...inputStyle, width: 200, padding: '7px 12px' }}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Filter by name…"
            />
            <select
              value={sort}
              onChange={e => setSort(e.target.value as 'recent' | 'score')}
              style={{
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                color: 'var(--text-secondary)',
                padding: '7px 12px',
                fontSize: 14,
                fontFamily: 'var(--font-sans)',
                cursor: 'pointer',
              }}
            >
              <option value="recent">Newest first</option>
              <option value="score">Highest score</option>
            </select>
          </div>
        </div>

        {/* Content */}
        {loading && (
          <div style={{ color: 'var(--text-tertiary)', padding: '40px 0', textAlign: 'center' }}>
            Loading scan reports…
          </div>
        )}

        {error && (
          <div style={{
            background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 8, padding: 16, color: '#EF4444', marginBottom: 20,
          }}>
            {error}
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-tertiary)' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📦</div>
            <p style={{ margin: 0, fontSize: 16 }}>No scan reports yet.</p>
            <p style={{ margin: '8px 0 0', fontSize: 14 }}>
              Run <code style={{ fontFamily: 'var(--font-mono)' }}>npx basedagents scan &lt;package&gt;</code> to generate one.
            </p>
          </div>
        )}

        {!loading && !error && filtered.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {filtered.map(pkg => (
              <Link
                key={pkg.id}
                to={`/scan/${encodeURIComponent(pkg.package_name)}`}
                style={cardStyle}
                onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}
              >
                <ScoreCircle score={pkg.score} grade={pkg.grade} size={56} />

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
                    {pkg.package_name}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
                    v{pkg.package_version} · {formatTimeAgo(pkg.scanned_at)}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexShrink: 0 }}>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Findings</div>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>{pkg.finding_count}</div>
                  </div>
                  {pkg.critical_high_count > 0 && (
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Critical/High</div>
                      <div style={{ fontWeight: 600, fontSize: 15, color: '#EF4444' }}>{pkg.critical_high_count}</div>
                    </div>
                  )}
                </div>

                <div style={{ color: 'var(--text-tertiary)', fontSize: 18 }}>→</div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
