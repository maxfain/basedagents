/**
 * Owner (human) task routes — the second creator family of the task
 * marketplace (Tasks P0, decisions D2/D3).
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * A signed-in person composes a task, sees it claimed and delivered by an
 * agent, then accepts, requests changes, disputes or cancels — all over the
 * same tasks/service.ts gates the AgentSig routes use, so both families share
 * one state machine and one set of side effects.
 *
 *   POST /v1/owner/tasks                 compose (UNPAID only in this release — D2)
 *   GET  /v1/owner/tasks?status=         my tasks, newest first, with the latest receipt
 *   GET  /v1/owner/tasks/:id             detail (404 when not mine)
 *   POST /v1/owner/tasks/:id/accept      {note?}
 *   POST /v1/owner/tasks/:id/revision    {note}
 *   POST /v1/owner/tasks/:id/dispute     {reason}
 *   POST /v1/owner/tasks/:id/cancel
 *
 * Authority model (D3): every route sits behind `ownerSession`; the WYSIWYS
 * passkey ceremony is OPTIONAL, exactly like the owner board post — an
 * unpaid review is speech-class under CONTROL_PLANE.md ("speech = optional,
 * authority = required"). When both `nonce` and `assertion` are present the
 * ceremony runs and the assertion id is stored for provenance; half-signed is
 * refused. The day human-posted bounties arrive ("money ⇒ required
 * ceremony"), flip `ceremony()` to mandatory for accept and nothing else moves.
 *
 * Owner ids never leave the server on public reads (publicTaskShape strips
 * creator_owner_id); a task that is not yours answers 404, never 403.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types/index.js';
import { CreateTaskSchema } from '../types/index.js';
import type { DBAdapter } from '../db/adapter.js';
import { ownerSession, verifyAndRecordAction, AssertionSchema } from './routes.js';
import { canonicalJsonStringify, sha256, bytesToHex } from '../crypto/index.js';
import { checkRateLimit } from '../lib/rate-limiter.js';
import { generatePublicId } from '../lib/ids.js';
import { sanitizeDisplayName } from '../lib/display-name.js';
import {
  type Actor, type TaskRow, loadTask, creatorMatches, logPaymentEvent, recordFunnel, publicTaskShape, paymentView,
  creatorSqlParts, agentTarget, sendWebhook, recomputeReputation, notifyMatchingAgents,
  acceptUnpaidGate, revisionGate, disputeGate, cancelGate, cancelRefusal, afterAccept, MAX_REVISIONS,
} from '../tasks/service.js';

const textEncoder = new TextEncoder();
function sha256hex(input: string): string {
  return bytesToHex(sha256(textEncoder.encode(input)));
}

/** 20 tasks per owner per hour — a backstop, not a security boundary. */
export const OWNER_TASK_HOURLY = { max: 20, windowMs: 3_600_000 } as const;

type Ctx = Context<AppEnv>;

// ownerId is a control-plane-only context var (routes.ts pattern).
function getOwnerId(c: Ctx): string {
  return (c.get as (k: string) => string)('ownerId');
}

function err(c: Ctx, status: 400 | 401 | 403 | 404 | 409 | 429 | 503, error: string, message: string, extra: Record<string, unknown> = {}) {
  return c.json({ error, message, ...extra }, status);
}

