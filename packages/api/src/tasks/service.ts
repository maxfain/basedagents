/**
 * Task lifecycle service — the ONE place every task state transition lives.
 *
 * Rules (CONTROL_PLANE.md "single atomic conditional writes"):
 *   * A transition is ONE `UPDATE … WHERE status = <expected>` whose
 *     `changes === 1` is the gate. The SELECT a route does beforehand only
 *     serves 404/403 and webhook targets — it is NEVER the gate. Two callers
 *     racing for the same transition get exactly one winner (D1 has no
 *     transactions, so this is the only concurrency primitive we have).
 *   * Side effects (chain entries, webhooks, reputation, funnel) run only
 *     after the gate reports a win, and are best-effort: a webhook that fails
 *     never rolls back a state change that already committed.
 *   * `tasks.status` is written ONLY by the T-transitions below; the payment
 *     side (`payment_status`, see payments/settle.ts) never writes `status`.
 *
 * Two creator families share this file: agent creators (AgentSig routes in
 * routes/tasks.ts) and human owners (cookie-session routes in control/). The
 * `Actor` discriminant carries which one is acting; `creatorMatches` is the
 * single authorization predicate both route families use.
 */
import type { DBAdapter } from '../db/adapter.js';
import type { PaymentStatus, TaskStatus } from '../types/index.js';
import { computeChainHash, GENESIS_HASH, sha256, bytesToHex, canonicalJsonStringify } from '../crypto/index.js';
import { fireWebhook, type WebhookEvent } from '../lib/webhooks.js';
import { computeReputation } from '../reputation/calculator.js';
import { generatePublicId } from '../lib/ids.js';
import { atomicToDisplay } from '../payments/x402.js';

export type Actor = { kind: 'agent'; agentId: string } | { kind: 'owner'; ownerId: string };

/** The tasks row after migration 0035. */
export interface TaskRow {
  task_id: string;
  creator_agent_id: string | null;
  creator_owner_id: string | null;
  creator_kind: 'agent' | 'owner';
  creator_assertion_id: string | null;
  claimed_by_agent_id: string | null;
  title: string;
  description: string;
  category: string | null;
  required_capabilities: string | null;
  expected_output: string | null;
  output_format: string;
  status: TaskStatus;
  created_at: string;
  claimed_at: string | null;
  submitted_at: string | null;
  verified_at: string | null;
  accepted_by: 'creator' | 'auto' | null;
  review_note: string | null;
  review_assertion_id: string | null;
  revision_count: number;
  revision_requested_at: string | null;
  disputed_at: string | null;
  cancelled_at: string | null;
  proposer_signature: string | null;
  acceptor_signature: string | null;
  bounty_amount: string | null;
  bounty_token: string | null;
  bounty_network: string | null;
  payment_status: PaymentStatus;
  payment_signature: string | null;
  payment_requirements: string | null;
  payment_payer: string | null;
  payment_nonce: string | null;
  payment_verified: number;
  payment_settled: number;
  payment_tx_hash: string | null;
  payment_expires_at: string | null;
  auto_release_at: string | null;
  settle_attempts: number;
  settle_broadcast: number;
  settle_started_at: string | null;
  settle_next_at: string | null;
  settled_at: string | null;
  last_settle_error: string | null;
  /** Structured outcome class of the last settle attempt (payments/settle.ts SettleClass); the re-auth guard reads THIS, never the free-text error. */
  last_settle_class: string | null;
}

/** Buyer review window: a delivered task is auto-accepted after this long (N3). */
export const REVIEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Max "request changes" rounds per task (D4). */
export const MAX_REVISIONS = 3;

/** Columns that never leave the server (encrypted payload, facilitator bookkeeping, owner ids). */
const PRIVATE_COLUMNS = new Set([
  'payment_signature', 'payment_requirements', 'payment_payer', 'payment_nonce', 'creator_owner_id',
  'creator_assertion_id', 'review_assertion_id',
  'settle_attempts', 'settle_broadcast', 'settle_started_at', 'settle_next_at',
]);

export function isoPlus(nowIso: string, ms: number): string {
  return new Date(Date.parse(nowIso) + ms).toISOString();
}

export async function loadTask(db: DBAdapter, taskId: string): Promise<TaskRow | null> {
  return db.get<TaskRow>('SELECT * FROM tasks WHERE task_id = ?', taskId);
}

/** The single creator-authorization predicate for both route families. */
export function creatorMatches(
  task: Pick<TaskRow, 'creator_kind' | 'creator_agent_id' | 'creator_owner_id'>,
  actor: Actor,
): boolean {
  if (actor.kind === 'agent') return task.creator_kind === 'agent' && task.creator_agent_id === actor.agentId;
  return task.creator_kind === 'owner' && task.creator_owner_id === actor.ownerId;
}

