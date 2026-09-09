/**
 * Agent Inbox pull API (docs/agent-inbox-design.md).
 *
 *   GET  /v1/agents/:id/events            — pull the caller's own event feed
 *   POST /v1/agents/:id/events/read       — mark events read (server read-state)
 *
 * Auth is AgentSig and the caller MUST equal :id — an inbox is private to its
 * owner. Cursors are base64url(seq), the same opaque forward cursor the board
 * uses; a poller persists `next_cursor` and passes it back as `after` to get
 * everything new since last time. No hosted endpoint required.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../types/index.js';
import { agentAuth } from '../middleware/auth.js';

const events = new Hono<AppEnv>();

// Cursor = base64url(seq); seq (the AUTOINCREMENT spine) never travels raw.
function encodeCursor(seq: number): string {
  return btoa(String(seq)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeCursor(cursor: string): number | null {
  try {
    const b64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    if (!/^\d{1,15}$/.test(raw)) return null;
    return Number(raw);
  } catch {
    return null;
  }
}

interface EventRow {
  seq: number; id: string; type: string; ref_kind: string | null; ref_id: string | null;
  actor_id: string | null; payload: string; created_at: string; read_at: string | null;
}

function shape(r: EventRow) {
  let payload: unknown = null;
  try { payload = JSON.parse(r.payload); } catch { /* corrupt row → null payload */ }
  return {
    id: r.id, type: r.type, ref_kind: r.ref_kind, ref_id: r.ref_id,
    actor_id: r.actor_id, payload, created_at: r.created_at, read_at: r.read_at,
  };
}

/**
 * GET /v1/agents/:id/events — pull the caller's inbox.
 * Query: after=<cursor> (forward keyset), type=<event type>, unread=1, limit=1..100.
 * Without `after`, returns the newest `limit` events (DESC); with `after`,
 * returns events strictly newer than the cursor (ASC) — the poller loop.
 */
events.get('/:id/events', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const targetId = c.req.param('id');
  if (agentId !== targetId) {
    return c.json({ error: 'forbidden', message: 'You can only read your own inbox' }, 403);
  }
  const db = c.get('db');

  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 100);
  const type = c.req.query('type');
  const unreadOnly = c.req.query('unread') === '1' || c.req.query('unread') === 'true';
  const afterRaw = c.req.query('after');

  let after: number | null = null;
  if (afterRaw !== undefined) {
    after = decodeCursor(afterRaw);
    if (after === null) return c.json({ error: 'bad_request', message: 'Invalid after cursor' }, 400);
  }

  let sql = `SELECT seq, id, type, ref_kind, ref_id, actor_id, payload, created_at, read_at
             FROM agent_events WHERE agent_id = ?`;
  const params: unknown[] = [targetId];
  if (type) { sql += ` AND type = ?`; params.push(type); }
  if (unreadOnly) { sql += ` AND read_at IS NULL`; }

  if (after !== null) {
    sql += ` AND seq > ? ORDER BY seq ASC LIMIT ?`;
    params.push(after, limit);
  } else {
    sql += ` ORDER BY seq DESC LIMIT ?`;
    params.push(limit);
  }

  const rows = await db.all<EventRow>(sql, ...params);
  const maxSeq = rows.reduce((m, r) => Math.max(m, r.seq), after ?? 0);
  // `next_cursor` always advances forward (highest seq seen) so the next poll
  // with after=next_cursor returns only newer events.
  const next_cursor = rows.length ? encodeCursor(maxSeq) : (afterRaw ?? null);
  const has_more = after !== null ? rows.length === limit : false;

  const unreadRow = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM agent_events WHERE agent_id = ? AND read_at IS NULL`, targetId,
  );

  return c.json({
    ok: true,
    events: rows.map(shape),
    next_cursor,
    has_more,
    unread_count: unreadRow?.n ?? 0,
  });
});

/**
 * POST /v1/agents/:id/events/read — mark events read.
 * Body: { up_to_cursor?: string } (all events with seq <= cursor) or
 *       { ids?: string[] } (specific event ids). Idempotent.
 */
events.post('/:id/events/read', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const targetId = c.req.param('id');
  if (agentId !== targetId) {
    return c.json({ error: 'forbidden', message: 'You can only mark your own inbox read' }, 403);
  }
  const db = c.get('db');
  const now = new Date().toISOString();

  let body: { up_to_cursor?: unknown; ids?: unknown } = {};
  try { body = (await c.req.json()) as typeof body; } catch { /* empty body ok */ }

  if (typeof body.up_to_cursor === 'string') {
    const seq = decodeCursor(body.up_to_cursor);
    if (seq === null) return c.json({ error: 'bad_request', message: 'Invalid up_to_cursor' }, 400);
    const res = await db.run(
      `UPDATE agent_events SET read_at = ? WHERE agent_id = ? AND read_at IS NULL AND seq <= ?`,
      now, targetId, seq,
    );
    return c.json({ ok: true, marked: res.changes });
  }

  if (Array.isArray(body.ids) && body.ids.length > 0) {
    const ids = body.ids.filter((x): x is string => typeof x === 'string').slice(0, 200);
    if (ids.length === 0) return c.json({ error: 'bad_request', message: 'ids must be non-empty strings' }, 400);
    const placeholders = ids.map(() => '?').join(',');
    const res = await db.run(
      `UPDATE agent_events SET read_at = ? WHERE agent_id = ? AND read_at IS NULL AND id IN (${placeholders})`,
      now, targetId, ...ids,
    );
    return c.json({ ok: true, marked: res.changes });
  }

  return c.json({ error: 'bad_request', message: 'Provide up_to_cursor or ids' }, 400);
});

export default events;
