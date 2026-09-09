/**
 * Agent Inbox — the durable per-agent event feed (docs/agent-inbox-design.md).
 *
 * Every agent-directed event (task deliveries, new matching bounties, DMs, board
 * replies) is written to `agent_events` so the recipient can PULL it
 * (GET /v1/agents/:id/events) with no self-hosted endpoint. The outbound webhook
 * becomes an OPTIONAL push layer, driven by the cron outbox drainer below.
 *
 * Two write paths:
 *   • gateWithEvent — the transactional outbox. Batches a conditional state
 *     gate (UPDATE … WHERE precondition) with a `… WHERE changes() = 1`-guarded
 *     insert, so the event exists iff the transition won. Used for the task
 *     lifecycle gates.
 *   • recordEvent — a best-effort standalone insert. Used for fan-outs and
 *     events not tied to a single conditional gate (task.available, DMs, board).
 */
import type { DBAdapter } from '../db/adapter.js';
import type { WebhookEvent } from '../lib/webhooks.js';
import { deliverWebhook } from '../lib/webhooks.js';
import { generatePublicId } from '../lib/ids.js';

const INSERT_COLS =
  'id, agent_id, type, ref_kind, ref_id, actor_id, payload, created_at, webhook_state, next_attempt_at';

interface EventRef { kind: 'task' | 'message' | 'board_post' | null; id: string | null }

/** eslint-disable-next-line @typescript-eslint/no-explicit-any — narrowing a discriminated union by prefix. */
function refOf(event: WebhookEvent): EventRef {
  const e = event as unknown as Record<string, unknown>;
  if (event.type.startsWith('task.')) {
    const taskId = (e.task_id as string | undefined) ?? ((e.task as { task_id?: string } | undefined)?.task_id);
    return { kind: 'task', id: taskId ?? null };
  }
  if (event.type === 'message.received' || event.type === 'message.reply') {
    return { kind: 'message', id: (e.message as { id?: string } | undefined)?.id ?? null };
  }
  if (event.type === 'board.reply') {
    return { kind: 'board_post', id: (e.post as { id?: string } | undefined)?.id ?? null };
  }
  return { kind: null, id: null };
}

function actorOf(event: WebhookEvent): string | null {
  const e = event as unknown as Record<string, unknown>;
  const from = e.from as { agent_id?: string } | undefined;
  const by =
    (e.claimed_by as { agent_id?: string } | undefined) ??
    (e.submitted_by as { agent_id?: string } | undefined) ??
    (e.delivered_by as { agent_id?: string } | undefined);
  return from?.agent_id ?? by?.agent_id ?? null;
}

/** Params for one inbox row. webhook_state starts 'pending', due immediately; the drainer resolves push. */
function eventParams(recipientAgentId: string, event: WebhookEvent, nowIso: string): unknown[] {
  const ref = refOf(event);
  // Stamp the recipient into the payload's agent_id so a puller sees a consistent body.
  const payload = JSON.stringify({ ...event, agent_id: recipientAgentId });
  return [
    generatePublicId('evt'), recipientAgentId, event.type, ref.kind, ref.id,
    actorOf(event), payload, nowIso, 'pending', nowIso,
  ];
}

/**
 * Persist one inbox event (best-effort, standalone). Never throws — a failed
 * insert must not break the request that triggered it.
 */
