import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client';
import type { ApiTask, ApiTaskSubmission, ApiDeliveryReceipt } from '../api/types';

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

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function truncateHash(hash: string, len = 16): string {
  if (hash.length <= len) return hash;
  return hash.slice(0, len) + '...' + hash.slice(-4);
}

export default function TaskDetail(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const [task, setTask] = useState<ApiTask | null>(null);
  const [submission, setSubmission] = useState<ApiTaskSubmission | null>(null);
  const [receipt, setReceipt] = useState<ApiDeliveryReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    api.getTask(id)
      .then(res => {
        if (!cancelled) {
          setTask(res.task);
          setSubmission(res.submission || null);
          setReceipt(res.delivery_receipt || null);
        }
      })
      .catch(err => {
        if (!cancelled) setError(err.message || 'Failed to load task');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [id]);

  if (loading) {
    return (
      <div style={{ padding: '48px 0' }}>
        <div className="container" style={{ textAlign: 'center', padding: '64px 0', color: 'var(--text-tertiary)' }}>
          <p>Loading task...</p>
        </div>
      </div>
    );
  }

  if (error || !task) {
    return (
      <div style={{ padding: '48px 0' }}>
        <div className="container" style={{ textAlign: 'center', padding: '64px 0' }}>
          <p style={{ color: 'var(--status-suspended)' }}>{error || 'Task not found'}</p>
          <Link to="/tasks" style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: 14 }}>
            Back to tasks
          </Link>
        </div>
      </div>
    );
  }

  const statusColor = STATUS_COLORS[task.status] || STATUS_COLORS.cancelled;
  const capabilities = task.required_capabilities || [];
  const isCancelled = task.status === 'cancelled' || task.status === 'closed';

  const PAYMENT_COLORS: Record<string, { bg: string; color: string }> = {
    authorized: { bg: 'rgba(245, 158, 11, 0.15)', color: '#F59E0B' },
    settled: { bg: 'rgba(34, 197, 94, 0.15)', color: '#22C55E' },
    failed: { bg: 'rgba(239, 68, 68, 0.15)', color: '#EF4444' },
    disputed: { bg: 'rgba(239, 68, 68, 0.15)', color: '#EF4444' },
    expired: { bg: 'rgba(113, 113, 122, 0.15)', color: '#71717A' },
  };

  // Timeline steps
  const normalSteps = ['open', 'claimed', 'submitted', 'verified'] as const;
  const stepTimestamps: Record<string, string | null> = {
    open: task.created_at,
    claimed: task.claimed_at,
    submitted: task.submitted_at,
    verified: task.verified_at,
  };
  const statusOrder = isCancelled
    ? (() => {
        // Show steps up to wherever it was cancelled, then cancelled
        const reached: string[] = ['open'];
        if (task.claimed_at) reached.push('claimed');
        if (task.submitted_at) reached.push('submitted');
        reached.push('cancelled');
        return reached;
      })()
    : [...normalSteps];
  const currentStepIndex = isCancelled
    ? statusOrder.length - 1
    : normalSteps.indexOf(task.status as typeof normalSteps[number]);

  const sectionStyle: React.CSSProperties = {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    padding: '20px 24px',
    marginBottom: 16,
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    color: 'var(--text-tertiary)',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    fontWeight: 600,
    marginBottom: 4,
  };

  const valueStyle: React.CSSProperties = {
    fontSize: 14,
    color: 'var(--text-primary)',
    lineHeight: 1.6,
  };

  return (
    <div style={{ padding: '48px 0' }}>
      <div className="container">
        {/* Breadcrumb */}
        <div style={{ marginBottom: 24 }}>
          <Link to="/tasks" style={{ color: 'var(--text-tertiary)', textDecoration: 'none', fontSize: 13 }}>
            Tasks
          </Link>
          <span style={{ color: 'var(--text-tertiary)', margin: '0 8px', fontSize: 13 }}>/</span>
          <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{task.title}</span>
        </div>

        {/* Title + Status */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0 }}>{task.title}</h1>
            <span style={{
              display: 'inline-block',
              padding: '3px 10px',
              borderRadius: 5,
              fontSize: 12,
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
                padding: '3px 10px',
                borderRadius: 5,
                fontSize: 12,
                fontWeight: 500,
                background: `${CATEGORY_COLORS[task.category] || '#6366F1'}22`,
                color: CATEGORY_COLORS[task.category] || '#6366F1',
              }}>
                {task.category}
              </span>
            )}
          </div>
          <p style={{ color: 'var(--text-tertiary)', margin: 0, fontSize: 13, fontFamily: 'var(--font-mono)' }}>
            {task.task_id}
          </p>
        </div>

        {/* Status Timeline */}
        <div style={{
          ...sectionStyle,
          padding: '24px 28px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={labelStyle}>Status Timeline</div>
            {task.bounty_amount && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '3px 10px',
                  borderRadius: 5,
                  fontSize: 12,
                  fontWeight: 600,
                  background: 'rgba(34, 197, 94, 0.1)',
                  color: '#22C55E',
                  border: '1px solid rgba(34, 197, 94, 0.25)',
                  fontFamily: 'var(--font-mono)',
                }}>
                  {task.bounty_amount} {task.bounty_token || ''}
                  {task.bounty_network && (
                    <span style={{ fontSize: 10, opacity: 0.7 }}> ({task.bounty_network})</span>
                  )}
                </span>
                {task.payment_status && task.payment_status !== 'none' && (() => {
                  const pc = PAYMENT_COLORS[task.payment_status] || PAYMENT_COLORS.expired;
                  return (
                    <span style={{
                      display: 'inline-block',
                      padding: '3px 8px',
                      borderRadius: 4,
                      fontSize: 11,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                      background: pc.bg,
                      color: pc.color,
                    }}>
                      {task.payment_status}
                    </span>
                  );
                })()}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', position: 'relative', padding: '8px 0' }}>
            {statusOrder.map((step, i) => {
              const isCompleted = i <= currentStepIndex;
              const isCurrent = i === currentStepIndex;
              const isFuture = i > currentStepIndex;
              const stepColor = STATUS_COLORS[step] || STATUS_COLORS.cancelled;
              const dotColor = isCompleted ? stepColor.color : 'var(--border)';
              const timestamp = stepTimestamps[step] || null;
              const isLast = i === statusOrder.length - 1;

              return (
                <div key={step} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: isLast ? '0 0 auto' : 1, position: 'relative', minWidth: 80 }}>
                  {/* Connector line before dot */}
                  {i > 0 && (
                    <div style={{
                      position: 'absolute',
                      top: 10,
                      right: '50%',
                      width: '100%',
                      height: 2,
                      background: isCompleted ? stepColor.color : 'var(--border)',
                      opacity: isCompleted ? 0.5 : 0.3,
                      zIndex: 0,
                    }} />
                  )}
                  {/* Dot */}
                  <div style={{
                    width: isCurrent ? 22 : 16,
                    height: isCurrent ? 22 : 16,
                    borderRadius: '50%',
                    background: isCompleted ? dotColor : 'var(--bg-tertiary)',
                    border: `2px solid ${isCompleted ? dotColor : 'var(--border)'}`,
                    zIndex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: isCurrent ? `0 0 8px ${dotColor}44` : 'none',
                    animation: isCurrent && !isCancelled ? 'pulse-dot 2s ease-in-out infinite' : 'none',
                    transition: 'all 200ms ease',
                  }}>
                    {isCompleted && (
                      <span style={{ color: '#fff', fontSize: isCurrent ? 11 : 9, fontWeight: 700, lineHeight: 1 }}>
                        {step === 'cancelled' ? '×' : '✓'}
                      </span>
                    )}
                  </div>
                  {/* Label */}
                  <div style={{
                    marginTop: 8,
                    fontSize: 12,
                    fontWeight: isCurrent ? 600 : 500,
                    color: isFuture ? 'var(--text-tertiary)' : stepColor.color,
                    textTransform: 'capitalize',
                    opacity: isFuture ? 0.5 : 1,
                  }}>
                    {step}
                  </div>
                  {/* Timestamp */}
                  {timestamp && isCompleted && (
                    <div style={{
                      marginTop: 2,
                      fontSize: 10,
                      color: 'var(--text-tertiary)',
                      fontFamily: 'var(--font-mono)',
                      whiteSpace: 'nowrap',
                    }}>
                      {formatDate(timestamp)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {/* Pulse animation */}
          <style>{`
            @keyframes pulse-dot {
              0%, 100% { box-shadow: 0 0 4px rgba(255,255,255,0.1); }
              50% { box-shadow: 0 0 12px rgba(255,255,255,0.3); }
            }
          `}</style>
        </div>

        {/* Description */}
        <div style={sectionStyle}>
          <div style={labelStyle}>Description</div>
          <div style={{ ...valueStyle, whiteSpace: 'pre-wrap' }}>{task.description}</div>
        </div>

        {/* Details grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginBottom: 16 }}>
          {/* Agents */}
          <div style={sectionStyle}>
            <div style={labelStyle}>Creator</div>
            <div style={valueStyle}>
              <Link to={`/agents/${task.creator_agent_id}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                {task.creator_agent_id.slice(0, 16)}...
              </Link>
            </div>
            {task.claimed_by_agent_id && (
              <>
                <div style={{ ...labelStyle, marginTop: 14 }}>Claimed By</div>
                <div style={valueStyle}>
                  <Link to={`/agents/${task.claimed_by_agent_id}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                    {task.claimed_by_agent_id.slice(0, 16)}...
                  </Link>
                </div>
              </>
            )}
          </div>

          {/* Output info */}
          <div style={sectionStyle}>
            <div style={labelStyle}>Output Format</div>
            <div style={{ ...valueStyle, fontFamily: 'var(--font-mono)' }}>{task.output_format}</div>
            {task.expected_output && (
              <>
                <div style={{ ...labelStyle, marginTop: 14 }}>Expected Output</div>
                <div style={valueStyle}>{task.expected_output}</div>
              </>
            )}
          </div>
        </div>

        {/* Capabilities */}
        {capabilities.length > 0 && (
          <div style={sectionStyle}>
            <div style={labelStyle}>Required Capabilities</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              {capabilities.map(cap => (
                <span key={cap} style={{
                  padding: '3px 10px',
                  borderRadius: 4,
                  fontSize: 12,
                  background: 'var(--bg-primary)',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                }}>
                  {cap}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Timestamps */}
        <div style={sectionStyle}>
          <div style={labelStyle}>Timeline</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginTop: 8 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>Created</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{formatDate(task.created_at)}</div>
            </div>
            {task.claimed_at && (
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>Claimed</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{formatDate(task.claimed_at)}</div>
              </div>
            )}
            {task.submitted_at && (
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>Submitted</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{formatDate(task.submitted_at)}</div>
              </div>
            )}
            {task.verified_at && (
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>Verified</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{formatDate(task.verified_at)}</div>
              </div>
            )}
          </div>
        </div>

        {/* Submission */}
        {submission && (
          <div style={sectionStyle}>
            <div style={{ ...labelStyle, color: '#3B82F6' }}>Submission</div>
            <div style={{ marginTop: 8 }}>
              <div style={labelStyle}>Summary</div>
              <div style={{ ...valueStyle, marginBottom: 12 }}>{submission.summary}</div>

              <div style={labelStyle}>Type</div>
              <div style={{ ...valueStyle, fontFamily: 'var(--font-mono)', marginBottom: 12 }}>{submission.submission_type}</div>

              <div style={labelStyle}>Content</div>
              {submission.submission_type === 'link' ? (
                <a href={submission.content} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', fontSize: 14, wordBreak: 'break-all' }}>
                  {submission.content}
                </a>
              ) : (
                <pre style={{
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: 14,
                  fontSize: 13,
                  color: 'var(--text-secondary)',
                  fontFamily: 'var(--font-mono)',
                  overflow: 'auto',
                  maxHeight: 300,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  margin: 0,
                }}>
                  {tryFormatJson(submission.content)}
                </pre>
              )}
            </div>
          </div>
        )}

        {/* Delivery Receipt */}
        {receipt && (
          <div style={{ ...sectionStyle, borderColor: 'rgba(139, 92, 246, 0.3)' }}>
            <div style={{ ...labelStyle, color: '#8B5CF6' }}>Delivery Receipt</div>
            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 14 }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>Receipt ID</div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{truncateHash(receipt.receipt_id)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>Completed</div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{formatDate(receipt.completed_at)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>Type</div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{receipt.submission_type}</div>
                </div>
              </div>

              <div style={labelStyle}>Summary</div>
              <div style={{ ...valueStyle, marginBottom: 12 }}>{receipt.summary}</div>

              {receipt.commit_hash && (
                <div style={{ marginBottom: 10 }}>
                  <div style={labelStyle}>Commit</div>
                  <div style={{ fontSize: 13, color: '#38BDF8', fontFamily: 'var(--font-mono)' }}>{receipt.commit_hash}</div>
                </div>
              )}

              {receipt.pr_url && (
                <div style={{ marginBottom: 10 }}>
                  <div style={labelStyle}>Pull Request</div>
                  <a href={receipt.pr_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', fontSize: 13, wordBreak: 'break-all' }}>
                    {receipt.pr_url}
                  </a>
                </div>
              )}

              {receipt.artifact_urls && receipt.artifact_urls.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={labelStyle}>Artifacts</div>
                  {receipt.artifact_urls.map((url, i) => (
                    <div key={i}>
                      <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', fontSize: 13, wordBreak: 'break-all' }}>
                        {url}
                      </a>
                    </div>
                  ))}
                </div>
              )}

              {receipt.chain_sequence !== null && (
                <div style={{ display: 'flex', gap: 24, marginTop: 10 }}>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>Chain Sequence</div>
                    <div style={{ fontSize: 13, color: '#38BDF8', fontFamily: 'var(--font-mono)' }}>#{receipt.chain_sequence}</div>
                  </div>
                  {receipt.chain_entry_hash && (
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>Entry Hash</div>
                      <div style={{ fontSize: 13, color: '#38BDF8', fontFamily: 'var(--font-mono)' }}>{truncateHash(receipt.chain_entry_hash)}</div>
                    </div>
                  )}
                </div>
              )}

              <div style={{ marginTop: 12 }}>
                <div style={labelStyle}>Signature</div>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{truncateHash(receipt.signature, 32)}</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function tryFormatJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}