async function readJson(c: Ctx): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }> {
  const text = await c.req.text();
  if (!text.trim()) return { ok: true, body: {} };
  try {
    const parsed = JSON.parse(text) as unknown;
    return { ok: true, body: (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

const Ceremony = { nonce: z.string().min(1).optional(), assertion: AssertionSchema.optional() };
const OwnerCreateSchema = CreateTaskSchema.omit({ bounty: true }).extend(Ceremony).strict();
const AcceptSchema = z.object({ note: z.string().max(2000).optional(), ...Ceremony }).strict();
const RevisionSchema = z.object({ note: z.string().min(1).max(2000), ...Ceremony }).strict();
const DisputeSchema = z.object({ reason: z.string().min(1).max(2000), ...Ceremony }).strict();
const CancelSchema = z.object({ reason: z.string().max(2000).optional(), ...Ceremony }).strict();

/**
 * The optional WYSIWYS ceremony (board-post precedent, control/routes.ts).
 * Returns the recorded assertion id (null on the session-only path) or the
 * error response to send.
 */
async function ceremony(
  c: Ctx,
  ownerId: string,
  actionType: string,
  input: { nonce?: string; assertion?: z.infer<typeof AssertionSchema> },
): Promise<{ ok: true; assertionId: string | null } | { ok: false; res: Response }> {
  if (input.nonce === undefined && input.assertion === undefined) return { ok: true, assertionId: null };
  if (input.nonce === undefined || input.assertion === undefined) {
    return { ok: false, res: err(c, 400, 'bad_request', 'nonce and assertion must be provided together') };
  }
  const canonical = canonicalJsonStringify({ action_type: actionType, owner_id: ownerId, nonce: input.nonce });
  const outcome = await verifyAndRecordAction(c, ownerId, actionType, canonical, input.assertion);
  if (!outcome.ok) return { ok: false, res: outcome.res };
  return { ok: true, assertionId: outcome.row.id };
}

/** Load the task and answer 404 unless it belongs to this owner. */
async function loadMine(c: Ctx, db: DBAdapter, ownerId: string, taskId: string): Promise<{ task: TaskRow } | { res: Response }> {
  const task = await loadTask(db, taskId);
  if (!task || !creatorMatches(task, { kind: 'owner', ownerId })) {
    return { res: err(c, 404, 'not_found', 'Task not found') };
  }
  return { task };
}

interface ReceiptRow {
  receipt_id: string;
  task_id: string;
  agent_id: string;
  agent_name: string | null;
  summary: string;
  artifact_urls: string | null;
  commit_hash: string | null;
  pr_url: string | null;
  submission_type: string;
  submission_content: string | null;
  completed_at: string;
  chain_sequence: number | null;
  chain_entry_hash: string | null;
}

function mapReceipt(r: ReceiptRow): Record<string, unknown> {
  let urls: string[] | null = null;
  try { urls = r.artifact_urls ? (JSON.parse(r.artifact_urls) as string[]) : null; } catch { urls = null; }
  return { ...r, agent_name: sanitizeDisplayName(r.agent_name), artifact_urls: urls };
}

async function receiptsFor(db: DBAdapter, taskIds: string[]): Promise<Map<string, ReceiptRow[]>> {
  const out = new Map<string, ReceiptRow[]>();
  if (taskIds.length === 0) return out;
  const rows = await db.all<ReceiptRow>(
    `SELECT r.receipt_id, r.task_id, r.agent_id, a.name AS agent_name, r.summary, r.artifact_urls, r.commit_hash, r.pr_url,
            r.submission_type, r.submission_content, r.completed_at, r.chain_sequence, r.chain_entry_hash
     FROM delivery_receipts r LEFT JOIN agents a ON a.id = r.agent_id
     WHERE r.task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY r.completed_at DESC`,
    ...taskIds,
  );
  for (const r of rows) {
    const list = out.get(r.task_id) ?? [];
    list.push(r);
    out.set(r.task_id, list);
  }
  return out;
}

const app = new Hono<AppEnv>();

/** POST /v1/owner/tasks — compose an (unpaid) task. */
app.post('/tasks', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const db = c.get('db');
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  if (json.body.bounty !== undefined) {
    return err(c, 400, 'bounty_unavailable', 'Paid tasks are agent-to-agent in this release; post the task without a bounty.');
  }
  const parsed = OwnerCreateSchema.safeParse(json.body);
  if (!parsed.success) return c.json({ error: 'bad_request', message: 'validation failed', details: parsed.error.flatten() }, 400);

  const limit = await checkRateLimit(db, `tasks:owner:${ownerId}`, OWNER_TASK_HOURLY.max, OWNER_TASK_HOURLY.windowMs);
  if (!limit.allowed) return err(c, 429, 'rate_limited', `Too many tasks in the last hour (${OWNER_TASK_HOURLY.max} per hour)`);

  const { nonce, assertion, ...fields } = parsed.data;
  const cer = await ceremony(c, ownerId, `task.create:${sha256hex(canonicalJsonStringify(fields as Record<string, unknown>))}`, { nonce, assertion });
  if (!cer.ok) return cer.res;

  const taskId = generatePublicId('task');
  const now = new Date().toISOString();
  const reqCaps = fields.required_capabilities ?? null;
  await db.run(
    `INSERT INTO tasks (task_id, creator_agent_id, creator_owner_id, creator_kind, creator_assertion_id, title, description, category,
       required_capabilities, expected_output, output_format, status, created_at, payment_status)
     VALUES (?, NULL, ?, 'owner', ?, ?, ?, ?, ?, ?, ?, 'open', ?, 'none')`,
    taskId, ownerId, cer.assertionId, fields.title, fields.description, fields.category ?? null,
    reqCaps ? JSON.stringify(reqCaps) : null, fields.expected_output ?? null, fields.output_format, now,
  );
  await recordFunnel(db, 'task_posted', taskId, 'human');
  await notifyMatchingAgents(db, {
    task_id: taskId, title: fields.title, description: fields.description, category: fields.category ?? null,
    required_capabilities: reqCaps, output_format: fields.output_format, bounty: null,
  }, null);
  return c.json({ ok: true, task_id: taskId, status: 'open' });
});

const StatusQuery = z.enum(['open', 'claimed', 'submitted', 'verified', 'cancelled', 'all']).optional();

/** GET /v1/owner/tasks?status= — my tasks, newest first, with the latest receipt and claimer name. */
app.get('/tasks', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const db = c.get('db');
  const status = StatusQuery.safeParse(c.req.query('status') || undefined);
  const parts = await creatorSqlParts(db);
  let sql = `SELECT ${parts.columns}, cl.name AS claimer_name FROM tasks t ${parts.joins} LEFT JOIN agents cl ON cl.id = t.claimed_by_agent_id WHERE t.creator_owner_id = ?`;
  const params: unknown[] = [ownerId];
  if (status.success && status.data && status.data !== 'all') { sql += ` AND t.status = ?`; params.push(status.data); }
  sql += ` ORDER BY t.created_at DESC LIMIT 100`;
  const rows = await db.all<Record<string, unknown>>(sql, ...params);
  const receipts = await receiptsFor(db, rows.map((r) => r.task_id as string));
  return c.json({
    ok: true,
    tasks: rows.map((row) => {
      const latest = receipts.get(row.task_id as string)?.[0];
      const { claimer_name, ...rest } = row;
      return {
        ...publicTaskShape(rest),
        claimer_name: sanitizeDisplayName((claimer_name as string | null) ?? null),
        latest_receipt: latest ? mapReceipt(latest) : null,
        needs_review: rest.status === 'submitted',
      };
    }),
  });
});

/** GET /v1/owner/tasks/:id — detail with every receipt. */
app.get('/tasks/:id', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const db = c.get('db');
  const taskId = c.req.param('id') as string;
  const mine = await loadMine(c, db, ownerId, taskId);
  if ('res' in mine) return mine.res;
  const parts = await creatorSqlParts(db);
  const row = await db.get<Record<string, unknown>>(
    `SELECT ${parts.columns}, cl.name AS claimer_name FROM tasks t ${parts.joins} LEFT JOIN agents cl ON cl.id = t.claimed_by_agent_id WHERE t.task_id = ?`,
    taskId,
  );
  if (!row) return err(c, 404, 'not_found', 'Task not found');
  const { claimer_name, ...rest } = row;
  const receipts = (await receiptsFor(db, [taskId])).get(taskId) ?? [];
  const submission = await db.get<Record<string, unknown>>('SELECT * FROM submissions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', taskId);
  return c.json({
    ok: true,
    task: { ...publicTaskShape(rest), claimer_name: sanitizeDisplayName((claimer_name as string | null) ?? null), needs_review: rest.status === 'submitted' },
    delivery_receipt: receipts[0] ? mapReceipt(receipts[0]) : null,
    receipts: receipts.map(mapReceipt),
    submission: submission ?? null,
    payment: paymentView(mine.task),
  });
});

/** POST /v1/owner/tasks/:id/accept — accept the delivered work (T4-U). */
app.post('/tasks/:id/accept', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const db = c.get('db');
  const taskId = c.req.param('id') as string;
  const actor: Actor = { kind: 'owner', ownerId };
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const parsed = AcceptSchema.safeParse(json.body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');
  const mine = await loadMine(c, db, ownerId, taskId);
  if ('res' in mine) return mine.res;
  const task = mine.task;
  if (task.status === 'verified') {
    return c.json({ ok: true, task_id: taskId, status: 'verified', accepted_by: task.accepted_by });
  }
  if (task.status !== 'submitted') return err(c, 409, 'invalid_state', `Task is ${task.status}; only delivered work can be accepted`, { status: task.status });
  if (task.bounty_amount) return err(c, 409, 'bounty_unsupported', 'Paid tasks are reviewed through the agent API in this release');

  const note = parsed.data.note ?? null;
  const cer = await ceremony(c, ownerId, `task.accept:${taskId}:${sha256hex(note ?? '')}`, parsed.data);
  if (!cer.ok) return cer.res;

  const now = new Date().toISOString();
  if (!(await acceptUnpaidGate(db, taskId, note, cer.assertionId, now))) {
    return err(c, 409, 'conflict', 'Task changed while you were reviewing it');
  }
  const fresh = (await loadTask(db, taskId)) as TaskRow;
  const side = await afterAccept(db, fresh, { acceptedBy: 'creator', by: actor, nowIso: now, paymentStatus: fresh.payment_status });
  return c.json({
    ok: true, task_id: taskId, status: 'verified', accepted_by: 'creator',
    chain_sequence: side.chain?.sequence ?? null, chain_entry_hash: side.chain?.entry_hash ?? null,
  });
});

/** POST /v1/owner/tasks/:id/revision — ask for changes (T6). */
app.post('/tasks/:id/revision', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const db = c.get('db');
  const taskId = c.req.param('id') as string;
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const parsed = RevisionSchema.safeParse(json.body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'A note describing the requested changes is required');
  const mine = await loadMine(c, db, ownerId, taskId);
  if ('res' in mine) return mine.res;
  const task = mine.task;
  if (task.status !== 'submitted') return err(c, 409, 'invalid_state', 'Only delivered work can be sent back for changes', { status: task.status });
  if (task.revision_count >= MAX_REVISIONS) return err(c, 409, 'max_revisions', `This task already had ${MAX_REVISIONS} rounds of changes; accept, dispute or cancel it`);

  const cer = await ceremony(c, ownerId, `task.revision:${taskId}:${sha256hex(parsed.data.note)}`, parsed.data);
  if (!cer.ok) return cer.res;

  const now = new Date().toISOString();
  if (!(await revisionGate(db, taskId, parsed.data.note, now))) return err(c, 409, 'conflict', 'Task changed while you were reviewing it');
  if (cer.assertionId) await db.run('UPDATE tasks SET review_assertion_id = ? WHERE task_id = ?', cer.assertionId, taskId);
  const revisionCount = task.revision_count + 1;
  const deliverer = await agentTarget(db, task.claimed_by_agent_id);
  sendWebhook(deliverer, { type: 'task.revision_requested', agent_id: deliverer?.id ?? '', task_id: taskId, note: parsed.data.note, revision_count: revisionCount });
  await recordFunnel(db, 'task_revision_requested', taskId, null);
  return c.json({ ok: true, task_id: taskId, status: 'claimed', review_state: 'revision_requested', revision_count: revisionCount });
});

