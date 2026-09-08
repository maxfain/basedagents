/**
 * Settlement — the only code that moves a task's payment_status past
 * `authorized`. Shared by the accept route (immediate attempt) and the cron
 * (retries). Every write is predicated on the payment_status the caller read,
 * so a route and a cron tick racing on the same task cannot both act:
 *
 *   slot      authorized|failed|settling → settling   (WHERE settle_next_at <= now)
 *   broadcast settle_broadcast = 1                    (BEFORE the facilitator call)
 *   outcome   settling → settled|failed|expired|settling  (WHERE payment_status='settling')
 *
 * `settle_broadcast` is the memory that a signed authorization MAY have reached
 * the chain. After it is set, the row is resolved only by a definitive
 * facilitator answer (settled / nonce used / expired) — never by a fresh
 * signature from the buyer, which would risk paying twice (N11).
 *
 * `tasks.status` is never written here.
 */
import type { DBAdapter } from '../db/adapter.js';
import type { Bindings, PaymentStatus } from '../types/index.js';
import { paymentProviderFor } from './index.js';
import type { SettleOutcome } from './cdp-facilitator.js';
import { decryptPaymentSignature } from './crypto.js';
import { decodePaymentHeader, PaymentRequirementsV2, SETTLE_PRECHECK_SLACK } from './x402.js';
import {
  loadTask, logPaymentEvent, recordFunnel, taskChainEntry, hashCanonical,
  agentTarget, creatorTarget, sendWebhook, isoPlus, type TaskRow,
} from '../tasks/service.js';

export type SettleTrigger = 'accept' | 'cron';

export type SettleResult =
  | { skipped: true; reason: 'not_due' | 'expired' | 'no_row' }
  | { skipped: false; payment_status: PaymentStatus; tx_hash: string | null; error: string | null; facilitator: SettleOutcome | null };

