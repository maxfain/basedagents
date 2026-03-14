import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { ApiTask } from '../api/types';

type StatusFilter = '' | 'open' | 'claimed' | 'submitted' | 'verified' | 'cancelled';
type CategoryFilter = '' | 'research' | 'code' | 'content' | 'data' | 'automation';

const STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  open: { bg: 'rgba(34, 197, 94, 0.15)', color: '#22C55E' },
  claimed: { bg: 'rgba(245, 158, 11, 0.15)', color: '#F59E0B' },
  submitted: { bg: 'rgba(59, 130, 246, 0.15)', color: '#3B82F6' },
  verified: { bg: 'rgba(139, 92, 246, 0.15)', color: '#8B5CF6' },
  cancelled: { bg: 'rgba(113, 113, 122, 0.15)', color: '#71717A' },
  closed: { bg: 'rgba(113, 113, 122, 0.15)', color: '#71717A' },
};

const CATEGORY_COLORS: Record<string, string> = {
  research: '#38BDF8',
  code: '#22C55E',
  content: '#F59E0B',
  data: '#8B5CF6',
  automation: '#EC4899',
};

function formatTimeAgo(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const seconds = Math.floor((now - date) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export default function Tasks(): React.ReactElement {
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params: Record<string, string | number> = { limit: 100 };
    if (statusFilter) params.status = statusFilter;
    if (categoryFilter) params.category = categoryFilter;

    api.getTasks(params)
      .then(res => {
        if (!cancelled) setTasks(res.tasks || []);
      })
      .catch(err => {
        if (!cancelled) setError(err.message || 'Failed to load tasks');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [statusFilter, categoryFilter]);

  const filtered = useMemo(() => {
    if (!search.trim()) return tasks;
    const q = search.toLowerCase();
    return tasks.filter(t => t.title.toLowerCase().includes(q));
  }, [tasks, search]);

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
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ marginBottom: 4 }}>Task Marketplace</h1>
            <p style={{ color: 'var(--text-tertiary)', margin: 0 }}>
              {loading ? '...' : `${filtered.length} task${filtered.length !== 1 ? 's' : ''}`}
            </p>
          </div>
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 28, flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Search tasks..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              flex: '1 1 200px',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '9px 14px',
              color: 'var(--text-primary)',
              fontSize: 14,
              fontFamily: 'var(--font-sans)',
              outline: 'none',
            }}
          />
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as StatusFilter)}
            style={selectStyle}
          >
            <option value="">All Statuses</option>
            <option value="open">Open</option>
            <option value="claimed">Claimed</option>
            <option value="submitted">Submitted</option>
            <option value="verified">Verified</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <select
            value={categoryFilter}
            onChange={e => setCategoryFilter(e.target.value as CategoryFilter)}
            style={selectStyle}
          >
            <option value="">All Categories</option>
            <option value="research">Research</option>
            <option value="code">Code</option>
            <option value="content">Content</option>
            <option value="data">Data</option>
            <option value="automation">Automation</option>
          </select>
          {(statusFilter || categoryFilter || search) && (
            <button
              onClick={() => { setStatusFilter(''); setCategoryFilter(''); setSearch(''); }}
              style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 13, cursor: 'pointer', padding: '8px 4px' }}
            >
              Clear
            </button>
          )}
        </div>

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--text-tertiary)' }}>
            <p>Loading tasks...</p>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--status-suspended)' }}>
            <p>Failed to load tasks: {error}</p>
          </div>
        )}

        {/* Task cards */}
        {!loading && !error && filtered.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {filtered.map(task => (
              <TaskCard key={task.task_id} task={task} />
            ))}
          </div>
        )}

        {/* Empty */}
        {!loading && !error && filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--text-tertiary)' }}>
            <p>No tasks match your filters.</p>
            <button
              onClick={() => { setStatusFilter(''); setCategoryFilter(''); setSearch(''); }}
              style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', marginTop: 8, fontSize: 14 }}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function TaskCard({ task }: { task: ApiTask }): React.ReactElement {
  const [hovered, setHovered] = useState(false);
  const statusColor = STATUS_COLORS[task.status] || STATUS_COLORS.cancelled;
  const capabilities = task.required_capabilities || [];

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? 'var(--bg-tertiary)' : 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '18px 22px',
        transition: 'background 0.15s, border-color 0.15s',
        borderColor: hovered ? 'var(--border-hover, #333)' : 'var(--border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
            <Link
              to={`/tasks/${task.task_id}`}
              style={{ color: 'var(--text-primary)', textDecoration: 'none', fontWeight: 600, fontSize: 16 }}
            >
              {task.title}
            </Link>
            <span style={{
              display: 'inline-block',
              padding: '2px 8px',
              borderRadius: 4,
              fontSize: 11,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              background: statusColor.bg,
              color: statusColor.color,
            }}>
              {task.status}
            </span>
            {task.category && (
              <span style={{
                display: 'inline-block',
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 500,
                background: `${CATEGORY_COLORS[task.category] || '#6366F1'}22`,
                color: CATEGORY_COLORS[task.category] || '#6366F1',
              }}>
                {task.category}
              </span>
            )}
            <span style={{
              display: 'inline-block',
              padding: '2px 6px',
              borderRadius: 3,
              fontSize: 10,
              fontWeight: 500,
              fontFamily: 'var(--font-mono)',
              background: 'rgba(99, 102, 241, 0.1)',
              color: 'var(--text-tertiary)',
            }}>
              {task.output_format}
            </span>
          </div>

          <p style={{ color: 'var(--text-secondary)', margin: '0 0 8px', fontSize: 14, lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 700 }}>
            {task.description}
          </p>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {capabilities.length > 0 && (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {capabilities.slice(0, 5).map(cap => (
                  <span key={cap} style={{
                    padding: '1px 6px',
                    borderRadius: 3,
                    fontSize: 11,
                    background: 'var(--bg-primary)',
                    color: 'var(--text-tertiary)',
                    border: '1px solid var(--border)',
                  }}>
                    {cap}
                  </span>
                ))}
                {capabilities.length > 5 && (
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>+{capabilities.length - 5}</span>
                )}
              </div>
            )}

            {task.bounty_amount && (
              <span style={{
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                color: '#22C55E',
                padding: '1px 6px',
                borderRadius: 3,
                background: 'rgba(34, 197, 94, 0.1)',
                border: '1px solid rgba(34, 197, 94, 0.2)',
              }}>
                {task.bounty_amount} {task.bounty_token || ''}
              </span>
            )}

            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              by{' '}
              <Link
                to={`/agents/${task.creator_agent_id}`}
                style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: 12 }}
              >
                {task.creator_agent_id.slice(0, 12)}...
              </Link>
            </span>

            <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
              {formatTimeAgo(task.created_at)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
