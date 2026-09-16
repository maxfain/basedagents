/**
 * Settlement — the only code that moves a task's payment_status past
 * `authorized`. Shared by the accept route (immediate attempt) and the cron
 * (retries). Every write is predicated on the payment_status the caller read,
 * so a route and a cron tick racing on the same task cannot both act:
 *
 *   slot      authorized|failed|settling → settling   (WHERE settle_next_at <= now)
 *   broadcast settle_broadcast = 1                    (BEFORE the facilitator call,
 *                                                     WHERE payment_status='settling')
 *   outcome   settling → settled|failed|expired|settling  (WHERE payment_status='settling')
 *
 * `settle_broadcast` is the memory that a signed authorization MAY have reached
 * the chain. After it is set, the row is resolved only by a definitive
 * facilitator answer (settled / nonce used / expired) — never by a fresh
 * signature from the buyer, which would risk paying twice (N11).
 *
 * Every outcome also writes `last_settle_class`, a closed enum. The
 * re-authorization guard (`reauthPermitted`, used by the accept route in JS
 * and as a literal SQL predicate) reads ONLY that class — never the free-text
 * `last_settle_error`, which carries facilitator reasons and transport detail
 * for humans and must not be able to unlock a second payment.
 *
 * `tasks.status` is never written here.
 *
 * Escrow (Tasks P1): the same machine settles every LEG of an escrow task —
 * the buyer's deposit into the house wallet, the house's release to the
 * deliverer, the house's refund to the buyer. `tasks.escrow_leg` says which
 * one the payment columns describe; only the terminal writes differ (a settled
 * deposit becomes `escrow_status = funded` with the columns cleared for the
 * next leg; a settled refund is `payment_status = refunded`; a definitive
 * failure of a house-signed leg drops back to `funded` so the cron re-signs).
 */
import type { DBAdapter } from '../db/adapter.js';
import type { Bindings, PaymentStatus } from '../types/index.js';
import { paymentProviderFor } from './index.js';
import type { SettleOutcome } from './cdp-facilitator.js';
import { decryptPaymentSignature } from './crypto.js';
import { decodePaymentHeader, PaymentRequirementsV2, SETTLE_PRECHECK_SLACK } from './x402.js';
import {
  loadTask, logPaymentEvent, recordFunnel, taskChainEntry, hashCanonical,
  agentTarget, creatorTarget, isoPlus, notifyMatchingAgents, bountyView, type TaskRow, type EscrowLeg,
} from '../tasks/service.js';
import { recordEvent } from '../events/service.js';

/** Who started this settle attempt: the accept/fund/cancel route, or the cron. */
export type SettleTrigger = 'accept' | 'cron' | 'fund' | 'cancel';

/**
 * Escrow: SET fragment for a DEFINITIVE non-settled end of the current leg —
 * the custody state returns to solid ground: an `unfunded` deposit the buyer
 * redoes (POST /fund) or cancels, or `funded` so the cron's sweep re-signs the
 * release/refund (payments/escrow.ts). Retrying outcomes and post-broadcast
 * unknowns leave `escrow_status` alone. Empty for a sign-at-accept task.
 */
export function escrowLegFailedSql(leg: EscrowLeg | null | undefined): string {
  if (leg === 'deposit') return `, escrow_status = 'unfunded'`;
  if (leg === 'release' || leg === 'refund') return `, escrow_status = 'funded'`;
  return '';
}

/**
 * What the last settle attempt established:
 *   settled      money moved (or was inferred to have moved)
 *   pending      facilitator accepted the tx and is confirming it
 *   transient    facilitator/transport failure; our broadcast MAY have landed → retry, never re-sign
 *   terminal     the chain/facilitator rejected THIS signature before any transfer → buyer may re-sign
 *   insufficient rejected pre-flight for balance → retried until expiry; buyer may re-sign
 *   expired      the authorization's validBefore passed without a transfer
 *   config       payments not configured when the retry ran
 *   unknown      undetermined after our own broadcast; a human must reconcile
 */
export type SettleClass = 'settled' | 'pending' | 'transient' | 'terminal' | 'insufficient' | 'expired' | 'config' | 'unknown';

/** Classes after which a NEW authorization may replace the stored one (used as SQL literals too). */
export const REAUTH_CLASSES: readonly SettleClass[] = ['terminal', 'insufficient'];

export type SettleResult =
  | { skipped: true; reason: 'not_due' | 'expired' | 'no_row' | 'lost_slot' }
  | { skipped: false; payment_status: PaymentStatus; tx_hash: string | null; error: string | null; facilitator: SettleOutcome | null };

