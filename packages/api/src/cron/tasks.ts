/**
 * Task cron — runs every 5 minutes from the Worker's `scheduled` handler.
 *
 *   1. Auto-accept: delivered tasks nobody reviewed for 7 days become
 *      `verified` / accepted_by='auto' (N3). Never touches payment columns —
 *      a non-custodial marketplace cannot move money on the buyer's silence.
 *   2. Settle retry: accepted + authorized/failed/settling rows that are due.
 *   3. Expiry sweep: un-broadcast authorizations past validBefore.
 *   4. Crash recovery: `settling` rows whose attempt died mid-flight.
 *   5. Unknown-outcome cap: broadcast rows still undetermined 24 h after expiry.
 *
 * Every query is bounded (LIMIT 50) and every row is isolated in try/catch so
 * one bad row never stalls the loop. Exported for tests with an injected clock.
 */
import type { DBAdapter } from '../db/adapter.js';
import type { Bindings } from '../types/index.js';
import { paymentProviderFor } from '../payments/index.js';
import { settleTask, UNKNOWN_OUTCOME_MAX_MS } from '../payments/settle.js';
import {
  loadTask, autoAcceptGate, afterAccept, logPaymentEvent, agentTarget, creatorTarget, sendWebhook, isoPlus,
} from '../tasks/service.js';

export interface TaskCronSummary {
  auto_accepted: number;
  settle_attempted: number;
  settled: number;
  expired: number;
  recovered: number;
  capped: number;
  settle_skipped_reason: string | null;
}

const BATCH = 50;

export async function runTaskCron(db: DBAdapter, env: Bindings, nowIso: string = new Date().toISOString()): Promise<TaskCronSummary> {
  const summary: TaskCronSummary = { auto_accepted: 0, settle_attempted: 0, settled: 0, expired: 0, recovered: 0, capped: 0, settle_skipped_reason: null };

  // 1. Auto-accept
  const due = await db.all<{ task_id: string }>(
    `SELECT task_id FROM tasks WHERE status = 'submitted' AND disputed_at IS NULL
       AND auto_release_at IS NOT NULL AND auto_release_at <= ? LIMIT ?`,
    nowIso, BATCH,
  );
  for (const { task_id } of due) {
    try {
      if (!(await autoAcceptGate(db, task_id, nowIso))) continue;
      const task = await loadTask(db, task_id);
      if (!task) continue;
      summary.auto_accepted++;
      await afterAccept(db, task, { acceptedBy: 'auto', by: { kind: 'auto' }, nowIso, paymentStatus: task.payment_status });
      if (task.bounty_amount) {
        await logPaymentEvent(db, task_id, 'auto_accepted', { payment_status: task.payment_status }, nowIso);
        const creator = await creatorTarget(db, task);
        sendWebhook(creator, { type: 'task.payment_due', agent_id: creator?.id ?? '', task_id, amount_atomic: task.bounty_amount });
      }
    } catch (err) {
      console.error(`[cron] auto-accept failed for ${task_id}:`, err);
    }
  }

  // 2. Settle retry
  if (!paymentProviderFor(env)) {
    summary.settle_skipped_reason = 'payments_disabled';
  } else {
    const rows = await db.all<{ task_id: string }>(
      `SELECT task_id FROM tasks WHERE status = 'verified' AND payment_status IN ('authorized','failed','settling')
         AND payment_signature IS NOT NULL AND settle_next_at IS NOT NULL AND settle_next_at <= ? LIMIT ?`,
      nowIso, BATCH,
    );
    for (const { task_id } of rows) {
      try {
        summary.settle_attempted++;
        const r = await settleTask(db, env, task_id, 'cron', nowIso);
        if (!r.skipped && r.payment_status === 'settled') summary.settled++;
      } catch (err) {
        console.error(`[cron] settle failed for ${task_id}:`, err);
      }
    }
  }

  // 3. Expiry sweep (never touches settling or broadcast rows)
  const stale = await db.all<{ task_id: string; payment_status: string }>(
    `SELECT task_id, payment_status FROM tasks WHERE payment_status IN ('authorized','failed') AND settle_broadcast = 0
       AND payment_expires_at IS NOT NULL AND payment_expires_at <= ? LIMIT ?`,
    nowIso, BATCH,
  );
  for (const row of stale) {
    try {
      const res = await db.run(
        `UPDATE tasks SET payment_status = 'expired', settle_next_at = NULL, last_settle_error = 'authorization_expired', last_settle_class = 'expired'
         WHERE task_id = ? AND payment_status = ? AND settle_broadcast = 0`,
        row.task_id, row.payment_status,
      );
      if (res.changes !== 1) continue;
      summary.expired++;
      await logPaymentEvent(db, row.task_id, 'expired', { reason: 'authorization_expired', trigger: 'cron' }, nowIso);
      const task = await loadTask(db, row.task_id);
      if (task) {
        for (const t of [await agentTarget(db, task.claimed_by_agent_id), await creatorTarget(db, task)]) {
          if (t) sendWebhook(t, { type: 'task.payment_failed', agent_id: t.id, task_id: task.task_id, reason: 'expired' });
        }
      }
    } catch (err) {
      console.error(`[cron] expiry sweep failed for ${row.task_id}:`, err);
    }
  }

  // 4. Crash recovery: a settle attempt that died leaves settling + settle_next_at NULL.
  const recovered = await db.run(
    `UPDATE tasks SET settle_next_at = ? WHERE payment_status = 'settling' AND settle_next_at IS NULL
       AND settle_started_at IS NOT NULL AND settle_started_at <= ?`,
    nowIso, isoPlus(nowIso, -10 * 60_000),
  );
  summary.recovered = recovered.changes;

  // 5. Unknown-outcome cap
  const capped = await db.all<{ task_id: string }>(
    `SELECT task_id FROM tasks WHERE settle_broadcast = 1 AND payment_status = 'failed' AND settle_next_at IS NOT NULL
       AND payment_expires_at IS NOT NULL AND payment_expires_at <= ? LIMIT ?`,
    isoPlus(nowIso, -UNKNOWN_OUTCOME_MAX_MS), BATCH,
  );
  for (const { task_id } of capped) {
    try {
      const res = await db.run(
        `UPDATE tasks SET settle_next_at = NULL, last_settle_error = 'unknown_outcome_manual', last_settle_class = 'unknown'
         WHERE task_id = ? AND payment_status = 'failed' AND settle_broadcast = 1 AND settle_next_at IS NOT NULL`,
        task_id,
      );
      if (res.changes !== 1) continue;
      summary.capped++;
      await logPaymentEvent(db, task_id, 'settle_failed', { error: 'unknown_outcome_manual', trigger: 'cron' }, nowIso);
      console.error(`[payments] ${task_id}: settlement outcome unknown 24h after expiry — manual reconciliation required`);
    } catch (err) {
      console.error(`[cron] unknown-outcome cap failed for ${task_id}:`, err);
    }
  }

  return summary;
}
