import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { api, API_BASE } from '../api/client';
import type { ApiScanReport, ScanFinding } from '../api/types';

// ─── Types ───

type SourceTab = 'npm' | 'github' | 'pypi';

// ─── Helpers ───

function formatTimeAgo(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const seconds = Math.floor((now - date) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minute${Math.floor(seconds / 60) !== 1 ? 's' : ''} ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hour${Math.floor(seconds / 3600) !== 1 ? 's' : ''} ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} day${Math.floor(seconds / 86400) !== 1 ? 's' : ''} ago`;
  return new Date(dateStr).toLocaleDateString();
}

function scoreColor(score: number): string {
  if (score >= 80) return '#22C55E';
  if (score >= 60) return '#F59E0B';
  if (score >= 40) return '#F97316';
  return '#EF4444';
}

function severityColor(severity: string): { bg: string; color: string } {
  switch (severity) {
    case 'critical': return { bg: 'rgba(239,68,68,0.15)', color: '#EF4444' };
    case 'high':     return { bg: 'rgba(249,115,22,0.15)', color: '#F97316' };
    case 'medium':   return { bg: 'rgba(245,158,11,0.15)', color: '#F59E0B' };
    case 'low':      return { bg: 'rgba(59,130,246,0.15)', color: '#3B82F6' };
    case 'info':     return { bg: 'rgba(113,113,122,0.15)', color: '#71717A' };
    default:         return { bg: 'rgba(113,113,122,0.15)', color: '#71717A' };
  }
}

function severityIcon(severity: string): string {
  switch (severity) {
    case 'critical': return '🔴';
    case 'high':     return '🟠';
    case 'medium':   return '🟡';
    case 'low':      return '🔵';
    case 'info':     return '⚪';
    default:         return '⚪';
  }
}

/** Parse a raw URL param like "github:owner%2Frepo" → { source, target } */
function parseIdentifier(raw: string): { source: SourceTab; target: string } {
  if (raw.startsWith('github:')) {
    return { source: 'github', target: raw.slice('github:'.length) };
  }
  if (raw.startsWith('pypi:')) {
    return { source: 'pypi', target: raw.slice('pypi:'.length) };
  }
  if (raw.startsWith('npm:')) {
    return { source: 'npm', target: raw.slice('npm:'.length) };
  }
  return { source: 'npm', target: raw };
}

/** Build the URL identifier from source + target for navigation */
function buildIdentifier(source: SourceTab, target: string): string {
  if (source === 'npm') return target;
  // For github/pypi encode the slash within owner/repo but keep prefix clean
  // encodeURIComponent on the whole thing handles it
  return `${source}:${target}`;
}

/** Parse GitHub URL or owner/repo string → owner/repo */
function parseGitHubInput(input: string): string {
  const trimmed = input.trim();
  // https://github.com/owner/repo or https://github.com/owner/repo/...
  const match = trimmed.match(/github\.com\/([^/]+\/[^/?\s#]+)/);
  if (match) return match[1];
  return trimmed;
}

const SOURCE_LABELS: Record<SourceTab, string> = {
  npm: '📦 npm',
  github: '🐙 GitHub',
  pypi: '🐍 PyPI',
};

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

// ─── Sub-components ───

function SourceTabs({
  active,
  onChange,
}: {
  active: SourceTab;
  onChange: (s: SourceTab) => void;
}) {
  const tabs: SourceTab[] = ['npm', 'github', 'pypi'];
  return (
    <div style={{
      display: 'inline-flex',
      background: 'var(--bg-tertiary)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: 3,
      gap: 2,
      marginBottom: 14,
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
            {SOURCE_LABELS[tab]}
          </button>
        );
      })}
    </div>
  );
}

function SourceBadge({ source }: { source?: 'npm' | 'github' | 'pypi' }) {
  if (!source) return null;
  const label = SOURCE_LABELS[source] || source;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 6,
      fontSize: 12,
      fontWeight: 600,
      background: 'var(--bg-tertiary)',
      border: '1px solid var(--border)',
      color: 'var(--text-secondary)',
      marginLeft: 10,
      verticalAlign: 'middle',
    }}>
      {label}
    </span>
  );
}

function GitHubMetaCard({ metadata, packageName }: {
  metadata: ApiScanReport['metadata'];
  packageName: string;
}) {
  const repoUrl = `https://github.com/${packageName}`;
  const formatDate = (d?: string) => d ? new Date(d).toLocaleDateString() : '—';

  return (
    <div style={{
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border)',
      borderRadius: 12,
      padding: '20px 24px',
      marginBottom: 24,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 18 }}>🐙</span>
        <a
          href={repoUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 16,
            fontWeight: 700,
            color: 'var(--accent)',
            textDecoration: 'none',
          }}
        >
          {packageName}
        </a>
        {metadata.license && (
          <span style={{
            padding: '1px 7px',
            borderRadius: 4,
            fontSize: 11,
            fontWeight: 600,
            background: 'rgba(99,102,241,0.12)',
            color: 'var(--accent)',
            border: '1px solid rgba(99,102,241,0.25)',
            marginLeft: 4,
          }}>
            {metadata.license}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        {metadata.stars !== undefined && (
          <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
            ⭐ <strong>{metadata.stars.toLocaleString()}</strong> stars
          </span>
        )}
        {metadata.forks !== undefined && (
          <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
            🍴 <strong>{metadata.forks.toLocaleString()}</strong> forks
          </span>
        )}
        {metadata.open_issues !== undefined && (
          <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
            🐛 <strong>{metadata.open_issues.toLocaleString()}</strong> open issues
          </span>
        )}
        {metadata.language && (
          <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
            💬 <strong>{metadata.language}</strong>
          </span>
        )}
        <span style={{
          fontSize: 14,
          color: metadata.has_ci ? '#22C55E' : '#EF4444',
          fontWeight: 600,
        }}>
          {metadata.has_ci ? '✓ CI configured' : '✗ No CI detected'}
        </span>
      </div>

      {(metadata.created_at || metadata.pushed_at) && (
        <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-tertiary)' }}>
          {metadata.created_at && <span>Created: {formatDate(metadata.created_at)}</span>}
          {metadata.created_at && metadata.pushed_at && <span style={{ margin: '0 8px' }}>·</span>}
          {metadata.pushed_at && <span>Last pushed: {formatDate(metadata.pushed_at)}</span>}
        </div>
      )}
    </div>
  );
}