/** Retry schedule for transient facilitator outcomes: 2 min, 4, 8, 16, then 30 min. */
export function settleBackoffMs(attempts: number): number {
  return Math.min(2 * 60_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
}
/** A broadcast row still undetermined this long after its authorization expired is handed to a human. */
export const UNKNOWN_OUTCOME_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * May the buyer replace the stored authorization with a new signature?
 * Only when we KNOW our broadcast could not have moved money: nothing was
 * ever broadcast, the chain refused the authorization (expired), or the
 * facilitator rejected it before any transfer (terminal / insufficient).
 * Mirrors the SQL predicate in the accept gate — keep both in sync.
 */
export function reauthPermitted(t: Pick<TaskRow, 'payment_status' | 'settle_broadcast' | 'last_settle_class'>): boolean {
  if (!['pending', 'failed', 'expired'].includes(t.payment_status)) return false;
  if (t.settle_broadcast === 0) return true;
  if (t.payment_status === 'expired') return true;
  return REAUTH_CLASSES.includes(t.last_settle_class as SettleClass);
}

/**
 * Facilitator rejection reasons that mean "this signature can never settle":
 * exact CDP errorReason values (structured), never free text.
 */
const TERMINAL_REASONS = new Set([
  'invalid_scheme', 'invalid_network', 'invalid_x402_version', 'invalid_payment_requirements', 'invalid_payload',
  'invalid_exact_evm_payload_authorization_value', 'invalid_exact_evm_payload_authorization_value_too_low',
  'invalid_exact_evm_payload_authorization_valid_after', 'invalid_exact_evm_payload_authorization_typed_data_message',
  'invalid_exact_evm_payload_authorization_from_address_kyt', 'invalid_exact_evm_payload_authorization_to_address_kyt',
  'invalid_exact_evm_payload_signature', 'invalid_exact_evm_payload_signature_address',
  'invalid_exact_evm_payload_recipient_mismatch', 'invalid_exact_evm_payload_authorization_value_mismatch',
  'invalid_exact_evm_token_name_mismatch', 'invalid_exact_evm_token_version_mismatch',
  'invalid_exact_evm_permit2_payload_allowance_required', 'invalid_exact_evm_permit2_payload_signature',
  'invalid_exact_evm_permit2_payload_deadline', 'invalid_exact_evm_permit2_payload_valid_after',
  'invalid_exact_evm_permit2_payload_spender', 'invalid_exact_evm_permit2_payload_recipient',
  'invalid_exact_evm_permit2_payload_amount', 'invalid_amount', 'amount_too_low', 'kyt_risk_detected',
  'request_blocked_by_location', 'self_send_not_allowed', 'preflight_validation_failed', 'unsupported_scheme',
  'unsupported_network', 'unsupported_asset',
]);

export type RejectionClass = 'expired' | 'insufficient' | 'nonce_used' | 'duplicate' | 'terminal' | 'transient';

/** Classify a STRUCTURED facilitator `errorReason` (never a transport message). */
export function classifyRejection(reason: string): RejectionClass {
  if (reason === 'duplicate_settlement') return 'duplicate';
  if (reason === 'invalid_exact_evm_nonce_already_used') return 'nonce_used';
  if (reason === 'invalid_exact_evm_payload_authorization_valid_before' || reason.endsWith('_valid_before') || reason.endsWith('_deadline_expired')) return 'expired';
  if (reason === 'insufficient_funds' || reason === 'invalid_exact_evm_insufficient_balance' || reason === 'invalid_exact_evm_insufficient_funds') return 'insufficient';
  if (TERMINAL_REASONS.has(reason)) return 'terminal';
  return 'transient';
}

/** The x402 `SettleResponse` wire shape for the PAYMENT-RESPONSE header. */
export function wireSettleResponse(o: SettleOutcome, network: string | null): Record<string, unknown> {
  switch (o.kind) {
    case 'settled':
      return { success: true, transaction: o.transaction, network: o.network ?? network, payer: o.payer };
    case 'pending':
      return { success: false, errorReason: 'settlement_pending', transaction: o.transaction, network };
    case 'rejected':
      return { success: false, errorReason: o.reason, errorMessage: o.message, transaction: o.transaction ?? '', network };
    case 'unavailable':
      return { success: false, errorReason: `facilitator_${o.cause}`, transaction: '', network };
  }
}

async function paymentWebhooks(db: DBAdapter, task: TaskRow, event: 'task.payment_settled' | 'task.payment_failed', extra: Record<string, unknown>, now: string): Promise<void> {
  const targets = [await agentTarget(db, task.claimed_by_agent_id), await creatorTarget(db, task)];
  for (const t of targets) {
    if (!t) continue;
    // Persist to the recipient's inbox; the cron outbox drainer pushes the webhook.
    if (event === 'task.payment_settled') {
      await recordEvent(db, t.id, { type: event, agent_id: t.id, task_id: task.task_id, payment_tx_hash: (extra.tx_hash as string | null) ?? null, amount_atomic: task.bounty_amount, network: task.bounty_network }, now);
    } else {
      await recordEvent(db, t.id, { type: event, agent_id: t.id, task_id: task.task_id, reason: String(extra.reason ?? 'unknown') }, now);
    }
  }
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
  // 1. Claim the settle slot — from here until the outcome write, this caller owns the row.
  const slot = await db.run(
    `UPDATE tasks SET payment_status = 'settling', settle_attempts = settle_attempts + 1, settle_started_at = ?, settle_next_at = NULL
     WHERE task_id = ? AND (status = 'verified' OR escrow_leg IN ('deposit','refund'))
       AND payment_status IN ('authorized','failed','settling')
       AND settle_next_at IS NOT NULL AND settle_next_at <= ?`,
    nowIso, taskId, nowIso,
  );
  if (slot.changes !== 1) {
    const exists = await db.get<{ task_id: string }>('SELECT task_id FROM tasks WHERE task_id = ?', taskId);
    return { skipped: true, reason: exists ? 'not_due' : 'no_row' };
  }

  const task = (await loadTask(db, taskId)) as TaskRow;

  // 2. Expiry check under the slot: never broadcast an authorization about to expire.
  //    (Only for rows never broadcast — a broadcast row is resolved by the facilitator.)
  if (task.settle_broadcast === 0 && task.payment_expires_at && task.payment_expires_at <= isoPlus(nowIso, SETTLE_PRECHECK_SLACK * 1000)) {
    const res = await db.run(
      `UPDATE tasks SET payment_status = 'expired', settle_next_at = NULL, last_settle_error = 'authorization_expired', last_settle_class = 'expired'${escrowLegFailedSql(task.escrow_leg)}
       WHERE task_id = ? AND payment_status = 'settling' AND settle_broadcast = 0`,
      taskId,
    );
    if (res.changes === 1) {
      await logPaymentEvent(db, taskId, 'expired', { reason: 'authorization_expired', trigger, leg: task.escrow_leg ?? undefined }, nowIso);
      await paymentWebhooks(db, task, 'task.payment_failed', { reason: 'expired' }, nowIso);
    }
    return { skipped: true, reason: 'expired' };
  }

  // 3. Configuration (reachable only from the cron after a config regression).
  const provider = paymentProviderFor(env);
  const encKey = env.PAYMENT_ENCRYPTION_KEY;
  if (!provider || !encKey) {
    await db.run(
      `UPDATE tasks SET payment_status = 'failed', last_settle_error = 'payments_not_configured', last_settle_class = 'config', settle_next_at = ?
       WHERE task_id = ? AND payment_status = 'settling'`,
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
    // Never broadcast → the buyer may safely re-sign. Already broadcast → we
    // can no longer prove what happened: hand it to a human.
    const neverBroadcast = task.settle_broadcast === 0;
    const error = neverBroadcast ? 'stored_payload_unreadable' : 'stored_payload_unreadable_after_broadcast';
    await db.run(
      `UPDATE tasks SET payment_status = 'failed', settle_next_at = NULL, last_settle_error = ?, last_settle_class = ?${neverBroadcast ? escrowLegFailedSql(task.escrow_leg) : ''}
       WHERE task_id = ? AND payment_status = 'settling'`,
      error, neverBroadcast ? 'terminal' : 'unknown', taskId,
    );
    await logPaymentEvent(db, taskId, 'settle_failed', { error: `${error}: ${String(err).slice(0, 200)}`, trigger }, nowIso);
    if (!neverBroadcast) console.error(`[payments] ${taskId}: stored payload unreadable after broadcast — manual reconciliation required`);
    return { skipped: false, payment_status: 'failed', tx_hash: task.payment_tx_hash, error, facilitator: null };
  }

  // 5. Record that the payload MAY reach the chain, then call. If the row was
  //    taken from us in between (it cannot be, but the predicate says so), stop.
  const flagged = await db.run(`UPDATE tasks SET settle_broadcast = 1 WHERE task_id = ? AND payment_status = 'settling'`, taskId);
  if (flagged.changes !== 1) return { skipped: true, reason: 'lost_slot' };

  let outcome: SettleOutcome;
  try {
    outcome = await provider.settle(payload, requirements);
  } catch (err) {
    outcome = { kind: 'unavailable', cause: 'network', detail: String(err).slice(0, 500) };
  }
  return applySettleOutcome(db, task, outcome, trigger, nowIso);
}

/** Apply the OUTCOME TABLE (spec section 2 step 7). Every write: WHERE payment_status = 'settling'. */
export async function applySettleOutcome(
  db: DBAdapter,
  task: TaskRow,
  outcome: SettleOutcome,
  trigger: SettleTrigger,
  nowIso: string,
): Promise<SettleResult> {
  const taskId = task.task_id;
  // `task` was read after this attempt claimed the slot but BEFORE it wrote
  // settle_broadcast=1, so the flag here means an EARLIER attempt sent this very
  // payload — a "nonce already used" answer is then OUR landing, not a conflict.
  const attempts = task.settle_attempts;
  const everBroadcastBefore = task.settle_broadcast === 1;

  /** Escrow deposit landed in the house wallet: the task is funded and claimable; the payment columns are cleared for the payout leg. */
  const depositSettled = async (tx: string | null, inferredFrom?: string): Promise<SettleResult> => {
    // Every right-hand side reads the OLD row (SQLite semantics), so the deposit
    // facts are copied before the same statement clears their source columns.
    const res = await db.run(
      `UPDATE tasks SET payment_status = 'pending', payment_settled = 0, payment_signature = NULL, payment_requirements = NULL,
         payment_nonce = NULL, payment_tx_hash = NULL, payment_expires_at = NULL, settled_at = NULL, settle_next_at = NULL,
         settle_broadcast = 0, last_settle_error = ?, last_settle_class = 'settled',
         escrow_status = 'funded', escrow_leg = NULL, escrow_funded_at = ?,
         escrow_deposit_tx_hash = COALESCE(?, payment_tx_hash), escrow_deposit_payer = payment_payer, escrow_deposit_nonce = payment_nonce
       WHERE task_id = ? AND payment_status = 'settling' AND escrow_leg = 'deposit'`,
      inferredFrom ? `settled_inferred_${inferredFrom}` : null, nowIso, tx, taskId,
    );
    if (res.changes !== 1) return { skipped: true, reason: 'not_due' };
    const txHash = tx ?? task.payment_tx_hash ?? null;
    await logPaymentEvent(db, taskId, 'escrow_funded', { transaction: txHash, network: task.bounty_network, payer: task.payment_payer, trigger, ...(inferredFrom ? { inferred_from: inferredFrom } : {}) }, nowIso);
    if (inferredFrom) console.warn(`[escrow] ${taskId}: deposit inferred settled from ${inferredFrom} (tx ${txHash ?? 'unknown'}) — reconcile on-chain`);
    const creator = await creatorTarget(db, task);
    if (creator) {
      await recordEvent(db, creator.id, { type: 'task.escrow_funded', agent_id: creator.id, task_id: taskId, amount_atomic: task.bounty_amount, network: task.bounty_network, deposit_tx_hash: txHash }, nowIso);
    }
    // The task is only now claimable, so only now is it advertised (task.available).
    let reqCaps: string[] | null = null;
    try { reqCaps = task.required_capabilities ? (JSON.parse(task.required_capabilities) as string[]) : null; } catch { reqCaps = null; }
    await notifyMatchingAgents(db, {
      task_id: taskId, title: task.title, description: task.description, category: task.category,
      required_capabilities: reqCaps, output_format: task.output_format, bounty: bountyView(task),
    }, task.creator_agent_id);
    await recordFunnel(db, 'task_escrow_funded', taskId, trigger);
    return { skipped: false, payment_status: 'pending', tx_hash: txHash, error: null, facilitator: outcome };
  };

  /** Escrow refund landed in the buyer's wallet. */
  const refundSettled = async (tx: string | null, inferredFrom?: string): Promise<SettleResult> => {
    const res = await db.run(
      `UPDATE tasks SET payment_status = 'refunded', payment_settled = 0, payment_tx_hash = COALESCE(?, payment_tx_hash),
         settled_at = ?, settle_next_at = NULL, last_settle_error = ?, last_settle_class = 'settled',
         escrow_status = 'refunded', escrow_refunded_at = ?, escrow_refund_tx_hash = COALESCE(?, payment_tx_hash)
       WHERE task_id = ? AND payment_status = 'settling' AND escrow_leg = 'refund'`,
      tx, nowIso, inferredFrom ? `settled_inferred_${inferredFrom}` : null, nowIso, tx, taskId,
    );
    if (res.changes !== 1) return { skipped: true, reason: 'not_due' };
    const txHash = tx ?? task.payment_tx_hash ?? null;
    await logPaymentEvent(db, taskId, 'escrow_refunded', { transaction: txHash, network: task.bounty_network, refund_to: task.escrow_deposit_payer, trigger, ...(inferredFrom ? { inferred_from: inferredFrom } : {}) }, nowIso);
    if (inferredFrom) console.warn(`[escrow] ${taskId}: refund inferred settled from ${inferredFrom} (tx ${txHash ?? 'unknown'}) — reconcile on-chain`);
    const creator = await creatorTarget(db, task);
    if (creator) {
      await recordEvent(db, creator.id, { type: 'task.escrow_refunded', agent_id: creator.id, task_id: taskId, amount_atomic: task.bounty_amount, network: task.bounty_network, refund_tx_hash: txHash }, nowIso);
    }
    await recordFunnel(db, 'task_refunded', taskId, trigger);
    return { skipped: false, payment_status: 'refunded', tx_hash: txHash, error: null, facilitator: outcome };
  };

  const settled = async (tx: string | null, inferredFrom?: string): Promise<SettleResult> => {
    if (task.escrow_leg === 'deposit') return depositSettled(tx, inferredFrom);
    if (task.escrow_leg === 'refund') return refundSettled(tx, inferredFrom);
    const release = task.escrow_leg === 'release';
    const res = await db.run(
      `UPDATE tasks SET payment_status = 'settled', payment_settled = 1, payment_tx_hash = COALESCE(?, payment_tx_hash),
         settled_at = ?, settle_next_at = NULL, last_settle_error = ?, last_settle_class = 'settled'
         ${release ? `, escrow_status = 'released', escrow_released_at = ?, escrow_release_tx_hash = COALESCE(?, payment_tx_hash)` : ''}
       WHERE task_id = ? AND payment_status = 'settling'`,
      tx, nowIso, inferredFrom ? `settled_inferred_${inferredFrom}` : null, ...(release ? [nowIso, tx] : []), taskId,
    );
    if (res.changes !== 1) return { skipped: true, reason: 'not_due' };
    const txHash = tx ?? task.payment_tx_hash ?? null;
    await logPaymentEvent(db, taskId, 'settled', { transaction: txHash, network: task.bounty_network, trigger, ...(release ? { leg: 'release', from: task.payment_payer } : {}), ...(inferredFrom ? { inferred_from: inferredFrom } : {}) }, nowIso);
    if (inferredFrom) console.warn(`[payments] ${taskId}: settlement inferred from ${inferredFrom} (tx ${txHash ?? 'unknown'}) — reconcile on-chain`);
    if (task.claimed_by_agent_id) {
      try {
        await taskChainEntry(db, task.claimed_by_agent_id, 'task_payment_settled', hashCanonical({ task_id: taskId, settled_at: nowIso, tx_hash: txHash }));
      } catch (err) {
        console.error(`[payments] chain entry failed for ${taskId}:`, err);
      }
    }
    await paymentWebhooks(db, task, 'task.payment_settled', { tx_hash: txHash }, nowIso);
    await recordFunnel(db, 'task_paid', taskId, trigger);
    return { skipped: false, payment_status: 'settled', tx_hash: txHash, error: null, facilitator: outcome };
  };

  const failed = async (error: string, cls: SettleClass, nextAt: string | null, opts: { webhook?: boolean; level?: 'warn' | 'error' } = {}): Promise<SettleResult> => {
    // A terminal answer ends the leg for good (the signature can never land);
    // an `unknown` one (after our own broadcast) is not definitive and keeps the
    // escrow state frozen for a human.
    const definitive = nextAt === null && cls === 'terminal';
    const res = await db.run(
      `UPDATE tasks SET payment_status = 'failed', settle_next_at = ?, last_settle_error = ?, last_settle_class = ?${definitive ? escrowLegFailedSql(task.escrow_leg) : ''}
       WHERE task_id = ? AND payment_status = 'settling'`,
      nextAt, error.slice(0, 500), cls, taskId,
    );
    if (res.changes !== 1) return { skipped: true, reason: 'not_due' };
    await logPaymentEvent(db, taskId, 'settle_failed', { error, class: cls, retryable: nextAt !== null, trigger, leg: task.escrow_leg ?? undefined }, nowIso);
    if (opts.webhook) await paymentWebhooks(db, task, 'task.payment_failed', { reason: error }, nowIso);
    if (opts.level === 'error') console.error(`[payments] ${taskId}: ${error}`);
    if (task.escrow_leg === 'release' || task.escrow_leg === 'refund') {
      // A house-signed leg failing is an operator problem (wrong domain, KYT block, empty house wallet), never the buyer's.
      console.error(`[escrow] ${taskId}: ${task.escrow_leg} leg ${cls} (${error}) — attempt ${task.escrow_leg_attempts}${definitive ? '; back to funded, the cron re-signs' : ''}`);
    }
    return { skipped: false, payment_status: 'failed', tx_hash: task.payment_tx_hash, error, facilitator: outcome };
  };

  const expired = async (): Promise<SettleResult> => {
    const res = await db.run(
      `UPDATE tasks SET payment_status = 'expired', settle_next_at = NULL, last_settle_error = 'authorization_expired', last_settle_class = 'expired'${escrowLegFailedSql(task.escrow_leg)}
       WHERE task_id = ? AND payment_status = 'settling'`,
      taskId,
    );
    if (res.changes !== 1) return { skipped: true, reason: 'not_due' };
    await logPaymentEvent(db, taskId, 'expired', { reason: 'authorization_expired', trigger, leg: task.escrow_leg ?? undefined }, nowIso);
    await paymentWebhooks(db, task, 'task.payment_failed', { reason: 'expired' }, nowIso);
    if (task.escrow_leg === 'release' || task.escrow_leg === 'refund') {
      console.error(`[escrow] ${taskId}: ${task.escrow_leg} authorization expired unsettled — attempt ${task.escrow_leg_attempts}; back to funded, the cron re-signs`);
    }
    return { skipped: false, payment_status: 'expired', tx_hash: null, error: 'authorization_expired', facilitator: outcome };
  };

  const transient = (error: string) => failed(error, 'transient', isoPlus(nowIso, settleBackoffMs(attempts)));

  switch (outcome.kind) {
    case 'settled':
      return settled(outcome.transaction);
    case 'pending': {
      const res = await db.run(
        `UPDATE tasks SET payment_tx_hash = ?, settle_next_at = ?, last_settle_error = 'settlement_pending', last_settle_class = 'pending'
         WHERE task_id = ? AND payment_status = 'settling'`,
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
          // Consumed elsewhere before our first broadcast → this signature can never land: buyer may re-sign.
          return everBroadcastBefore
            ? settled(null, 'nonce_used')
            : failed('nonce_conflict', 'terminal', null, { webhook: true, level: 'error' });
        case 'expired':
          return expired();
        case 'insufficient': {
          // Rejected pre-flight (no transfer). Retry every 10 min while the
          // authorization lives; the final retry lands just AFTER validBefore so
          // the facilitator gives the definitive `_valid_before` → expired
          // answer instead of leaving the row stuck.
          const expiresAt = task.payment_expires_at;
          const farFromExpiry = !!expiresAt && expiresAt > isoPlus(nowIso, 15 * 60_000);
          const nextAt = farFromExpiry
            ? isoPlus(nowIso, 10 * 60_000)
            : (expiresAt && expiresAt > nowIso ? isoPlus(expiresAt, 60_000) : isoPlus(nowIso, 60_000));
          return failed(outcome.reason, 'insufficient', nextAt, { webhook: true });
        }
        case 'terminal':
          return failed(outcome.reason, 'terminal', null, { webhook: true, level: 'error' });
        default:
          return transient(outcome.reason);
      }
    }
    case 'unavailable':
      switch (outcome.cause) {
        case 'billing':
          return failed('facilitator_billing', 'transient', isoPlus(nowIso, 60 * 60_000), { level: 'error' });
        case 'auth':
          return failed('facilitator_auth', 'transient', isoPlus(nowIso, 60 * 60_000), { level: 'error' });
        case 'rate_limited':
          return failed('facilitator_rate_limited', 'transient', isoPlus(nowIso, 5 * 60_000));
        default:
          return transient(`facilitator_${outcome.cause}: ${outcome.detail}`.slice(0, 500));
      }
  }
}
