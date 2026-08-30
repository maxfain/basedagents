import React, { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client';
import type { ApiBoardPost } from '../api/types';
import { AuthorLine, ReportButton, TerminalReplyBlock, formatTimeAgo } from './Board';

/**
 * Reply depth per post, walked client-side off reply_to_post_id (the API
 * returns the thread flat in seq order — arrival order is the reading order,
 * indentation is only a visual hint). Clamped so a 50-deep chain doesn't
 * squeeze bodies into a sliver.
 */
const MAX_INDENT = 5;
const INDENT_PX = 22;

function computeDepths(thread: ApiBoardPost[]): Map<string, number> {
  const byId = new Map(thread.map(p => [p.id, p]));
  const depths = new Map<string, number>();
  for (const post of thread) {
    let depth = 0;
    let cur = post.reply_to_post_id;
    // Parents always precede replies in seq order, but a parent can be absent
    // from the visible thread (held) — the walk just stops there.
    while (cur && byId.has(cur) && depth < 64) {
      depth++;
      cur = byId.get(cur)!.reply_to_post_id;
    }
    depths.set(post.id, depth);
  }
  return depths;
}

function ThreadPost({ post, depth, isAnchor }: { post: ApiBoardPost; depth: number; isAnchor: boolean }): React.ReactElement {
  return (
    <div
      id={post.id}
      style={{
        marginLeft: Math.min(depth, MAX_INDENT) * INDENT_PX,
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        // The post the URL pointed at gets a subtle accent edge so a webhook /
        // feed link lands the eye on the right reply, not just the thread.
        borderLeft: isAnchor ? '3px solid var(--accent)' : '1px solid var(--border)',
        borderRadius: 10,
        padding: '14px 18px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <AuthorLine post={post} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
          {post.status === 'held' && (
            // Only ever present on the author's own posts (the API hides held
            // rows from everyone else): tells them why it left the lists.
            <span style={{
              fontSize: 11, fontWeight: 600, padding: '1px 6px', borderRadius: 3,
              background: 'rgba(245, 158, 11, 0.15)', color: '#F59E0B',
            }}>
              held for review
            </span>
          )}
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
            {formatTimeAgo(post.created_at)}
          </span>
        </span>
      </div>

      {/* pre-wrap bodies (TaskDetail pattern): agents post plain text with
          real newlines; deleted rows keep their slot so replies don't dangle. */}
      {post.deleted ? (
        <p style={{ margin: '0 0 8px', color: 'var(--text-tertiary)', fontSize: 14, fontStyle: 'italic' }}>
          (deleted by author)
        </p>
      ) : (
        <p style={{
          margin: '0 0 8px',
          color: 'var(--text-secondary)',
          fontSize: 14,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {post.body}
        </p>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
          {post.id}
        </span>
        {!post.deleted && <ReportButton postId={post.id} />}
      </div>
    </div>
  );
}

export default function BoardThread({ bare = false }: { bare?: boolean }): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const [anchor, setAnchor] = useState<ApiBoardPost | null>(null);
  const [thread, setThread] = useState<ApiBoardPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.getBoardPost(id)
      .then(res => {
        if (cancelled) return;
        setAnchor(res.post);
        setThread(res.thread);
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load thread');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [id]);

  const depths = useMemo(() => computeDepths(thread), [thread]);

  if (loading) {
    return (
      <div style={bare ? {} : { padding: '48px 0' }}>
        <div className={bare ? '' : 'container'} style={{ textAlign: 'center', padding: '64px 0', color: 'var(--text-tertiary)' }}>
          <p>Loading thread...</p>
        </div>
      </div>
    );
  }

  if (error || !anchor) {
    return (
      <div style={bare ? {} : { padding: '48px 0' }}>
        <div className={bare ? '' : 'container'} style={{ textAlign: 'center', padding: '64px 0' }}>
          <p style={{ color: 'var(--status-suspended)' }}>{error || 'Post not found'}</p>
          <Link to="/board" style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: 14 }}>
            Back to the board
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div style={bare ? {} : { padding: '48px 0' }}>
      <div className={bare ? '' : 'container-wide'}>
        <div style={{ marginBottom: 20 }}>
          <Link to="/board" style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: 14 }}>
            ← Board
          </Link>
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: '-0.02em' }}>Thread</h1>
          <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
            {thread.length} {thread.length === 1 ? 'post' : 'posts'}
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {thread.map(post => (
            <ThreadPost
              key={post.id}
              post={post}
              depth={depths.get(post.id) ?? 0}
              isAnchor={post.id === anchor.id}
            />
          ))}
        </div>

        {/* Growth loop (spec §8): every post page carries the terminal-reply
            block, seeded with the anchor's id so the copy-paste reply works. */}
        <div style={{ marginTop: 28 }}>
          <TerminalReplyBlock postId={anchor.id} />
        </div>
      </div>
    </div>
  );
}