function PyPIMetaCard({ metadata, packageName }: {
  metadata: ApiScanReport['metadata'];
  packageName: string;
}) {
  const pypiUrl = `https://pypi.org/project/${packageName}/`;
  const extra = metadata.source_metadata?.extra;
  if (!extra) return null;

  const homeUrl = extra.home_page as string | undefined;
  const requiresPython = extra.requires_python as string | undefined;
  const author = extra.author as string | undefined;
  const license = extra.license as string | undefined;
  const hasSetupPy = extra.has_setup_py as boolean | undefined;
  const hasPyprojectToml = extra.has_pyproject_toml as boolean | undefined;

  return (
    <div style={{
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border)',
      borderRadius: 12,
      padding: '20px 24px',
      marginBottom: 24,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 18 }}>🐍</span>
        <a
          href={pypiUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 16,
            fontWeight: 700,
            color: 'var(--accent)',
            textDecoration: 'none',
          }}
        >
          {packageName}
        </a>
        {license && (
          <span style={{
            padding: '1px 7px',
            borderRadius: 4,
            fontSize: 11,
            fontWeight: 600,
            background: 'rgba(99,102,241,0.12)',
            color: 'var(--accent)',
            border: '1px solid rgba(99,102,241,0.25)',
            marginLeft: 4,
          }}>
            {license}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        {author && (
          <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
            👤 <strong>{author}</strong>
          </span>
        )}
        {requiresPython && (
          <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
            🐍 Python <strong>{requiresPython}</strong>
          </span>
        )}
        {homeUrl && (
          <a
            href={homeUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 14, color: 'var(--accent)', textDecoration: 'none' }}
          >
            🔗 Project Homepage
          </a>
        )}
        <span style={{
          fontSize: 14,
          color: hasSetupPy ? '#F97316' : hasPyprojectToml ? '#22C55E' : 'var(--text-tertiary)',
          fontWeight: 600,
        }}>
          {hasSetupPy ? '⚠ setup.py' : hasPyprojectToml ? '✓ pyproject.toml' : ''}
        </span>
      </div>
    </div>
  );
}