/** Retry schedule for transient facilitator outcomes: 2 min, 4, 8, 16, then 30 min. */
export function settleBackoffMs(attempts: number): number {
  return Math.min(2 * 60_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
}
/** A broadcast row still undetermined this long after its authorization expired is handed to a human. */
export const UNKNOWN_OUTCOME_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Facilitator rejections that mean "this signature can never settle" — the
 * chain never accepted it, so the buyer may safely re-sign even though we
 * broadcast (the re-authorization guard in the accept route consults this).
 */
export function isTerminalValidation(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return /mismatch|signature|invalid_payload|invalid_payment_requirements|invalid_network|invalid_scheme|unsupported|invalid_x402_version|invalid_amount|amount_too_low|kyt|blocked|self_send|permit2|preflight|invalid_exact_evm_payload_authorization_value|typed_data|stored_payload_unreadable|nonce_conflict/.test(reason);
}

export type RejectionClass = 'expired' | 'insufficient' | 'nonce_used' | 'duplicate' | 'terminal' | 'transient';

export function classifyRejection(reason: string): RejectionClass {
  if (/duplicate_settlement/.test(reason)) return 'duplicate';
  if (/nonce_already_used/.test(reason)) return 'nonce_used';
  if (/valid_before|deadline/.test(reason)) return 'expired';
  if (/insufficient/.test(reason)) return 'insufficient';
  if (isTerminalValidation(reason)) return 'terminal';
  return 'transient';
}

async function paymentWebhooks(db: DBAdapter, task: TaskRow, event: 'task.payment_settled' | 'task.payment_failed', extra: Record<string, unknown>): Promise<void> {
  const targets = [await agentTarget(db, task.claimed_by_agent_id), await creatorTarget(db, task)];
  for (const t of targets) {
    if (!t) continue;
    if (event === 'task.payment_settled') {
      sendWebhook(t, { type: event, agent_id: t.id, task_id: task.task_id, payment_tx_hash: (extra.tx_hash as string | null) ?? null, amount_atomic: task.bounty_amount, network: task.bounty_network });
    } else {
      sendWebhook(t, { type: event, agent_id: t.id, task_id: task.task_id, reason: String(extra.reason ?? 'unknown') });
    }
  }
}

async function markExpired(db: DBAdapter, task: TaskRow, predicateStatuses: string[], nowIso: string): Promise<boolean> {
  const placeholders = predicateStatuses.map(() => '?').join(',');
  const res = await db.run(
    `UPDATE tasks SET payment_status = 'expired', settle_next_at = NULL, last_settle_error = 'authorization_expired'
     WHERE task_id = ? AND payment_status IN (${placeholders}) AND settle_broadcast = 0`,
    task.task_id, ...predicateStatuses,
  );
  if (res.changes !== 1) return false;
  await logPaymentEvent(db, task.task_id, 'expired', { reason: 'authorization_expired', trigger: 'settle' }, nowIso);
  await paymentWebhooks(db, task, 'task.payment_failed', { reason: 'expired' });
  return true;
}

/**
 * Attempt (or re-attempt) settlement of an accepted, authorized task.
 * Idempotent and race-safe as described in the header. Never throws.
 */
export async function settleTask(
  db: DBAdapter,
  env: Bindings,
  taskId: string,
  trigger: SettleTrigger,
  nowIso: string = new Date().toISOString(),
): Promise<SettleResult> {
  const pre = await loadTask(db, taskId);
  if (!pre) return { skipped: true, reason: 'no_row' };

  // 1. Expiry precheck: never broadcast an authorization about to expire.
  if (pre.settle_broadcast === 0 && pre.payment_expires_at && pre.payment_expires_at <= isoPlus(nowIso, SETTLE_PRECHECK_SLACK * 1000)) {
    if (await markExpired(db, pre, ['authorized', 'failed'], nowIso)) return { skipped: true, reason: 'expired' };
  }

  // 2. Claim the settle slot.
  const slot = await db.run(
    `UPDATE tasks SET payment_status = 'settling', settle_attempts = settle_attempts + 1, settle_started_at = ?, settle_next_at = NULL
     WHERE task_id = ? AND status = 'verified' AND payment_status IN ('authorized','failed','settling')
       AND settle_next_at IS NOT NULL AND settle_next_at <= ?`,
    nowIso, taskId, nowIso,
  );
  if (slot.changes !== 1) return { skipped: true, reason: 'not_due' };

  const task = (await loadTask(db, taskId)) as TaskRow;

  // 3. Configuration (reachable only from the cron after a config regression).
  const provider = paymentProviderFor(env);
  const encKey = env.PAYMENT_ENCRYPTION_KEY;
  if (!provider || !encKey) {
    await db.run(
      `UPDATE tasks SET payment_status = 'failed', last_settle_error = 'payments_not_configured', settle_next_at = ? WHERE task_id = ? AND payment_status = 'settling'`,
      isoPlus(nowIso, 60 * 60_000), taskId,
    );
    await logPaymentEvent(db, taskId, 'settle_failed', { error: 'payments_not_configured', trigger }, nowIso);
    return { skipped: false, payment_status: 'failed', tx_hash: task.payment_tx_hash, error: 'payments_not_configured', facilitator: null };
  }

  // 4. Rehydrate the exact payload + requirements used at verify time.
  let payload: ReturnType<typeof decodePaymentHeader>;
  let requirements: ReturnType<typeof PaymentRequirementsV2.parse>;
  try {
    if (!task.payment_signature || !task.payment_requirements) throw new Error('missing stored payment');
    payload = decodePaymentHeader(await decryptPaymentSignature(task.payment_signature, encKey));
    requirements = PaymentRequirementsV2.parse(JSON.parse(task.payment_requirements));
  } catch (err) {
    await db.run(
      `UPDATE tasks SET payment_status = 'failed', settle_next_at = NULL, last_settle_error = 'stored_payload_unreadable' WHERE task_id = ? AND payment_status = 'settling'`,
      taskId,
    );
    await logPaymentEvent(db, taskId, 'settle_failed', { error: `stored_payload_unreadable: ${String(err).slice(0, 200)}`, trigger }, nowIso);
    return { skipped: false, payment_status: 'failed', tx_hash: null, error: 'stored_payload_unreadable', facilitator: null };
  }

  await db.run(`UPDATE tasks SET settle_broadcast = 1 WHERE task_id = ? AND payment_status = 'settling'`, taskId);

  // 5. Facilitator call — classified, never thrown.
  let outcome: SettleOutcome;
  try {
    outcome = await provider.settle(payload, requirements);
  } catch (err) {
    outcome = { kind: 'unavailable', cause: 'network', detail: String(err).slice(0, 500) };
  }
  return applySettleOutcome(db, task, outcome, trigger, nowIso);
}

/** Apply the OUTCOME TABLE (spec §2 step 7). Every write: WHERE payment_status = 'settling'. */
export async function applySettleOutcome(
  db: DBAdapter,
  task: TaskRow,
  outcome: SettleOutcome,
  trigger: SettleTrigger,
  nowIso: string,
): Promise<SettleResult> {
  const taskId = task.task_id;
  // settle_attempts was incremented by the slot claim; >1 means an earlier attempt
  // already sent this very payload, so a "nonce already used" answer is OUR landing.
  const attempts = task.settle_attempts;
  const everBroadcastBefore = attempts > 1;

  const settled = async (tx: string | null, inferredFrom?: string): Promise<SettleResult> => {
    const res = await db.run(
      `UPDATE tasks SET payment_status = 'settled', payment_settled = 1, payment_tx_hash = COALESCE(?, payment_tx_hash),
         settled_at = ?, settle_next_at = NULL, last_settle_error = ?
       WHERE task_id = ? AND payment_status = 'settling'`,
      tx, nowIso, inferredFrom ? `settled_inferred_${inferredFrom}` : null, taskId,
    );
    if (res.changes !== 1) return { skipped: true, reason: 'not_due' };
    const txHash = tx ?? task.payment_tx_hash ?? null;
    await logPaymentEvent(db, taskId, 'settled', { transaction: txHash, network: task.bounty_network, trigger, ...(inferredFrom ? { inferred_from: inferredFrom } : {}) }, nowIso);
    if (inferredFrom) console.warn(`[payments] ${taskId}: settlement inferred from ${inferredFrom} (tx ${txHash ?? 'unknown'}) — reconcile on-chain`);
    if (task.claimed_by_agent_id) {
      try {
        await taskChainEntry(db, task.claimed_by_agent_id, 'task_payment_settled', hashCanonical({ task_id: taskId, settled_at: nowIso, tx_hash: txHash }));
      } catch (err) {
        console.error(`[payments] chain entry failed for ${taskId}:`, err);
      }
    }
    await paymentWebhooks(db, task, 'task.payment_settled', { tx_hash: txHash });
    await recordFunnel(db, 'task_paid', taskId, trigger);
    return { skipped: false, payment_status: 'settled', tx_hash: txHash, error: null, facilitator: outcome };
  };

  const failed = async (error: string, nextAt: string | null, opts: { webhook?: boolean; level?: 'warn' | 'error' } = {}): Promise<SettleResult> => {
    const res = await db.run(
      `UPDATE tasks SET payment_status = 'failed', settle_next_at = ?, last_settle_error = ? WHERE task_id = ? AND payment_status = 'settling'`,
      nextAt, error.slice(0, 500), taskId,
    );
    if (res.changes !== 1) return { skipped: true, reason: 'not_due' };
    await logPaymentEvent(db, taskId, 'settle_failed', { error, retryable: nextAt !== null, trigger }, nowIso);
    if (opts.webhook) await paymentWebhooks(db, task, 'task.payment_failed', { reason: error });
    if (opts.level === 'error') console.error(`[payments] ${taskId}: ${error}`);
    return { skipped: false, payment_status: 'failed', tx_hash: task.payment_tx_hash, error, facilitator: outcome };
  };

  const expired = async (): Promise<SettleResult> => {
    const res = await db.run(
      `UPDATE tasks SET payment_status = 'expired', settle_next_at = NULL, last_settle_error = 'authorization_expired' WHERE task_id = ? AND payment_status = 'settling'`,
      taskId,
    );
    if (res.changes !== 1) return { skipped: true, reason: 'not_due' };
    await logPaymentEvent(db, taskId, 'expired', { reason: 'authorization_expired', trigger }, nowIso);
    await paymentWebhooks(db, task, 'task.payment_failed', { reason: 'expired' });
    return { skipped: false, payment_status: 'expired', tx_hash: null, error: 'authorization_expired', facilitator: outcome };
  };

  const transient = (error: string) => failed(error, isoPlus(nowIso, settleBackoffMs(attempts)));

  switch (outcome.kind) {
    case 'settled':
      return settled(outcome.transaction);
    case 'pending': {
      const res = await db.run(
        `UPDATE tasks SET payment_tx_hash = ?, settle_next_at = ?, last_settle_error = 'settlement_pending' WHERE task_id = ? AND payment_status = 'settling'`,
        outcome.transaction, isoPlus(nowIso, 2 * 60_000), taskId,
      );
      if (res.changes !== 1) return { skipped: true, reason: 'not_due' };
      await logPaymentEvent(db, taskId, 'settle_pending', { transaction: outcome.transaction, trigger }, nowIso);
      return { skipped: false, payment_status: 'settling', tx_hash: outcome.transaction, error: 'settlement_pending', facilitator: outcome };
    }
    case 'rejected': {
      const cls = classifyRejection(outcome.reason);
      switch (cls) {
        case 'duplicate':
          return settled(outcome.transaction ?? null, 'duplicate_settlement');
        case 'nonce_used':
          return everBroadcastBefore
            ? settled(null, 'nonce_used')
            : failed('nonce_conflict', null, { webhook: true, level: 'error' });
        case 'expired':
          return expired();
        case 'insufficient': {
          const retryable = !!task.payment_expires_at && task.payment_expires_at > isoPlus(nowIso, 15 * 60_000);
          return failed(outcome.reason, retryable ? isoPlus(nowIso, 10 * 60_000) : null, { webhook: true });
        }
        case 'terminal':
          return failed(outcome.reason, null, { webhook: true, level: 'error' });
        default:
          return transient(outcome.reason);
      }
    }
    case 'unavailable':
      switch (outcome.cause) {
        case 'billing':
          return failed('facilitator_billing', isoPlus(nowIso, 60 * 60_000), { level: 'error' });
        case 'auth':
          return failed('facilitator_auth', isoPlus(nowIso, 60 * 60_000), { level: 'error' });
        case 'rate_limited':
          return failed('facilitator_rate_limited', isoPlus(nowIso, 5 * 60_000));
        default:
          return transient(`facilitator_${outcome.cause}: ${outcome.detail}`.slice(0, 500));
      }
  }
}
