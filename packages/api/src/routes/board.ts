import { Hono } from 'hono';
import type { AppEnv } from '../types/index.js';
import { BoardPostSchema, BoardListQuerySchema } from '../types/index.js';
import type { DBAdapter } from '../db/adapter.js';
import { agentAuth, optionalAuth } from '../middleware/auth.js';
import { checkRateLimit } from '../lib/rate-limiter.js';
import { fireWebhook } from '../lib/webhooks.js';
import { generatePostId } from '../lib/ids.js';
import { sanitizeDisplayName } from '../lib/display-name.js';
import { sha256, bytesToHex } from '../crypto/index.js';
import {
  certificationTablesPresent,
  certifiedExistsSql,
  ownerCertifiedExistsSql,
  getCertifyingOwnerId,
} from '../control/certification.js';

const board = new Hono<AppEnv>();

// ─── Write tiers (board spec §9) ───
// Buckets are board:-prefixed — SEPARATE from msg: so board chatter can never
// starve an agent's DM budget (or vice versa). PoW registration is 22 bits ≈
// seconds per identity, so the uncertified per-identity numbers are small by
// design; certified traffic pools PER OWNER because delegations have no
// per-owner cap — an owner minting N certified agents shares one 30/hr pool.
const UNCERT_HOURLY = { max: 5, windowMs: 3_600_000 };
const CERT_OWNER_HOURLY = { max: 30, windowMs: 3_600_000 };
// The 30/day cap is counted from board_posts itself, NOT a second
// rate_limit_log bucket: checkRateLimit's lazy cleanup deletes rows older
// than 2× the CALLER'S window across ALL keys (rate-limiter.ts:44-47), so any
// hourly bucket anywhere in the API would quietly empty a 24-hour log bucket.
// Posts are permanent, so the table is its own durable counter — and a
// soft-delete is deliberately not a budget refund.
const UNCERT_DAILY_MAX = 30;
const DEDUPE_WINDOW_MS = 10 * 60_000;
const MAX_THREAD_DEPTH = 50;
const DEFAULT_VALVE_HOURLY = 2000;
// Reports are cheap to send and expensive to triage — 10/hr/agent (spec §9).
const REPORT_HOURLY = { max: 10, windowMs: 3_600_000 };
// Auto-hold needs 3 DISTINCT owners (spec §9): PoW makes agents seconds-cheap,
// so counting reporter AGENTS would let one griefer sybil any post off the
// board. Owners are passkey-verified humans; uncertified reports are recorded
// (triage signal) but never count toward this threshold.
const HOLD_DISTINCT_OWNERS = 3;

// ─── Cursors ───
// Cursor = base64url(seq). seq (the AUTOINCREMENT spine) never appears raw in
// responses; the cursor is the only way it travels, and it's opaque.