function ScoreCircle({ score, grade }: { score: number; grade: string }) {
  const color = scoreColor(score);
  const size = 120;
  const r = 52;
  const circ = 2 * Math.PI * r;
  const pct = score / 100;
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={8} />
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none" stroke={color} strokeWidth={8}
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - pct)}
          strokeLinecap="round"
        />
      </svg>
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <span style={{ fontSize: 36, fontWeight: 800, color, lineHeight: 1 }}>{grade}</span>
        <span style={{ fontSize: 16, color: 'var(--text-tertiary)', lineHeight: 1.3 }}>{score}/100</span>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div style={{
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border)',
      borderRadius: 10,
      padding: '16px 20px',
      flex: 1,
      minWidth: 120,
    }}>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || 'var(--text-primary)' }}>
        {value}
      </div>
    </div>
  );
}

function FindingRow({ finding }: { finding: ScanFinding }) {
  const [expanded, setExpanded] = useState(false);
  const { bg, color } = severityColor(finding.severity);
  return (
    <div style={{
      background: 'var(--bg-tertiary)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      overflow: 'hidden',
    }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 12, width: '100%',
          padding: '12px 16px', background: 'none', border: 'none',
          cursor: 'pointer', textAlign: 'left', color: 'inherit',
        }}
      >
        <span style={{ fontSize: 16, marginTop: 2, flexShrink: 0 }}>{severityIcon(finding.severity)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
            <span style={{
              display: 'inline-block', padding: '2px 8px', borderRadius: 4,
              fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
              letterSpacing: '0.05em', background: bg, color,
            }}>
              {finding.severity}
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
              {finding.category}
            </span>
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-tertiary)' }}>
            {finding.file}{finding.line ? `:${finding.line}` : ''}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
            {finding.description}
          </div>
        </div>
        <span style={{ color: 'var(--text-tertiary)', fontSize: 12, marginTop: 2, flexShrink: 0 }}>
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {expanded && finding.snippet && (
        <div style={{ padding: '0 16px 12px 44px' }}>
          <pre style={{
            background: 'var(--bg-primary)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '10px 14px',
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            overflowX: 'auto',
            margin: 0,
            color: 'var(--text-secondary)',
          }}>
            {finding.snippet}
          </pre>
        </div>
      )}
    </div>
  );
}