export function actorId(actor: Actor): string {
  return actor.kind === 'agent' ? actor.agentId : actor.ownerId;
}

// ─── Audit / telemetry ───

export async function logPaymentEvent(
  db: DBAdapter,
  taskId: string,
  eventType: string,
  details?: Record<string, unknown>,
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  await db.run(
    `INSERT INTO payment_events (id, task_id, event_type, details, created_at) VALUES (?, ?, ?, ?, ?)`,
    generatePublicId('pev'), taskId, eventType, details ? JSON.stringify(details) : null, nowIso,
  );
}

/**
 * Server-side funnel emission (N10). Telemetry never fails a route, and an
 * OSS deploy may not have applied 0028 — hence the swallow.
 */
export async function recordFunnel(db: DBAdapter, event: string, funnelId?: string | null, provider?: string | null): Promise<void> {
  try {
    await db.run('INSERT INTO funnel_events (event, funnel_id, provider) VALUES (?, ?, ?)', event, funnelId ?? null, provider ?? null);
  } catch {
    // telemetry only
  }
}

// ─── Chain ───

function toBytes(pk: unknown): Uint8Array {
  return pk instanceof Uint8Array ? pk : new Uint8Array(Object.values(pk as Record<string, number>));
}

export function hashCanonical(obj: Record<string, unknown>): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJsonStringify(obj))));
}

/**
 * Append a task event to the registry chain, attributed to `agentId`'s key.
 * Retries ×3 on a primary-key collision (two writers computed the same next
 * sequence), re-reading `previous_hash` and the sequence each attempt so the
 * hash link stays intact (N5).
 */