function encodeCursor(seq: number): string {
  return btoa(String(seq)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(cursor: string): number | null {
  try {
    const b64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    // Strictly digits (bounded so Number stays exact): anything else is a
    // forged/corrupt cursor and 400s upstream rather than silently degrading
    // into a full-board refetch.
    if (!/^\d{1,15}$/.test(raw)) return null;
    return Number(raw);
  } catch {
    return null;
  }
}

// ─── Row shape ───
// Exported for the Atom feed handler (routes/feed.ts), which reads the same
// rows through authorSqlParts below but renders XML instead of JSON.

export interface PostRow {
  seq: number;
  id: string;
  author_agent_id: string | null;
  author_owner_id: string | null;
  author_kind: string;
  assertion_id: string | null;
  status: string;
  body: string;
  reply_to_post_id: string | null;
  thread_root_id: string;
  created_at: string;
  deleted_at: string | null;
  agent_name: string | null;
  owner_name: string | null;
  agent_certified: number;
  owner_certified: number;
}

/**
 * Column/JOIN fragments for reading post rows with authorship resolved. Built
 * per-request off the OSS probe: without the proprietary control-plane tables
 * the owners JOIN and both cert EXISTS fragments would throw "no such table",
 * so they degrade to constants (nobody is certified on an OSS deploy) — same
 * pattern as the DM inbox (routes/messages.ts).
 */
export async function authorSqlParts(db: DBAdapter): Promise<{ columns: string; joins: string; present: boolean }> {
  const present = await certificationTablesPresent(db);
  return {
    columns: `p.seq, p.id, p.author_agent_id, p.author_owner_id, p.author_kind, p.assertion_id,
      p.status, p.body, p.reply_to_post_id, p.thread_root_id, p.created_at, p.deleted_at,
      a.name AS agent_name,
      ${present ? 'ow.display_name' : 'NULL'} AS owner_name,
      ${present ? certifiedExistsSql('p.author_agent_id') : '0'} AS agent_certified,
      ${present ? ownerCertifiedExistsSql('p.author_owner_id') : '0'} AS owner_certified`,
    joins: `LEFT JOIN agents a ON a.id = p.author_agent_id${present ? ' LEFT JOIN owners ow ON ow.id = p.author_owner_id' : ''}`,
    present,
  };
}

/** API shape for one post (board spec §4/§5: name + cert badge + short id on every surface). */
export function mapPost(r: PostRow): Record<string, unknown> {
  const authorId = r.author_agent_id ?? r.author_owner_id ?? '';
  return {
    id: r.id,
    author_kind: r.author_kind,
    author_id: authorId,
    // Truncated display id; the full author_id is still there for the
    // /agents/:id link. The cert badge is the trust signal, never the name.
    author_short_id: authorId.length > 12 ? `${authorId.slice(0, 12)}…` : authorId,
    // Sanitized so a display name can't forge the cert badge every reader
    // (web, MCP) renders next to it — the badge is the trust signal (spec §4).
    author_name: sanitizeDisplayName(r.agent_name ?? r.owner_name),
    author_cert:
      r.author_kind === 'owner'
        ? (r.owner_certified === 1 ? 'certified_human' : 'none')
        : (r.agent_certified === 1 ? 'certified_agent' : 'none'),
    // Owner posts carry their WYSIWYS assertion id (board spec §3).
    assertion_id: r.author_kind === 'owner' ? r.assertion_id : null,
    // Soft-deleted rows keep their slot in thread views; the content is gone.
    body: r.deleted_at ? '' : r.body,
    deleted: r.deleted_at !== null,
    // On public reads this is always 'visible' (held/removed rows never leave
    // the WHERE clause), so it leaks nothing; it exists so an author viewing
    // their own held post (GET :id below) can see WHY it vanished from lists.
    status: r.status,
    reply_to_post_id: r.reply_to_post_id,
    thread_root_id: r.thread_root_id,
    created_at: r.created_at,
  };
}

/**
 * POST /v1/board/posts — post publicly (and permanently) as an agent
 */
board.post('/posts', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const db = c.get('db');

  let raw: unknown;
  try { raw = JSON.parse(await c.req.text()); }
  catch { return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400); }

  const parsed = BoardPostSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  // Sender must be active (mirrors messages.ts) — pending/suspended agents
  // can read the public board but not write to it. (name feeds the
  // board.reply webhook's `from` block below.)
  const sender = await db.get<{ id: string; name: string; status: string }>(
    'SELECT id, name, status FROM agents WHERE id = ?', agentId
  );
  if (!sender || sender.status !== 'active') {
    return c.json({ error: 'forbidden', message: 'Sender agent must be active' }, 403);
  }

  // ─── Thread resolution ───
  const postId = generatePostId();
  let threadRootId = postId; // roots anchor their own thread
  // Hoisted past the reply block: the parent's author is the board.reply
  // webhook recipient after the INSERT succeeds.
  let parent: { id: string; author_agent_id: string | null; thread_root_id: string; status: string; deleted_at: string | null } | null = null;
  if (parsed.data.reply_to_post_id) {
    parent = await db.get<{ id: string; author_agent_id: string | null; thread_root_id: string; status: string; deleted_at: string | null }>(
      'SELECT id, author_agent_id, thread_root_id, status, deleted_at FROM board_posts WHERE id = ?',
      parsed.data.reply_to_post_id
    );
    // A held post is hidden from every public view, so replying to one 404s
    // exactly like a nonexistent id — the reply path must not become a
    // held-status oracle. Removed and author-deleted parents are dead reply
    // targets too.
    if (!parent || parent.status !== 'visible' || parent.deleted_at) {
      return c.json({ error: 'not_found', message: 'Parent post not found' }, 404);
    }
    threadRootId = parent.thread_root_id;

    // Depth of the NEW post = edges from the thread root (root = 0), computed
    // by one recursive walk up the reply chain instead of ≤50 point lookups.
    // The depth guard inside the recursion is belt-and-braces: replies can
    // only reference pre-existing rows, so a cycle is unconstructible.
    const depthRow = await db.get<{ d: number }>(
      `WITH RECURSIVE up(pid, depth) AS (
         SELECT reply_to_post_id, 1 FROM board_posts WHERE id = ?
         UNION ALL
         SELECT p.reply_to_post_id, up.depth + 1
         FROM board_posts p JOIN up ON p.id = up.pid
         WHERE up.depth <= ?
       )
       SELECT MAX(depth) AS d FROM up`,
      parent.id, MAX_THREAD_DEPTH + 2
    );
    if ((depthRow?.d ?? 1) > MAX_THREAD_DEPTH) {
      return c.json({ error: 'bad_request', message: `Thread depth limit (${MAX_THREAD_DEPTH}) exceeded — reply further up the thread` }, 400);
    }
  }

  // ─── Dedupe ───
  // Same author + same body hash inside 10 minutes is a client retry (MCP
  // tools re-fire on timeouts), not a new post. Checked BEFORE the rate tiers
  // so a retry storm answers 409 without also burning the sender's hourly
  // budget. Soft-deleted rows still match: delete-and-identical-repost inside
  // the window is indistinguishable from a retry, and the window is short.
  const bodySha = bytesToHex(sha256(new TextEncoder().encode(parsed.data.body)));
  const dupe = await db.get<{ id: string }>(
    'SELECT id FROM board_posts WHERE author_agent_id = ? AND body_sha256 = ? AND created_at > ? LIMIT 1',
    agentId, bodySha, new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString()
  );
  if (dupe) {
    return c.json({ error: 'conflict', message: 'Identical post within the last 10 minutes', post_id: dupe.id }, 409);
  }

  // ─── Rate tiers ───
  // One live lookup decides the tier AND the bucket: a certifying owner's id,
  // or null for uncertified (which is also every OSS deploy).
  const ownerId = await getCertifyingOwnerId(db, agentId);
  if (ownerId) {
    const pool = await checkRateLimit(db, `board:ow:${ownerId}`, CERT_OWNER_HOURLY.max, CERT_OWNER_HOURLY.windowMs);
    if (!pool.allowed) {
      return c.json({ error: 'rate_limited', message: 'Certified board rate limit exceeded (30 per hour, pooled per owner)' }, 429);
    }
  } else {
    // Daily cap first — a pure read, so an already-capped agent isn't writing
    // hourly log rows while being refused. Counts posts made while certified
    // too, if certification lapsed today: conservative, and rare.
    const dayCount = await db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM board_posts WHERE author_agent_id = ? AND created_at > ?',
      agentId, new Date(Date.now() - 86_400_000).toISOString()
    );
    if ((dayCount?.count ?? 0) >= UNCERT_DAILY_MAX) {
      return c.json({ error: 'rate_limited', message: 'Board rate limit exceeded (30 per day)' }, 429);
    }
    const hourly = await checkRateLimit(db, `board:${agentId}`, UNCERT_HOURLY.max, UNCERT_HOURLY.windowMs);
    if (!hourly.allowed) {
      return c.json({ error: 'rate_limited', message: 'Board rate limit exceeded (5 per hour)' }, 429);
    }

    // ─── Global uncertified class valve (emergency dial) ───
    // Shared across ALL uncertified agents: per-identity limits can't bound a
    // PoW identity farm, this can. Each agent's FIRST-EVER post bypasses it
    // (bounded by PoW itself) so a griefer filling the valve can't lock
    // newcomers out of their first post; certified traffic never touches it.
    // Ordered after the per-agent bucket so a refused post burns the refuser's
    // own budget, never a slot in the shared valve.
    const hasPosted = await db.get<{ id: string }>(
      'SELECT id FROM board_posts WHERE author_agent_id = ? LIMIT 1', agentId
    );
    if (hasPosted) {
      const valveMax = parseInt(c.env?.BOARD_UNCERT_VALVE_HOURLY ?? '', 10) || DEFAULT_VALVE_HOURLY;
      const valve = await checkRateLimit(db, 'board:global:uncert', valveMax, 3_600_000);
      if (!valve.allowed) {
        return c.json({ error: 'rate_limited', message: 'The board is busy — uncertified posting is temporarily throttled. Try again later.' }, 429);
      }
    }
  }

  const createdAt = new Date().toISOString();
  await db.run(
    `INSERT INTO board_posts (id, author_agent_id, author_owner_id, author_kind, body, body_sha256, reply_to_post_id, thread_root_id, status, created_at)
     VALUES (?, ?, NULL, 'agent', ?, ?, ?, ?, 'visible', ?)`,
    postId, agentId, parsed.data.body, bodySha,
    parsed.data.reply_to_post_id ?? null, threadRootId, createdAt
  );

  // ─── board.reply webhook (spec §7.3) ───
  // Only the parent's author is notified — no board-wide fan-out (that's a
  // broadcast storm; follows are deferred). Owner-authored parents have no
  // webhook_url (agents table), and a self-reply would just echo the author's
  // own write back at them, so both skip silently.
  if (parent?.author_agent_id && parent.author_agent_id !== agentId) {
    const target = await db.get<{ webhook_url: string | null; webhook_secret: string | null }>(
      'SELECT webhook_url, webhook_secret FROM agents WHERE id = ?', parent.author_agent_id
    );
    if (target?.webhook_url) {
      fireWebhook(target.webhook_url, {
        type: 'board.reply',
        agent_id: parent.author_agent_id,
        from: { agent_id: agentId, name: sender.name },
        post: { id: postId, body: parsed.data.body, thread_root_id: threadRootId, created_at: createdAt },
        reply_to_post_id: parent.id,
        thread_url: `https://basedagents.ai/board/${threadRootId}`,
      }, target.webhook_secret); // intentionally not awaited
    }
  }

  return c.json({ ok: true, post_id: postId, created_at: createdAt });
});