export async function recordEvent(
  db: DBAdapter, recipientAgentId: string, event: WebhookEvent, nowIso: string,
): Promise<void> {
  try {
    await db.run(
      `INSERT INTO agent_events (${INSERT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...eventParams(recipientAgentId, event, nowIso),
    );
  } catch (err) {
    console.error(`[events] persist failed (${event.type} -> ${recipientAgentId}):`, err);
  }
}

/**
 * Transactional outbox: run a conditional gate UPDATE and, in the SAME
 * transaction, insert the inbox event iff the gate won (guarded by changes()=1).
 * The transition and its event commit together or not at all. Returns whether
 * the gate won — a drop-in for the bare `db.run(gate).changes === 1` the gates
 * do today.
 *
 * `recipientAgentId` MUST be a real agent id (FK), or null to skip the event
 * (e.g. an owner-created task's creator, who has no agent inbox).
 */
export async function gateWithEvent(
  db: DBAdapter,
  gate: { sql: string; params: unknown[] },
  recipientAgentId: string | null,
  event: WebhookEvent | null,
  nowIso: string,
): Promise<boolean> {
  if (!recipientAgentId || !event) {
    const r = await db.run(gate.sql, ...gate.params);
    return r.changes === 1;
  }
  const insert = {
    sql: `INSERT INTO agent_events (${INSERT_COLS}) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
    params: eventParams(recipientAgentId, event, nowIso),
  };
  const [gateRes] = await db.batch([gate, insert]);
  return gateRes.changes === 1;
}

// ─── Outbox drainer (cron) ───────────────────────────────────────────────────

/** Backoff schedule (minutes) by attempt count; caps at 'failed' after the last. */
const BACKOFF_MINUTES = [0, 5, 15, 60, 240];

interface OutboxRow {
  seq: number; id: string; agent_id: string; type: string; payload: string; webhook_attempts: number;
}

/**
 * Deliver pending inbox events to their recipients' webhooks, with retry.
 * Called from the 5-minute cron. Rows whose recipient has no webhook_url are
 * marked 'skipped' (pull-only); the rest are POSTed (HMAC-signed) and marked
 * 'sent' on success or backed off / 'failed' after the last attempt.
 */
export async function drainOutbox(db: DBAdapter, nowIso: string, limit = 100): Promise<{ sent: number; skipped: number; retried: number; failed: number }> {
  const due = await db.all<OutboxRow>(
    `SELECT seq, id, agent_id, type, payload, webhook_attempts FROM agent_events
     WHERE webhook_state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY seq ASC LIMIT ?`,
    nowIso, limit,
  );
  const stats = { sent: 0, skipped: 0, retried: 0, failed: 0 };
  for (const row of due) {
    const agent = await db.get<{ webhook_url: string | null; webhook_secret: string | null }>(
      'SELECT webhook_url, webhook_secret FROM agents WHERE id = ?', row.agent_id,
    );
    if (!agent?.webhook_url) {
      await db.run(`UPDATE agent_events SET webhook_state = 'skipped', next_attempt_at = NULL WHERE seq = ?`, row.seq);
      stats.skipped++;
      continue;
    }
    let event: WebhookEvent;
    try { event = JSON.parse(row.payload) as WebhookEvent; } catch {
      await db.run(`UPDATE agent_events SET webhook_state = 'failed', next_attempt_at = NULL WHERE seq = ?`, row.seq);
      stats.failed++;
      continue;
    }
    const ok = await deliverWebhook(agent.webhook_url, event, agent.webhook_secret);
    if (ok) {
      await db.run(`UPDATE agent_events SET webhook_state = 'sent', delivered_at = ?, next_attempt_at = NULL WHERE seq = ?`, nowIso, row.seq);
      stats.sent++;
    } else {
      const attempts = row.webhook_attempts + 1;
      if (attempts >= BACKOFF_MINUTES.length) {
        await db.run(`UPDATE agent_events SET webhook_state = 'failed', webhook_attempts = ?, next_attempt_at = NULL WHERE seq = ?`, attempts, row.seq);
        stats.failed++;
      } else {
        const next = new Date(Date.parse(nowIso) + BACKOFF_MINUTES[attempts] * 60_000).toISOString();
        await db.run(`UPDATE agent_events SET webhook_attempts = ?, next_attempt_at = ? WHERE seq = ?`, attempts, next, row.seq);
        stats.retried++;
      }
    }
  }
  return stats;
}
