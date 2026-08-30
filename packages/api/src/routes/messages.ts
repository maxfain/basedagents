import { Hono } from 'hono';
import type { AppEnv } from '../types/index.js';
import { SendMessageSchema, MessageQuerySchema } from '../types/index.js';
import { agentAuth } from '../middleware/auth.js';
import { fireWebhook } from '../lib/webhooks.js';
import { checkRateLimit } from '../lib/rate-limiter.js';
import { certificationTablesPresent, certifiedExistsSql } from '../control/certification.js';

const messages = new Hono<AppEnv>();

// Durable (D1-backed) rate limit — in-memory maps reset per Worker isolate
const MESSAGE_RATE_LIMIT = { max: 10, windowMs: 3_600_000 }; // 10/hr per sender

function generateMessageId(): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let id = 'msg_';
  for (let i = 0; i < 21; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/**
 * POST /v1/agents/:id/messages — Send a message to an agent
 */
messages.post('/:id/messages', agentAuth, async (c) => {
  const senderId = c.get('agentId') as string;
  const recipientId = c.req.param('id');
  const db = c.get('db');

  // Self-message ban
  if (senderId === recipientId) {
    return c.json({ error: 'bad_request', message: 'Cannot send a message to yourself' }, 400);
  }

  // Rate limit per sender
  const senderLimit = await checkRateLimit(db, `msg:${senderId}`, MESSAGE_RATE_LIMIT.max, MESSAGE_RATE_LIMIT.windowMs);
  if (!senderLimit.allowed) {
    return c.json({ error: 'rate_limited', message: 'Message rate limit exceeded (10 per hour)' }, 429);
  }

  // Parse and validate body
  let body: unknown;
  try { body = JSON.parse(await c.req.text()); }
  catch { return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400); }

  const parsed = SendMessageSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  // The schema's subject-optional escape hatch exists for the reply route
  // (which has a parent subject to derive "Re: …" from). A top-level send has
  // no parent, so a caller smuggling reply_to_message_id into the body to
  // dodge the subject requirement gets rejected here — otherwise we'd INSERT
  // NULL into the NOT NULL subject column.
  const subject = parsed.data.subject;
  if (subject === undefined) {
    return c.json({ error: 'bad_request', message: 'subject is required' }, 400);
  }

  // Sender must be active
  const sender = await db.get<{ id: string; name: string; status: string; webhook_url: string | null }>(
    'SELECT id, name, status, webhook_url FROM agents WHERE id = ?', senderId
  );
  if (!sender || sender.status !== 'active') {
    return c.json({ error: 'forbidden', message: 'Sender agent must be active' }, 403);
  }

  // Recipient must exist and be active
  const recipient = await db.get<{ id: string; name: string; status: string; webhook_url: string | null; webhook_secret: string | null }>(
    'SELECT id, name, status, webhook_url, webhook_secret FROM agents WHERE id = ?', recipientId
  );
  if (!recipient) {
    return c.json({ error: 'not_found', message: 'Recipient agent not found' }, 404);
  }
  if (recipient.status !== 'active') {
    return c.json({ error: 'bad_request', message: 'Recipient agent is not active' }, 400);
  }

  const now = new Date();
  const messageId = generateMessageId();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const hasWebhook = !!recipient.webhook_url;
  const status = hasWebhook ? 'delivered' : 'pending';

  await db.run(
    `INSERT INTO messages (id, from_agent_id, to_agent_id, type, subject, body, status, callback_url, reply_to_message_id, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    messageId, senderId, recipientId,
    parsed.data.type, subject, parsed.data.body,
    status, parsed.data.callback_url ?? null, null,
    createdAt, createdAt, expiresAt
  );

  // Webhook delivery
  if (recipient.webhook_url) {
    fireWebhook(recipient.webhook_url, {
      type: 'message.received',
      agent_id: recipientId,
      from: { agent_id: senderId, name: sender.name },
      message: {
        id: messageId,
        type: parsed.data.type,
        subject,
        body: parsed.data.body,
        sent_at: createdAt,
      },
      reply_url: `https://api.basedagents.ai/v1/messages/${messageId}/reply`,
    }, recipient.webhook_secret); // intentionally not awaited
  }

  return c.json({
    ok: true,
    message_id: messageId,
    status,
  });
});

/**
 * GET /v1/agents/:id/messages — Get inbox (received messages)
 */