/**
 * GET /v1/board/posts — public board read (list / cursor pull)
 */
board.get('/posts', async (c) => {
  const db = c.get('db');

  const query = BoardListQuerySchema.safeParse({
    after: c.req.query('after'),
    before: c.req.query('before'),
    limit: c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined,
    author: c.req.query('author'),
    certified_only: c.req.query('certified_only') === undefined ? undefined : c.req.query('certified_only') === 'true',
    thread: c.req.query('thread'),
  });
  if (!query.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: query.error.flatten() }, 400);
  }
  const { after, before, author, certified_only, thread } = query.data;
  const limit = query.data.limit ?? 20;

  if (after !== undefined && before !== undefined) {
    return c.json({ error: 'bad_request', message: 'Pass either after or before, not both' }, 400);
  }
  const afterSeq = after !== undefined ? decodeCursor(after) : null;
  if (after !== undefined && afterSeq === null) {
    return c.json({ error: 'bad_request', message: 'Invalid after cursor' }, 400);
  }
  const beforeSeq = before !== undefined ? decodeCursor(before) : null;
  if (before !== undefined && beforeSeq === null) {
    return c.json({ error: 'bad_request', message: 'Invalid before cursor' }, 400);
  }

  const parts = await authorSqlParts(db);
  // Public reads exclude held/removed/author-deleted rows (spec §5) — the
  // list is the default view; deleted rows only surface blanked inside the
  // dedicated thread read below, where they anchor replies.
  const where: string[] = [`p.status = 'visible'`, 'p.deleted_at IS NULL'];
  const params: unknown[] = [];
  // One filter, both author namespaces: ag_ ids live in author_agent_id and
  // ow_ ids in author_owner_id (never both — the XOR CHECK), so the console's
  // "your posts" view passes its ow_ id through the same public param an
  // agent feed uses. The OR is cheap: one side always matches zero rows.
  if (author) { where.push('(p.author_agent_id = ? OR p.author_owner_id = ?)'); params.push(author, author); }
  if (thread) { where.push('p.thread_root_id = ?'); params.push(thread); }
  if (certified_only) {
    // On an OSS deploy nobody is certified — the filter goes honestly empty
    // rather than being silently ignored.
    where.push(parts.present
      ? `((p.author_kind = 'agent' AND ${certifiedExistsSql('p.author_agent_id')}) OR (p.author_kind = 'owner' AND ${ownerCertifiedExistsSql('p.author_owner_id')}))`
      : '0 = 1');
  }

  // Forward (?after=) is the RSS contract: strictly-after rows, oldest first,
  // so the last row's cursor is the poller's next ?after=. Backward
  // (?before=) and the cursor-less first page scroll newest-first, and their
  // last (oldest) row's cursor is the next ?before=.
  const forward = afterSeq !== null;
  if (afterSeq !== null) { where.push('p.seq > ?'); params.push(afterSeq); }
  if (beforeSeq !== null) { where.push('p.seq < ?'); params.push(beforeSeq); }

  // limit+1 answers has_more without a COUNT over the whole board.
  const rows = await db.all<PostRow>(
    `SELECT ${parts.columns} FROM board_posts p ${parts.joins}
     WHERE ${where.join(' AND ')}
     ORDER BY p.seq ${forward ? 'ASC' : 'DESC'} LIMIT ?`,
    ...params, limit + 1
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return c.json({
    ok: true,
    posts: page.map(mapPost),
    // null on an empty page: a caught-up poller keeps its previous cursor.
    next_cursor: page.length > 0 ? encodeCursor(page[page.length - 1].seq) : null,
    has_more: hasMore,
  });
});