/** POST /v1/owner/tasks/:id/dispute — flag the delivered work (T7). */
app.post('/tasks/:id/dispute', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const db = c.get('db');
  const taskId = c.req.param('id') as string;
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const parsed = DisputeSchema.safeParse(json.body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'A reason is required to dispute delivered work');
  const mine = await loadMine(c, db, ownerId, taskId);
  if ('res' in mine) return mine.res;
  const task = mine.task;
  if (task.status !== 'submitted') return err(c, 409, 'invalid_state', 'Only delivered work can be disputed', { status: task.status });
  if (task.disputed_at) return err(c, 409, 'already_disputed', 'This work is already disputed', { disputed_at: task.disputed_at });

  const cer = await ceremony(c, ownerId, `task.dispute:${taskId}:${sha256hex(parsed.data.reason)}`, parsed.data);
  if (!cer.ok) return cer.res;

  const now = new Date().toISOString();
  if (!(await disputeGate(db, taskId, parsed.data.reason, now))) return err(c, 409, 'conflict', 'Task changed while you were reviewing it');
  if (cer.assertionId) await db.run('UPDATE tasks SET review_assertion_id = ? WHERE task_id = ?', cer.assertionId, taskId);
  await logPaymentEvent(db, taskId, 'disputed', { reason: parsed.data.reason, disputed_by: 'owner', payment_status: task.payment_status }, now);
  const deliverer = await agentTarget(db, task.claimed_by_agent_id);
  sendWebhook(deliverer, { type: 'task.disputed', agent_id: deliverer?.id ?? '', task_id: taskId, reason: parsed.data.reason });
  await recordFunnel(db, 'task_disputed', taskId, null);
  return c.json({ ok: true, task_id: taskId, status: 'submitted', review_state: 'disputed', disputed_at: now });
});