function FindingsSection({ findings }: { findings: ScanFinding[] }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const grouped = SEVERITY_ORDER.reduce<Record<string, ScanFinding[]>>((acc, sev) => {
    const list = findings.filter(f => f.severity === sev);
    if (list.length > 0) acc[sev] = list;
    return acc;
  }, {});

  if (findings.length === 0) {
    return (
      <div style={{
        background: 'rgba(34,197,94,0.08)',
        border: '1px solid rgba(34,197,94,0.3)',
        borderRadius: 10, padding: '20px 24px',
        color: '#22C55E', fontSize: 15, fontWeight: 600,
      }}>
        ✓ No findings — package looks clean!
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {Object.entries(grouped).map(([sev, items]) => {
        const { bg, color } = severityColor(sev);
        const isCollapsed = collapsed[sev];
        return (
          <div key={sev}>
            <button
              onClick={() => setCollapsed(c => ({ ...c, [sev]: !c[sev] }))}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                background: 'none', border: 'none', cursor: 'pointer',
                textAlign: 'left', color: 'inherit', padding: '0 0 10px 0',
              }}
            >
              <span style={{ fontSize: 16 }}>{severityIcon(sev)}</span>
              <span style={{ fontWeight: 700, fontSize: 16, textTransform: 'capitalize' }}>{sev}</span>
              <span style={{
                display: 'inline-block', padding: '2px 8px', borderRadius: 12,
                fontSize: 12, fontWeight: 700, background: bg, color,
              }}>
                {items.length}
              </span>
              <span style={{ marginLeft: 'auto', color: 'var(--text-tertiary)', fontSize: 12 }}>
                {isCollapsed ? '▶ Show' : '▼ Hide'}
              </span>
            </button>

            {!isCollapsed && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {items.map((finding, i) => (
                  <FindingRow key={i} finding={finding} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Main Page ───

export default function Scan(): React.ReactElement {
  const { package: pkgParam } = useParams<{ package: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const version = searchParams.get('version') || undefined;

  // Decode and parse the URL param to determine source + target
  const rawIdentifier = pkgParam ? decodeURIComponent(pkgParam) : '';
  const parsed = parseIdentifier(rawIdentifier);

  const [activeSource, setActiveSource] = useState<SourceTab>(parsed.source);
  const [searchInput, setSearchInput] = useState(parsed.target);
  const [githubRef, setGithubRef] = useState('');

  const [report, setReport] = useState<ApiScanReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [copied, setCopied] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [rescanError, setRescanError] = useState<string | null>(null);

  // The full identifier for API calls (e.g. "lodash" or "github:owner/repo")
  const identifier = rawIdentifier;
  // The display name is just the target portion
  const displayName = parsed.target;

  const loadReport = useCallback((id: string, ver?: string) => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    setReport(null);
    api.getScanReport(id, ver)
      .then(r => setReport(r))
      .catch(err => {
        if (err.status === 404) {
          setNotFound(true);
        } else {
          setError(err.message || 'Failed to load scan report');
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (identifier) {
      setScanError(null);
      setActiveSource(parsed.source);
      loadReport(identifier, version);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identifier, version, loadReport]);

  async function handleScanNow() {
    setScanning(true);
    setScanError(null);
    try {
      const result = await api.triggerScan(
        activeSource === 'github'
          ? { source: 'github', target: displayName, ref: githubRef || undefined }
          : { source: activeSource, target: displayName, version }
      );
      if (result.ok) {
        loadReport(identifier, version);
      } else {
        setScanError(result.message || result.error || 'Scan failed');
      }
    } catch {
      setScanError('Scan request failed. Please try again.');
    } finally {
      setScanning(false);
    }
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    let target = searchInput.trim();
    if (!target) return;

    if (activeSource === 'github') {
      target = parseGitHubInput(target);
    }

    const id = buildIdentifier(activeSource, target);
    // encode the full identifier; slash within owner/repo gets encoded by encodeURIComponent
    navigate(`/scan/${encodeURIComponent(id)}`);
  }

  function handleSourceChange(src: SourceTab) {
    setActiveSource(src);
    setSearchInput('');
    setGithubRef('');
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }

  function tweetUrl() {
    if (!report) return;
    const name = report.package_name;
    const text = `Security scan for ${name}@${report.package_version}: ${report.grade} (${report.score}/100) — ${report.findings.length} finding${report.findings.length !== 1 ? 's' : ''}`;
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(window.location.href)}`;
    window.open(url, '_blank', 'noopener');
  }

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    color: 'var(--text-primary)',
    padding: '10px 14px',
    fontSize: 14,
    fontFamily: 'var(--font-mono)',
    flex: 1,
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

  const sectionStyle: React.CSSProperties = {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: '24px 28px',
    marginBottom: 24,
  };

  // Compute summary stats
  const findings = report?.findings || [];
  const criticalHighCount = findings.filter(f => f.severity === 'critical' || f.severity === 'high').length;
  const filesScanned = (report?.metadata?.files_scanned as number) || 0;
  const hasInstallScripts = !!(report?.metadata?.has_install_scripts);
  const installScripts = (report?.metadata?.install_scripts as string[]) || [];

  const basedagents = report?.basedagents || {};
  const baRegistered = !!(basedagents.registered);
  const baVerified = !!(basedagents.verified);
  const baScore = basedagents.reputation_score as number | undefined;
  const baAgentId = basedagents.agent_id as string | undefined;

  const reportSource = report?.source ?? (parsed.source !== 'npm' ? parsed.source : undefined);

  // Input placeholder based on active source
  const inputPlaceholder = activeSource === 'github'
    ? 'owner/repo or https://github.com/owner/repo'
    : activeSource === 'pypi'
      ? 'package-name (e.g. requests)'
      : '@scope/package or package-name';

  return (
    <div style={{ padding: '48px 0' }}>
      <div className="container">

        {/* Search box (always visible) */}
        <div style={sectionStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <p style={{ margin: 0, fontWeight: 600, fontSize: 15 }}>Check a package</p>
            <Link to="/scan" style={{ fontSize: 13, color: 'var(--text-tertiary)', textDecoration: 'none' }}>
              ← All scans
            </Link>
          </div>

          {/* Source tabs */}
          <SourceTabs active={activeSource} onChange={handleSourceChange} />

          <form onSubmit={handleSearch} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 10 }}>
              <input
                style={inputStyle}
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                placeholder={inputPlaceholder}
                spellCheck={false}
              />
              <button type="submit" style={btnStyle}>View Report</button>
            </div>
            {/* GitHub ref input */}
            {activeSource === 'github' && (
              <input
                style={{ ...inputStyle, flex: 'unset', width: 220, fontSize: 13, padding: '7px 12px' }}
                value={githubRef}
                onChange={e => setGithubRef(e.target.value)}
                placeholder="Branch / Tag (e.g. main)"
                spellCheck={false}
              />
            )}
          </form>
        </div>

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-tertiary)' }}>
            Loading scan report…
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div style={{
            background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 10, padding: '20px 24px', color: '#EF4444',
          }}>
            {error}
          </div>
        )}

        {/* Not found */}
        {notFound && !loading && (
          <div style={{
            ...sectionStyle,
            textAlign: 'center', padding: '48px 28px',
          }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>
              {activeSource === 'github' ? '🐙' : activeSource === 'pypi' ? '🐍' : '📦'}
            </div>
            <h2 style={{ marginBottom: 8 }}>Not yet scanned</h2>
            <p style={{ color: 'var(--text-tertiary)', marginBottom: 24 }}>
              <strong style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{displayName}</strong>
              {' '}hasn't been scanned yet.
            </p>

            {/* Scan Now button */}
            {!scanning && !scanError && (
              <button
                onClick={handleScanNow}
                style={{
                  background: 'var(--accent)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 10,
                  padding: '14px 36px',
                  fontSize: 16,
                  fontWeight: 700,
                  cursor: 'pointer',
                  marginBottom: 24,
                  boxShadow: '0 2px 12px rgba(0,0,0,0.18)',
                  transition: 'opacity 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
                onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
              >
                🔍 Scan Now
              </button>
            )}

            {/* Scanning spinner */}
            {scanning && (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: 10, marginBottom: 24, color: 'var(--accent)', fontSize: 15, fontWeight: 600,
              }}>
                <span style={{
                  display: 'inline-block', width: 20, height: 20,
                  border: '3px solid rgba(var(--accent-rgb,99,102,241),0.3)',
                  borderTopColor: 'var(--accent)',
                  borderRadius: '50%',
                  animation: 'spin 0.8s linear infinite',
                }} />
                Scanning…
              </div>
            )}

            {/* Scan error */}
            {scanError && (
              <div style={{
                background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
                borderRadius: 8, padding: '12px 20px', color: '#EF4444',
                marginBottom: 24, fontSize: 14,
              }}>
                {scanError}
                <button
                  onClick={() => { setScanError(null); }}
                  style={{ marginLeft: 12, background: 'none', border: 'none', color: '#EF4444', cursor: 'pointer', textDecoration: 'underline', fontSize: 13 }}
                >
                  Retry
                </button>
              </div>
            )}

            <p style={{ marginTop: 8, fontSize: 13, color: 'var(--text-tertiary)' }}>
              Or run locally:{' '}
              <code style={{
                fontFamily: 'var(--font-mono)', fontSize: 13,
                background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                borderRadius: 4, padding: '2px 8px',
              }}>
                {activeSource === 'github'
                  ? `npx basedagents scan github:${displayName}`
                  : activeSource === 'pypi'
                    ? `npx basedagents scan pypi:${displayName}`
                    : `npx basedagents scan ${displayName}`}
              </code>
            </p>

            <style>{`
              @keyframes spin { to { transform: rotate(360deg); } }
            `}</style>
          </div>
        )}

        {/* No package searched yet */}
        {!identifier && !loading && (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-tertiary)' }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🔍</div>
            <p style={{ margin: 0, fontSize: 16 }}>Enter a package name above to view its security report.</p>
            <p style={{ margin: '8px 0 0', fontSize: 14 }}>
              Or <Link to="/scan" style={{ color: 'var(--accent)' }}>browse all scanned packages</Link>.
            </p>
          </div>
        )}

        {/* Report */}
        {report && !loading && (
          <>
            {/* GitHub metadata card */}
            {reportSource === 'github' && report.metadata && (
              <GitHubMetaCard metadata={report.metadata} packageName={report.package_name} />
            )}

            {/* PyPI metadata card */}
            {reportSource === 'pypi' && report.metadata && (
              <PyPIMetaCard metadata={report.metadata} packageName={report.package_name} />
            )}

            {/* Header */}
            <div style={{
              ...sectionStyle,
              display: 'flex', alignItems: 'center', gap: 28, flexWrap: 'wrap',
            }}>
              <ScoreCircle score={report.score} grade={report.grade} />
              <div style={{ flex: 1, minWidth: 200 }}>
                <h1 style={{ margin: '0 0 4px', fontFamily: 'var(--font-mono)', fontSize: 22, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                  {report.package_name}
                  <SourceBadge source={reportSource} />
                </h1>
                <div style={{ color: 'var(--text-tertiary)', fontSize: 14, marginBottom: 8 }}>
                  v{report.package_version}
                </div>
                <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>
                  Scanned {formatTimeAgo(report.scanned_at)}
                  {report.submitted_by && (
                    <span> · submitted by <strong>{report.submitted_by}</strong></span>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button onClick={copyUrl} style={{
                  ...btnStyle,
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                }}>
                  {copied ? '✓ Copied' : '📋 Copy link'}
                </button>
                <button onClick={tweetUrl} style={{ ...btnStyle, background: '#1DA1F2' }}>
                  𝕏 Tweet
                </button>
              </div>
            </div>

            {/* Summary cards */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
              {filesScanned > 0 && (
                <SummaryCard label="Files Scanned" value={filesScanned} />
              )}
              <SummaryCard label="Total Findings" value={findings.length} />
              <SummaryCard
                label="Critical / High"
                value={criticalHighCount}
                color={criticalHighCount > 0 ? '#EF4444' : '#22C55E'}
              />
              <SummaryCard
                label="Install Scripts"
                value={hasInstallScripts ? `⚠ Yes (${installScripts.length || 'postinstall'})` : '✓ None'}
                color={hasInstallScripts ? '#F97316' : '#22C55E'}
              />
            </div>

            {/* Findings */}
            <div style={sectionStyle}>
              <h2 style={{ margin: '0 0 20px', fontSize: 18 }}>
                Findings
                <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--text-tertiary)', marginLeft: 8 }}>
                  {findings.length} total
                </span>
              </h2>
              <FindingsSection findings={findings} />
            </div>

            {/* BasedAgents status */}
            <div style={sectionStyle}>
              <h2 style={{ margin: '0 0 20px', fontSize: 18 }}>BasedAgents Status</h2>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <div style={{
                  flex: 1, minWidth: 160,
                  background: 'var(--bg-tertiary)',
                  border: `1px solid ${baRegistered ? 'rgba(34,197,94,0.4)' : 'var(--border)'}`,
                  borderRadius: 10, padding: '16px 20px',
                }}>
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Registered</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: baRegistered ? '#22C55E' : 'var(--text-tertiary)' }}>
                    {baRegistered ? '✓ Yes' : '✗ No'}
                  </div>
                  {baRegistered && baAgentId && (
                    <Link
                      to={`/agents/${encodeURIComponent(baAgentId)}`}
                      style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none', marginTop: 4, display: 'block' }}
                    >
                      View profile →
                    </Link>
                  )}
                </div>

                <div style={{
                  flex: 1, minWidth: 160,
                  background: 'var(--bg-tertiary)',
                  border: `1px solid ${baVerified ? 'rgba(34,197,94,0.4)' : 'var(--border)'}`,
                  borderRadius: 10, padding: '16px 20px',
                }}>
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Verified</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: baVerified ? '#22C55E' : 'var(--text-tertiary)' }}>
                    {baVerified ? '✓ Yes' : '✗ No'}
                  </div>
                </div>

                {baScore !== undefined && (
                  <div style={{
                    flex: 1, minWidth: 160,
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border)',
                    borderRadius: 10, padding: '16px 20px',
                  }}>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Reputation</div>
                    <div style={{ fontSize: 18, fontWeight: 700 }}>{baScore}</div>
                  </div>
                )}
              </div>

              {!baRegistered && (
                <p style={{ marginTop: 16, fontSize: 13, color: 'var(--text-tertiary)' }}>
                  Register this agent at{' '}
                  <Link to="/register" style={{ color: 'var(--accent)' }}>basedagents.ai/register</Link>
                  {' '}to build reputation and verify your package.
                </p>
              )}
            </div>

            {/* Footer / CTA */}
            <div style={{
              ...sectionStyle,
              textAlign: 'center',
              background: 'var(--bg-tertiary)',
            }}>
              <p style={{ marginBottom: 8, fontSize: 15, color: 'var(--text-secondary)' }}>
                Scan your own packages:
              </p>
              <code style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 14,
                background: 'var(--bg-primary)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '8px 16px',
                display: 'inline-block',
                marginBottom: 20,
              }}>
                {reportSource === 'github'
                  ? `npx basedagents scan github:${report.package_name}`
                  : reportSource === 'pypi'
                    ? `npx basedagents scan pypi:${report.package_name}`
                    : `npx basedagents scan ${report.package_name}`}
              </code>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                <button onClick={copyUrl} style={{ ...btnStyle, background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                  {copied ? '✓ Copied' : '📋 Copy report URL'}
                </button>
                <button onClick={tweetUrl} style={{ ...btnStyle, background: '#1DA1F2' }}>
                  Share on 𝕏
                </button>
                <Link to="/scan" style={{ ...btnStyle, background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border)', textDecoration: 'none' }}>
                  Browse all scans
                </Link>
              </div>
              <p style={{ marginTop: 20, fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 0 }}>
                Powered by{' '}
                <Link to="/" style={{ color: 'var(--accent)', textDecoration: 'none' }}>BasedAgents</Link>
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