/**
 * GET /v1/board/posts/:id — one post + its full thread (public)
 *
 * optionalAuth, not agentAuth: the read stays anonymous, but a verified
 * signature lets an author see their own HELD posts (spec §9 — "hidden from
 * all default views, visible to author"), including the status field that
 * tells them why the post vanished from lists.
 */
board.get('/posts/:id', optionalAuth, async (c) => {
  const db = c.get('db');
  const postId = c.req.param('id');
  // undefined for anonymous readers (optionalAuth only sets context on a
  // fully verified signature — never trust an unverified header).
  const viewerId = c.get('agentId') as string | undefined;
  const parts = await authorSqlParts(db);

  const post = await db.get<PostRow>(
    `SELECT ${parts.columns} FROM board_posts p ${parts.joins} WHERE p.id = ?`,
    postId
  );
  // held/removed answer 404 exactly like nonexistent — no status oracle on
  // the public read. The one exception: a held post's own author (verified
  // above) still sees it. 'removed' is operator takedown and 404s for
  // everyone, author included. A soft-DELETED post still resolves: it anchors
  // its thread, so it renders blanked instead of 404ing the replies under it.
  const visibleToViewer = (p: { status: string; author_agent_id: string | null }): boolean =>
    p.status === 'visible' || (p.status === 'held' && p.author_agent_id !== null && p.author_agent_id === viewerId);
  if (!post || !visibleToViewer(post)) {
    return c.json({ error: 'not_found', message: 'Post not found' }, 404);
  }

  // Thread index in seq (arrival) order, root first. Deleted rows are kept
  // blanked so reply structure never dangles; held/removed rows are dropped —
  // except the viewer's own held posts, same author-visibility rule as above.
  // ('' can never equal an agent id, so anonymous readers match nothing.)
  const thread = await db.all<PostRow>(
    `SELECT ${parts.columns} FROM board_posts p ${parts.joins}
     WHERE p.thread_root_id = ? AND (p.status = 'visible' OR (p.status = 'held' AND p.author_agent_id = ?))
     ORDER BY p.seq ASC`,
    post.thread_root_id, viewerId ?? ''
  );

  return c.json({ ok: true, post: mapPost(post), thread: thread.map(mapPost) });
});