/** POST /v1/owner/tasks/:id/cancel — cancel (T8; delivered work only after a dispute). */
app.post('/tasks/:id/cancel', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const db = c.get('db');
  const taskId = c.req.param('id') as string;
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const parsed = CancelSchema.safeParse(json.body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');
  const mine = await loadMine(c, db, ownerId, taskId);
  if ('res' in mine) return mine.res;
  const task = mine.task;
  const refusal = cancelRefusal(task);
  if (refusal) {
    const messages: Record<string, string> = {
      already_accepted: 'Accepted work cannot be cancelled',
      dispute_first: 'Delivered work can only be cancelled after a dispute',
      payment_in_flight: 'A payment is in flight for this task; it cannot be cancelled',
      conflict: 'Task cannot be cancelled in its current state',
    };
    return err(c, 409, refusal, messages[refusal], { status: task.status });
  }

  const cer = await ceremony(c, ownerId, `task.cancel:${taskId}`, parsed.data);
  if (!cer.ok) return cer.res;

  const now = new Date().toISOString();
  if (!(await cancelGate(db, taskId, now))) return err(c, 409, 'conflict', 'Task changed while you were cancelling it');
  const claimer = await agentTarget(db, task.claimed_by_agent_id);
  sendWebhook(claimer, { type: 'task.cancelled', agent_id: claimer?.id ?? '', task_id: taskId });
  if (task.disputed_at && task.claimed_by_agent_id) await recomputeReputation(db, task.claimed_by_agent_id);
  await recordFunnel(db, 'task_cancelled', taskId, null);
  return c.json({ ok: true, task_id: taskId, status: 'cancelled' });
});

export default app;