export async function taskChainEntry(
  db: DBAdapter,
  agentId: string,
  entryType: string,
  dataHash: string,
): Promise<{ sequence: number; entry_hash: string }> {
  const agent = await db.get<{ public_key: unknown }>('SELECT public_key FROM agents WHERE id = ?', agentId);
  if (!agent) throw new Error(`chain: agent ${agentId} not found`);
  const pub = toBytes(agent.public_key);
  let lastErr: unknown = new Error('chain: no attempt made');
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await db.get<{ sequence: number; entry_hash: string }>(
      'SELECT sequence, entry_hash FROM chain ORDER BY sequence DESC LIMIT 1',
    );
    const previousHash = latest?.entry_hash ?? GENESIS_HASH;
    const nextSeq = (latest?.sequence ?? -1) + 1;
    const now = new Date().toISOString();
    const entryHash = computeChainHash(previousHash, pub, '', dataHash, now);
    try {
      await db.run(
        `INSERT INTO chain (sequence, entry_hash, previous_hash, agent_id, public_key, nonce, profile_hash, timestamp, entry_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        nextSeq, entryHash, previousHash, agentId, pub, '', dataHash, now, entryType,
      );
      return { sequence: nextSeq, entry_hash: entryHash };
    } catch (err) {
      lastErr = err; // PK collision — another writer won this sequence; re-read and retry
    }
  }
  throw lastErr;
}

// ─── Webhooks ───

export interface WebhookTarget { id: string; name: string; webhook_url: string | null; webhook_secret: string | null }

export async function agentTarget(db: DBAdapter, agentId: string | null | undefined): Promise<WebhookTarget | null> {
  if (!agentId) return null;
  return db.get<WebhookTarget>('SELECT id, name, webhook_url, webhook_secret FROM agents WHERE id = ?', agentId);
}

/** Fire-and-forget; `fireWebhook` never throws. Human creators have no webhook. */
export function sendWebhook(target: WebhookTarget | null, event: WebhookEvent): void {
  if (target?.webhook_url) void fireWebhook(target.webhook_url, event, target.webhook_secret);
}

/** Webhook target for the creator — only agent creators can receive one. */
export async function creatorTarget(db: DBAdapter, task: Pick<TaskRow, 'creator_kind' | 'creator_agent_id'>): Promise<WebhookTarget | null> {
  return task.creator_kind === 'agent' ? agentTarget(db, task.creator_agent_id) : null;
}

export async function recomputeReputation(db: DBAdapter, agentId: string | null | undefined): Promise<void> {
  if (!agentId) return;
  try {
    const rep = await computeReputation(agentId, db);
    await db.run('UPDATE agents SET reputation_score = ? WHERE id = ?', rep.final_score, agentId);
  } catch {
    // best-effort
  }
}

// ─── Read shapes (N13) ───

export interface BountyView { amount_atomic: string; amount_display: string; token: string; network: string }

export function bountyView(t: Pick<TaskRow, 'bounty_amount' | 'bounty_token' | 'bounty_network'>): BountyView | null {
  if (!t.bounty_amount) return null;
  return {
    amount_atomic: t.bounty_amount,
    amount_display: /^[0-9]+$/.test(t.bounty_amount) ? atomicToDisplay(t.bounty_amount) : t.bounty_amount,
    token: t.bounty_token ?? 'USDC',
    network: t.bounty_network ?? 'eip155:8453',
  };
}

export function reviewState(t: Pick<TaskRow, 'status' | 'revision_requested_at' | 'disputed_at'>): 'revision_requested' | 'disputed' | null {
  if (t.status === 'claimed' && t.revision_requested_at) return 'revision_requested';
  if (t.status === 'submitted' && t.disputed_at) return 'disputed';
  return null;
}

export function paymentDue(t: Pick<TaskRow, 'status' | 'payment_status' | 'bounty_amount'>): boolean {
  return !!t.bounty_amount && t.status === 'verified' && ['pending', 'failed', 'expired'].includes(t.payment_status);
}

/** The public shape of a task row: internals stripped, derived fields added. */
export function publicTaskShape(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!PRIVATE_COLUMNS.has(k)) out[k] = v;
  }
  const t = row as unknown as TaskRow;
  out.required_capabilities = t.required_capabilities ? JSON.parse(t.required_capabilities) : null;
  out.creator = { kind: t.creator_kind ?? 'agent', id: t.creator_kind === 'owner' ? null : t.creator_agent_id };
  out.bounty = bountyView(t);
  out.review_state = reviewState(t);
  out.payment_due = paymentDue(t);
  return out;
}

export function paymentView(t: TaskRow): Record<string, unknown> {
  return {
    task_id: t.task_id,
    bounty: bountyView(t),
    status: t.payment_status,
    verified: !!t.payment_verified,
    settled: !!t.payment_settled,
    tx_hash: t.payment_tx_hash,
    settled_at: t.settled_at,
    expires_at: t.payment_expires_at,
    auto_release_at: t.auto_release_at,
    accepted_by: t.accepted_by,
    payer: t.payment_payer,
    last_error: t.last_settle_error,
    settle_attempts: t.settle_attempts,
    next_settle_at: t.settle_next_at,
    payment_due: paymentDue(t),
  };
}

// ─── Gates (one conditional UPDATE each) ───

/** T2: open → claimed. The creator can never claim their own task. */
export async function claimGate(db: DBAdapter, taskId: string, agentId: string, acceptorSig: string | null, nowIso: string): Promise<boolean> {
  const res = await db.run(
    `UPDATE tasks SET claimed_by_agent_id = ?, status = 'claimed', claimed_at = ?, acceptor_signature = ?
     WHERE task_id = ? AND status = 'open' AND claimed_by_agent_id IS NULL
       AND (creator_agent_id IS NULL OR creator_agent_id <> ?)`,
    agentId, nowIso, acceptorSig, taskId, agentId,
  );
  return res.changes === 1;
}

/** T3: claimed → submitted, arming the 7-day auto-accept for every task (N3). */
export async function deliverGate(db: DBAdapter, taskId: string, agentId: string, nowIso: string): Promise<boolean> {
  const res = await db.run(
    `UPDATE tasks SET status = 'submitted', submitted_at = ?, auto_release_at = ?
     WHERE task_id = ? AND status = 'claimed' AND claimed_by_agent_id = ?`,
    nowIso, isoPlus(nowIso, REVIEW_WINDOW_MS), taskId, agentId,
  );
  return res.changes === 1;
}

/** T4-U: submitted → verified by the creator (unpaid task, or paid task without settlement). */
export async function acceptUnpaidGate(
  db: DBAdapter, taskId: string, note: string | null, assertionId: string | null, nowIso: string,
): Promise<boolean> {
  const res = await db.run(
    `UPDATE tasks SET status = 'verified', verified_at = ?, accepted_by = 'creator',
       review_note = COALESCE(?, review_note), review_assertion_id = ?, auto_release_at = NULL
     WHERE task_id = ? AND status = 'submitted'`,
    nowIso, note, assertionId, taskId,
  );
  return res.changes === 1;
}

/**
 * T5: submitted → verified by the timer; a dispute freezes it. The timer is
 * part of the predicate: a re-delivery made after the cron's SELECT re-arms
 * `auto_release_at` and must get its own 7 days.
 */
export async function autoAcceptGate(db: DBAdapter, taskId: string, nowIso: string): Promise<boolean> {
  const res = await db.run(
    `UPDATE tasks SET status = 'verified', verified_at = ?, accepted_by = 'auto', auto_release_at = NULL
     WHERE task_id = ? AND status = 'submitted' AND disputed_at IS NULL
       AND auto_release_at IS NOT NULL AND auto_release_at <= ?`,
    nowIso, taskId, nowIso,
  );
  return res.changes === 1;
}

/** T6: submitted → claimed (request changes), capped at MAX_REVISIONS. */
export async function revisionGate(db: DBAdapter, taskId: string, note: string, nowIso: string): Promise<boolean> {
  const res = await db.run(
    `UPDATE tasks SET status = 'claimed', review_note = ?, revision_count = revision_count + 1,
       revision_requested_at = ?, auto_release_at = NULL, disputed_at = NULL
     WHERE task_id = ? AND status = 'submitted' AND revision_count < ?`,
    note, nowIso, taskId, MAX_REVISIONS,
  );
  return res.changes === 1;
}

/** T7: dispute flag on a submitted task; freezes auto-accept, touches no payment column. */
export async function disputeGate(db: DBAdapter, taskId: string, reason: string, nowIso: string): Promise<boolean> {
  const res = await db.run(
    `UPDATE tasks SET disputed_at = ?, review_note = ?, auto_release_at = NULL
     WHERE task_id = ? AND status = 'submitted' AND disputed_at IS NULL`,
    nowIso, reason, taskId,
  );
  return res.changes === 1;
}

/**
 * T8: open|claimed|submitted(disputed) → cancelled (N4). Delivered work can only
 * be cancelled after a dispute; accepted work never; money in flight never.
 * A never-settled bounty is voided (`expired`).
 */
export async function cancelGate(db: DBAdapter, taskId: string, nowIso: string): Promise<boolean> {
  const res = await db.run(
    `UPDATE tasks SET status = 'cancelled', cancelled_at = ?, auto_release_at = NULL,
       payment_status = CASE WHEN payment_status IN ('pending','failed','expired') THEN 'expired' ELSE payment_status END
     WHERE task_id = ? AND status IN ('open','claimed','submitted')
       AND (status <> 'submitted' OR disputed_at IS NOT NULL)
       AND payment_status NOT IN ('authorized','settling','settled')`,
    nowIso, taskId,
  );
  return res.changes === 1;
}

/** Why a cancel would be refused, from the row the route read (maps to 409 codes). */
export function cancelRefusal(t: Pick<TaskRow, 'status' | 'disputed_at' | 'payment_status'>): 'already_accepted' | 'dispute_first' | 'payment_in_flight' | 'conflict' | null {
  if (t.status === 'verified') return 'already_accepted';
  if (t.status === 'cancelled' || t.status === 'closed') return 'conflict';
  if (['authorized', 'settling', 'settled'].includes(t.payment_status)) return 'payment_in_flight';
  if (t.status === 'submitted' && !t.disputed_at) return 'dispute_first';
  return null;
}

// ─── Side effects after acceptance (shared by route, owner route and cron) ───

export interface AcceptSideEffects {
  chain: { sequence: number; entry_hash: string } | null;
}

/**
 * Runs after a T4/T5 gate won: chain entry attributed to the DELIVERER's key
 * (N5 — owners and the cron have no agent key), deliverer reputation,
 * `task.verified` webhook, funnel. Every step is best-effort.
 */
export async function afterAccept(
  db: DBAdapter,
  task: TaskRow,
  opts: { acceptedBy: 'creator' | 'auto'; by: Actor | { kind: 'auto' }; nowIso: string; paymentStatus: PaymentStatus },
): Promise<AcceptSideEffects> {
  let chain: AcceptSideEffects['chain'] = null;
  const deliverer = task.claimed_by_agent_id;
  if (deliverer) {
    try {
      const dataHash = hashCanonical({
        task_id: task.task_id,
        verified_at: opts.nowIso,
        accepted_by: opts.acceptedBy,
        verified_by_kind: opts.by.kind,
        verified_by_id: opts.by.kind === 'auto' ? null : actorId(opts.by),
      });
      chain = await taskChainEntry(db, deliverer, 'task_verified', dataHash);
    } catch (err) {
      console.error(`[tasks] chain entry failed for ${task.task_id}:`, err);
    }
    await recomputeReputation(db, deliverer);
    const target = await agentTarget(db, deliverer);
    sendWebhook(target, {
      type: 'task.verified',
      agent_id: deliverer,
      task_id: task.task_id,
      chain_sequence: chain?.sequence ?? null,
      chain_entry_hash: chain?.entry_hash ?? null,
      payment_settled: false,
      payment_tx_hash: null,
      payment_status: opts.paymentStatus,
      accepted_by: opts.acceptedBy,
    });
  }
  await recordFunnel(db, 'task_accepted', task.task_id, opts.acceptedBy);
  return { chain };
}