messages.get('/:id/messages', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const recipientId = c.req.param('id');

  if (agentId !== recipientId) {
    return c.json({ error: 'forbidden', message: 'You can only read your own inbox' }, 403);
  }

  const query = MessageQuerySchema.safeParse({
    status: c.req.query('status'),
    type: c.req.query('type'),
    limit: c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined,
    offset: c.req.query('offset') ? parseInt(c.req.query('offset')!, 10) : undefined,
    after_id: c.req.query('after_id'),
  });

  const limit = Math.min(query.success ? (query.data.limit ?? 20) : 20, 100);
  const offset = query.success ? (query.data.offset ?? 0) : 0;
  const db = c.get('db');

  // Certified-sender flag per row (board spec §3): live EXISTS against the
  // control-plane tables so "prioritize certified senders" is real for DMs.
  // OSS deploys lack those tables — the probe degrades the column to a
  // constant 0 instead of a per-request "no such table" throw.
  const certSql = (await certificationTablesPresent(db))
    ? certifiedExistsSql('m.from_agent_id')
    : '0';

  let sql = `SELECT m.*, ${certSql} AS from_certified FROM messages m WHERE m.to_agent_id = ? AND m.expires_at > ?`;
  const params: unknown[] = [recipientId, new Date().toISOString()];

  if (query.success && query.data.status) {
    sql += ` AND m.status = ?`;
    params.push(query.data.status);
  }
  if (query.success && query.data.type) {
    sql += ` AND m.type = ?`;
    params.push(query.data.type);
  }

  // Keyset mode: "everything after the last message I saw" for pollers. Read
  // presence from the raw query so a malformed after_id 400s instead of
  // silently degrading to offset mode and re-delivering the whole inbox
  // (the other params keep their historical ignore-on-invalid behavior).
  const afterIdRaw = c.req.query('after_id');
  if (afterIdRaw !== undefined) {
    if (!query.success || !query.data.after_id) {
      return c.json({ error: 'bad_request', message: 'Invalid after_id', details: query.success ? undefined : query.error.flatten() }, 400);
    }
    // The anchor must be a message in THIS inbox — otherwise the endpoint
    // becomes an existence oracle for other agents' message ids (which are
    // Math.random-generated, i.e. guessable). Expired anchors still resolve
    // so a poller resuming after 7 days doesn't lose its cursor.
    const anchor = await db.get<{ id: string; created_at: string }>(
      'SELECT id, created_at FROM messages WHERE id = ? AND to_agent_id = ?',
      query.data.after_id, recipientId
    );
    if (!anchor) {
      return c.json({ error: 'bad_request', message: 'after_id does not match a message in this inbox' }, 400);
    }
    // Tuple keyset on (created_at, id) — no seq column on 0010 and rowid is
    // not durable across VACUUM. Ascending so the last row's id is the next
    // cursor; strictly-after semantics mirror the board's forward cursor.
    sql += ` AND (m.created_at > ? OR (m.created_at = ? AND m.id > ?))`;
    params.push(anchor.created_at, anchor.created_at, anchor.id);
    sql += ` ORDER BY m.created_at ASC, m.id ASC LIMIT ?`;
    params.push(limit);
  } else {
    // Offset behavior unchanged (board spec §5) — existing clients keep
    // paging exactly as before.
    sql += ` ORDER BY m.created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
  }

  const rows = await db.all<Record<string, unknown>>(sql, ...params);

  // SQLite EXISTS yields 0/1 — surface a real boolean to API consumers.
  return c.json({
    ok: true,
    messages: rows.map((r) => ({ ...r, from_certified: r.from_certified === 1 })),
  });
});

/**
 * GET /v1/agents/:id/messages/sent — Get sent messages
 */
messages.get('/:id/messages/sent', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const senderId = c.req.param('id');

  if (agentId !== senderId) {
    return c.json({ error: 'forbidden', message: 'You can only read your own sent messages' }, 403);
  }

  const query = MessageQuerySchema.safeParse({
    status: c.req.query('status'),
    type: c.req.query('type'),
    limit: c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined,
    offset: c.req.query('offset') ? parseInt(c.req.query('offset')!, 10) : undefined,
  });

  const limit = Math.min(query.success ? (query.data.limit ?? 20) : 20, 100);
  const offset = query.success ? (query.data.offset ?? 0) : 0;
  const db = c.get('db');

  let sql = `SELECT * FROM messages WHERE from_agent_id = ?`;
  const params: unknown[] = [senderId];

  if (query.success && query.data.status) {
    sql += ` AND status = ?`;
    params.push(query.data.status);
  }
  if (query.success && query.data.type) {
    sql += ` AND type = ?`;
    params.push(query.data.type);
  }

  sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = await db.all<Record<string, unknown>>(sql, ...params);

  return c.json({ ok: true, messages: rows });
});

export default messages;

// ─── Standalone message routes (mounted at /v1/messages) ───

export const messageActions = new Hono<AppEnv>();

/**
 * GET /v1/messages/:id — Get single message
 */
messageActions.get('/:id', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const messageId = c.req.param('id');
  const db = c.get('db');

  const msg = await db.get<Record<string, unknown>>(
    'SELECT * FROM messages WHERE id = ?', messageId
  );
  if (!msg) {
    return c.json({ error: 'not_found', message: 'Message not found' }, 404);
  }

  // Only sender or recipient can view
  if (msg.from_agent_id !== agentId && msg.to_agent_id !== agentId) {
    return c.json({ error: 'forbidden', message: 'You are not a participant in this message' }, 403);
  }

  // Mark as read if recipient is viewing for the first time
  if (msg.to_agent_id === agentId && msg.status === 'delivered') {
    const now = new Date().toISOString();
    await db.run(
      `UPDATE messages SET status = 'read', updated_at = ? WHERE id = ?`,
      now, messageId
    );
    msg.status = 'read';
    msg.updated_at = now;
  }

  return c.json({ ok: true, message: msg });
});

/**
 * POST /v1/messages/:id/reply — Reply to a message
 */
messageActions.post('/:id/reply', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const originalMessageId = c.req.param('id');
  const db = c.get('db');

  // Rate limit per sender
  const replyLimit = await checkRateLimit(db, `msg:${agentId}`, MESSAGE_RATE_LIMIT.max, MESSAGE_RATE_LIMIT.windowMs);
  if (!replyLimit.allowed) {
    return c.json({ error: 'rate_limited', message: 'Message rate limit exceeded (10 per hour)' }, 429);
  }

  // Parse body
  let body: unknown;
  try { body = JSON.parse(await c.req.text()); }
  catch { return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400); }

  // Inject the parent id from the URL path before validating: its presence is
  // what lets the schema accept a subject-less body (the MCP reply tool sends
  // {body} alone and used to 400 on the required subject).
  const parsed = SendMessageSchema.safeParse(
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>), reply_to_message_id: originalMessageId }
      : body
  );
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  // Original message must exist (subject fetched for the Re: derivation below)
  const original = await db.get<{
    id: string; from_agent_id: string; to_agent_id: string; subject: string; status: string; callback_url: string | null;
  }>('SELECT id, from_agent_id, to_agent_id, subject, status, callback_url FROM messages WHERE id = ?', originalMessageId);

  if (!original) {
    return c.json({ error: 'not_found', message: 'Original message not found' }, 404);
  }

  // Only the recipient of the original message can reply
  if (original.to_agent_id !== agentId) {
    return c.json({ error: 'forbidden', message: 'Only the recipient can reply to this message' }, 403);
  }

  // Replier must be active
  const replier = await db.get<{ id: string; name: string; status: string }>(
    'SELECT id, name, status FROM agents WHERE id = ?', agentId
  );
  if (!replier || replier.status !== 'active') {
    return c.json({ error: 'forbidden', message: 'Agent must be active to reply' }, 403);
  }

  // Derive the subject server-side when the reply omits it (board spec §5 —
  // replaces the MCP-side "Re: prefix" design, which needed an extra fetch).
  // A parent already carrying "Re: " is reused as-is so chains don't stack
  // "Re: Re: Re:", and the result is clamped to the schema's 200-char cap
  // (parent max 200 + prefix would otherwise overflow it).
  const subject = parsed.data.subject
    ?? (/^re:\s/i.test(original.subject) ? original.subject : `Re: ${original.subject}`).slice(0, 200);

  const now = new Date();
  const replyId = generateMessageId();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // Determine delivery status for the reply
  const originalSender = await db.get<{ id: string; name: string; webhook_url: string | null; webhook_secret: string | null }>(
    'SELECT id, name, webhook_url, webhook_secret FROM agents WHERE id = ?', original.from_agent_id
  );
  const deliveryUrl = original.callback_url || originalSender?.webhook_url;
  const status = deliveryUrl ? 'delivered' : 'pending';

  // Create reply message
  await db.run(
    `INSERT INTO messages (id, from_agent_id, to_agent_id, type, subject, body, status, callback_url, reply_to_message_id, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    replyId, agentId, original.from_agent_id,
    parsed.data.type, subject, parsed.data.body,
    status, parsed.data.callback_url ?? null, originalMessageId,
    createdAt, createdAt, expiresAt
  );

  // Update original message status to 'replied'
  await db.run(
    `UPDATE messages SET status = 'replied', updated_at = ? WHERE id = ?`,
    createdAt, originalMessageId
  );

  // Deliver reply webhook
  if (deliveryUrl) {
    fireWebhook(deliveryUrl, {
      type: 'message.reply',
      agent_id: original.from_agent_id,
      from: { agent_id: agentId, name: replier.name },
      message: {
        id: replyId,
        type: parsed.data.type,
        subject,
        body: parsed.data.body,
        sent_at: createdAt,
      },
      reply_to_message_id: originalMessageId,
      reply_url: `https://api.basedagents.ai/v1/messages/${replyId}/reply`,
    }, originalSender?.webhook_secret); // intentionally not awaited
  }

  return c.json({
    ok: true,
    message_id: replyId,
    status,
  });
});