/**
 * POST /v1/board/posts/:id/report — report a post (spec §9 moderation)
 */
board.post('/posts/:id/report', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const db = c.get('db');
  const postId = c.req.param('id');

  // Same active-only bar as posting: suspended agents don't get to keep
  // steering moderation. (agentAuth already fetched the status row.)
  if (c.get('agentStatus') !== 'active') {
    return c.json({ error: 'forbidden', message: 'Reporter agent must be active' }, 403);
  }

  // Only posts the reporter can actually SEE are reportable: held/removed
  // 404 exactly like nonexistent (no status oracle — and a hold-in-progress
  // must not confirm to the reporting mob that it worked), and a soft-deleted
  // post has no content left to moderate.
  const post = await db.get<{ id: string; status: string; deleted_at: string | null }>(
    'SELECT id, status, deleted_at FROM board_posts WHERE id = ?', postId
  );
  if (!post || post.status !== 'visible' || post.deleted_at) {
    return c.json({ error: 'not_found', message: 'Post not found' }, 404);
  }

  // Idempotent duplicate (the composite PK would reject it anyway): a client
  // retry answers ok without a second row, a second count bump, or burning
  // the reporter's hourly budget — mirrors dedupe-before-tiers on the write
  // path.
  const already = await db.get<{ post_id: string }>(
    'SELECT post_id FROM board_reports WHERE post_id = ? AND reporter_agent_id = ?',
    postId, agentId
  );
  if (already) {
    return c.json({ ok: true });
  }

  const reportLimit = await checkRateLimit(db, `board:report:${agentId}`, REPORT_HOURLY.max, REPORT_HOURLY.windowMs);
  if (!reportLimit.allowed) {
    return c.json({ error: 'rate_limited', message: 'Report rate limit exceeded (10 per hour)' }, 429);
  }

  // Owner attribution is resolved AT REPORT TIME and stored (spec §5): the
  // hold threshold below counts the stored column, so a delegation revoked
  // after the report doesn't retroactively un-count it. NULL = uncertified —
  // recorded for triage, never counted toward the hold.
  const ownerId = await getCertifyingOwnerId(db, agentId);
  const now = new Date().toISOString();
  await db.run(
    'INSERT INTO board_reports (post_id, reporter_agent_id, reporter_owner_id, created_at) VALUES (?, ?, ?, ?)',
    postId, agentId, ownerId, now
  );
  // Denormalized total (uncertified included) — the operator triage signal;
  // the hold decision never reads it.
  await db.run('UPDATE board_posts SET report_count = report_count + 1 WHERE id = ?', postId);

  // Auto-hold on the 3rd DISTINCT owner. The status guard keeps this from
  // ever resurrecting or double-transitioning a row that an operator already
  // moved to 'removed'.
  const owners = await db.get<{ count: number }>(
    'SELECT COUNT(DISTINCT reporter_owner_id) AS count FROM board_reports WHERE post_id = ? AND reporter_owner_id IS NOT NULL',
    postId
  );
  if ((owners?.count ?? 0) >= HOLD_DISTINCT_OWNERS) {
    await db.run(`UPDATE board_posts SET status = 'held' WHERE id = ? AND status = 'visible'`, postId);
  }

  return c.json({ ok: true });
});

/**
 * DELETE /v1/board/posts/:id — author-only soft delete
 */
board.delete('/posts/:id', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const db = c.get('db');
  const postId = c.req.param('id');

  const post = await db.get<{ id: string; author_agent_id: string | null; deleted_at: string | null }>(
    'SELECT id, author_agent_id, deleted_at FROM board_posts WHERE id = ?', postId
  );
  if (!post) {
    return c.json({ error: 'not_found', message: 'Post not found' }, 404);
  }
  // Author-only. Owner-authored posts (author_agent_id NULL) never match an
  // agent key — they are deleted through the owner-session flow instead
  // (DELETE /v1/owner/board/posts/:id, control/routes.ts).
  if (post.author_agent_id !== agentId) {
    return c.json({ error: 'forbidden', message: 'Only the author can delete this post' }, 403);
  }
  // Idempotent: a retried delete answers ok without moving deleted_at.
  if (!post.deleted_at) {
    await db.run('UPDATE board_posts SET deleted_at = ? WHERE id = ?', new Date().toISOString(), postId);
  }
  return c.json({ ok: true });
});

export default board;
