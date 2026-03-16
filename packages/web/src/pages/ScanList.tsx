import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { ApiScanListItem } from '../api/types';

type SourceFilter = 'all' | 'npm' | 'github' | 'pypi';
type SearchSource = 'npm' | 'github' | 'pypi';

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

function sourceIcon(source?: string): string {
  switch (source) {
    case 'github': return '🐙';
    case 'pypi':   return '🐍';
    case 'npm':
    default:       return '📦';
  }
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

const SOURCE_FILTER_LABELS: Record<SourceFilter, string> = {
  all: 'All',
  npm: '📦 npm',
  github: '🐙 GitHub',
  pypi: '🐍 PyPI',
};

const SEARCH_SOURCE_LABELS: Record<SearchSource, string> = {
  npm: '📦 npm',
  github: '🐙 GitHub',
  pypi: '🐍 PyPI',
};

function SourceFilterTabs({
  active,
  onChange,
}: {
  active: SourceFilter;
  onChange: (s: SourceFilter) => void;
}) {
  const tabs: SourceFilter[] = ['all', 'npm', 'github', 'pypi'];
  return (
    <div style={{
      display: 'inline-flex',
      background: 'var(--bg-tertiary)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: 3,
      gap: 2,
    }}>
      {tabs.map(tab => {
        const isActive = tab === active;
        return (
          <button
            key={tab}
            onClick={() => onChange(tab)}
            style={{
              background: isActive ? 'rgba(99,102,241,0.15)' : 'transparent',
              color: isActive ? 'var(--accent)' : 'var(--text-tertiary)',
              border: isActive ? '1px solid rgba(99,102,241,0.3)' : '1px solid transparent',
              borderRadius: 6,
              padding: '5px 14px',
              fontSize: 13,
              fontWeight: isActive ? 600 : 400,
              cursor: 'pointer',
              transition: 'all 0.15s',
              whiteSpace: 'nowrap',
            }}
          >
            {SOURCE_FILTER_LABELS[tab]}
          </button>
        );
      })}
    </div>
  );
}

function SearchSourceTabs({
  active,
  onChange,
}: {
  active: SearchSource;
  onChange: (s: SearchSource) => void;
}) {
  const tabs: SearchSource[] = ['npm', 'github', 'pypi'];
  return (
    <div style={{
      display: 'inline-flex',
      background: 'var(--bg-tertiary)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: 3,
      gap: 2,
      marginBottom: 10,
    }}>
      {tabs.map(tab => {
        const isActive = tab === active;
        return (
          <button
            key={tab}
            onClick={() => onChange(tab)}
            style={{
              background: isActive ? 'rgba(99,102,241,0.15)' : 'transparent',
              color: isActive ? 'var(--accent)' : 'var(--text-tertiary)',
              border: isActive ? '1px solid rgba(99,102,241,0.3)' : '1px solid transparent',
              borderRadius: 6,
              padding: '5px 14px',
              fontSize: 13,
              fontWeight: isActive ? 600 : 400,
              cursor: 'pointer',
              transition: 'all 0.15s',
              whiteSpace: 'nowrap',
            }}
          >
            {SEARCH_SOURCE_LABELS[tab]}
          </button>
        );
      })}
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
  const [searchSource, setSearchSource] = useState<SearchSource>('npm');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [scanningPkg, setScanningPkg] = useState<string | null>(null);
  const [scanMsg, setScanMsg] = useState<string | null>(null);

  // Reload when sort or source filter changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params: Parameters<typeof api.listScanReports>[0] = { limit: 50, sort };
    if (sourceFilter !== 'all') params.source = sourceFilter;
    api.listScanReports(params)
      .then(res => { if (!cancelled) setPackages(res.packages || []); })
      .catch(err => { if (!cancelled) setError(err.message || 'Failed to load scan reports'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sort, sourceFilter]);

  // Client-side filter by name search
  const filtered = packages.filter(p =>
    !search || p.package_name.toLowerCase().includes(search.toLowerCase())
  );

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    let target = searchInput.trim();
    if (!target) return;

    setScanMsg(null);
    setScanningPkg(null);

    // Build the prefixed identifier based on source
    let identifier: string;
    if (searchSource === 'github') {
      // Parse GitHub URL if pasted
      const match = target.match(/github\.com\/([^/]+\/[^/?\s#]+)/);
      if (match) target = match[1];
      identifier = `github:${target}`;
    } else if (searchSource === 'pypi') {
      identifier = `pypi:${target}`;
    } else {
      identifier = target;
    }

    // Try to fetch existing report
    try {
      await api.getScanReport(identifier);
      navigate(`/scan/${encodeURIComponent(identifier)}`);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 404) {
        // Auto-trigger scan
        setScanningPkg(identifier);
        setScanMsg(`Scanning ${identifier}…`);
        try {
          const triggerOpts = searchSource === 'github'
            ? { source: 'github' as const, target }
            : searchSource === 'pypi'
              ? { source: 'pypi' as const, target }
              : { target: identifier };
          const result = await api.triggerScan(triggerOpts);
          if (result.ok) {
            navigate(`/scan/${encodeURIComponent(identifier)}`);
          } else {
            setScanMsg(result.message || result.error || 'Scan failed');
            setScanningPkg(null);
          }
        } catch {
          setScanMsg('Scan request failed. Please try again.');
          setScanningPkg(null);
        }
      } else {
        navigate(`/scan/${encodeURIComponent(identifier)}`);
      }
    }
  }

  /** Build URL for a scan list item — handles source prefix */
  function scanUrl(pkg: ApiScanListItem): string {
    const src = pkg.source ?? 'npm';
    if (src === 'github') {
      return `/scan/${encodeURIComponent(`github:${pkg.package_name}`)}`;
    }
    if (src === 'pypi') {
      return `/scan/${encodeURIComponent(`pypi:${pkg.package_name}`)}`;
    }
    return `/scan/${encodeURIComponent(pkg.package_name)}`;
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

  const searchPlaceholder = searchSource === 'github'
    ? 'owner/repo or https://github.com/owner/repo'
    : searchSource === 'pypi'
      ? 'package-name (e.g. requests)'
      : '@scope/package or package-name';

  return (
    <div style={{ padding: '48px 0' }}>
      <div className="container">
        {/* Header */}
        <div style={{ marginBottom: 40 }}>
          <h1 style={{ marginBottom: 8 }}>Package Scanner</h1>
          <p style={{ color: 'var(--text-tertiary)', margin: 0 }}>
            Security scan reports for npm packages, GitHub repos, and more. Powered by BasedAgents.
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
          <p style={{ marginBottom: 10, fontWeight: 600, fontSize: 15 }}>Scan a package</p>

          {/* Search source tabs */}
          <SearchSourceTabs active={searchSource} onChange={src => { setSearchSource(src); setSearchInput(''); }} />

          <form onSubmit={handleSearch} style={{ display: 'flex', gap: 10 }}>
            <input
              style={inputStyle}
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder={searchPlaceholder}
              spellCheck={false}
            />
            <button type="submit" style={btnStyle}>View Report</button>
          </form>

          {/* Scanning state */}
          {scanningPkg && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              marginTop: 12, color: 'var(--accent)', fontSize: 14, fontWeight: 600,
            }}>
              <span style={{
                display: 'inline-block', width: 16, height: 16,
                border: '2px solid rgba(99,102,241,0.3)',
                borderTopColor: 'var(--accent)',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite',
                flexShrink: 0,
              }} />
              {scanMsg}
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}
          {!scanningPkg && scanMsg && (
            <div style={{
              marginTop: 12, fontSize: 13, color: '#EF4444',
              background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: 6, padding: '8px 12px',
            }}>
              {scanMsg}
            </div>
          )}
          {!scanMsg && (
            <p style={{ marginTop: 10, fontSize: 12, color: 'var(--text-tertiary)', margin: '10px 0 0' }}>
              Don't see your package? Enter its name above — we'll scan it automatically.
            </p>
          )}
        </div>

        {/* Filter bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 style={{ margin: '0 0 10px', fontSize: 18 }}>
              Recent Scans
              {!loading && <span style={{ color: 'var(--text-tertiary)', fontSize: 14, fontWeight: 400, marginLeft: 8 }}>
                {filtered.length} package{filtered.length !== 1 ? 's' : ''}
              </span>}
            </h2>
            {/* Source filter tabs */}
            <SourceFilterTabs active={sourceFilter} onChange={setSourceFilter} />
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
                to={scanUrl(pkg)}
                style={cardStyle}
                onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}
              >
                <ScoreCircle score={pkg.score} grade={pkg.grade} size={56} />

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 15, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 15 }}>{sourceIcon(pkg.source)}</span>
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
