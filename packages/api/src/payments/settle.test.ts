/**
 * Unit tests for payments/settle.ts — the OUTCOME TABLE, the slot/broadcast
 * ordering and the race predicates. No HTTP: rows are seeded straight into
 * the in-memory DB exactly as the accept route leaves them after the T4-P gate
 * (status='verified', payment_status='authorized', settle_next_at=now).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, createTestAgent, type TestKeypair } from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import type { Bindings } from '../types/index.js';
import type { SettleOutcome } from './cdp-facilitator.js';
import { settleTask, applySettleOutcome, settleBackoffMs, type SettleTrigger } from './settle.js';
import { setPaymentProviderForTests } from './index.js';
import { encryptPaymentSignature } from './crypto.js';
import { buildRequirements, type PaymentRequirementsV2 } from './x402.js';
import { generatePublicId } from '../lib/ids.js';
import {
  enablePaymentsForTests, resetPaymentsForTests, paymentHeaderFor,
  TEST_WALLET, TEST_PAYER, TEST_TX, type FakeFacilitator,
} from './test-fixtures.js';
import { isoPlus, loadTask, type TaskRow } from '../tasks/service.js';

// Mock twitter
vi.mock('../lib/twitter.js', () => ({
  postTweet: vi.fn(),
  registrationTweet: vi.fn(() => 'mock tweet'),
  firstVerificationTweet: vi.fn(() => 'mock tweet'),
}));

// Mock skills resolver
vi.mock('../skills/resolver.js', () => ({
  resolveAllAgentSkills: vi.fn().mockResolvedValue({ updated: 0 }),
  computeSkillReputations: vi.fn().mockResolvedValue(undefined),
}));

const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

// Test encryption key (64 hex chars = 32 bytes)
const TEST_ENC_KEY = 'a'.repeat(64);
/** Injected clock: every "≈" assertion below is relative to this instant. */
const NOW = '2026-09-08T12:00:00.000Z';
const env = { PAYMENT_ENCRYPTION_KEY: TEST_ENC_KEY } as Bindings;

const DELIVERER_HOOK = 'https://deliverer.example.com/hook';
const CREATOR_HOOK = 'https://creator.example.com/hook';
const PRIOR_TX = '0x' + 'cd'.repeat(32);

describe('payments/settle.ts', () => {
  let db: SQLiteAdapter;
  let creator: TestKeypair & { name: string };
  let deliverer: TestKeypair & { name: string };

  beforeEach(async () => {
    db = setupTestDb();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    creator = await createTestAgent(db, { status: 'active', webhookUrl: CREATOR_HOOK });
    deliverer = await createTestAgent(db, { status: 'active', webhookUrl: DELIVERER_HOOK });
    await db.run('UPDATE agents SET wallet_address = ? WHERE id = ?', TEST_WALLET, deliverer.agentId);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetPaymentsForTests();
  });

  // ─── Helpers ───

  /** |actual − expected| ≤ tolMs (5 s by default). */
  function expectNear(actual: unknown, expectedIso: string, tolMs = 5_000): void {
    expect(typeof actual, `expected an ISO timestamp, got ${String(actual)}`).toBe('string');
    const delta = Math.abs(Date.parse(actual as string) - Date.parse(expectedIso));
    expect(delta, `${String(actual)} is ${delta}ms away from ${expectedIso}`).toBeLessThanOrEqual(tolMs);
  }

  /** Let fire-and-forget webhooks reach the fetch mock. */
  async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
  }

  /**
   * A verified task whose bounty was authorized at accept time, exactly as the
   * T4-P gate in routes/tasks.ts leaves it. `overrides` patch any column.
   */
  async function seedPaidTask(overrides: Partial<TaskRow> = {}): Promise<{ taskId: string; requirements: PaymentRequirementsV2 }> {
    const taskId = overrides.task_id ?? generatePublicId('task');
    const bountyAmount = overrides.bounty_amount ?? '5000000';
    const bountyNetwork = overrides.bounty_network ?? 'eip155:8453';
    const requirements = buildRequirements({ task_id: taskId, bounty_amount: bountyAmount, bounty_network: bountyNetwork }, TEST_WALLET);
    const row: Record<string, unknown> = {
      task_id: taskId,
      creator_agent_id: creator.agentId,
      creator_owner_id: null,
      creator_kind: 'agent',
      creator_assertion_id: null,
      claimed_by_agent_id: deliverer.agentId,
      title: 'Paid task',
      description: 'Settle me',
      category: 'research',
      required_capabilities: null,
      expected_output: null,
      output_format: 'json',
      status: 'verified',
      created_at: isoPlus(NOW, -3 * 60 * 60_000),
      claimed_at: isoPlus(NOW, -2 * 60 * 60_000),
      submitted_at: isoPlus(NOW, -60 * 60_000),
      verified_at: NOW,
      accepted_by: 'creator',
      review_note: null,
      review_assertion_id: null,
      revision_count: 0,
      revision_requested_at: null,
      disputed_at: null,
      cancelled_at: null,
      proposer_signature: null,
      acceptor_signature: null,
      bounty_amount: bountyAmount,
      bounty_token: 'USDC',
      bounty_network: bountyNetwork,
      payment_status: 'authorized',
      payment_signature: await encryptPaymentSignature(paymentHeaderFor(requirements), TEST_ENC_KEY),
      payment_requirements: JSON.stringify(requirements),
      payment_payer: TEST_PAYER,
      payment_nonce: null,
      payment_verified: 1,
      payment_settled: 0,
      payment_tx_hash: null,
      payment_expires_at: isoPlus(NOW, 60 * 60_000),
      auto_release_at: null,
      settle_attempts: 0,
      settle_broadcast: 0,
      settle_started_at: null,
      settle_next_at: NOW,
      settled_at: null,
      last_settle_error: null,
      ...overrides,
    };
    const cols = Object.keys(row);
    await db.run(
      `INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      ...cols.map((c) => row[c]),
    );
    return { taskId, requirements };
  }

  async function row(taskId: string): Promise<TaskRow> {
    return (await loadTask(db, taskId))!;
  }

  async function events(taskId: string): Promise<Array<{ event_type: string; details: Record<string, unknown> | null }>> {
    const rows = await db.all<{ event_type: string; details: string | null }>(
      'SELECT event_type, details FROM payment_events WHERE task_id = ? ORDER BY created_at ASC, rowid ASC', taskId,
    );
    return rows.map((r) => ({ event_type: r.event_type, details: r.details ? JSON.parse(r.details) as Record<string, unknown> : null }));
  }

  async function chainEntries(): Promise<Array<{ agent_id: string; entry_type: string }>> {
    return db.all<{ agent_id: string; entry_type: string }>('SELECT agent_id, entry_type FROM chain ORDER BY sequence ASC');
  }

  async function funnelRows(): Promise<Array<{ event: string; funnel_id: string | null; provider: string | null }>> {
    return db.all<{ event: string; funnel_id: string | null; provider: string | null }>('SELECT event, funnel_id, provider FROM funnel_events ORDER BY id ASC');
  }

  function webhookEvents(): Array<{ url: string; type: string; body: Record<string, unknown> }> {
    return mockFetch.mock.calls
      .filter((call: unknown[]) => typeof call[0] === 'string' && (call[1] as { body?: string } | undefined)?.body)
      .map((call: unknown[]) => {
        const body = JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
        return { url: call[0] as string, type: String(body.type), body };
      });
  }

  /**
   * Install a facilitator scripted with `outcome` (or one whose `settle`
   * throws), seed a row, run one settle attempt and return everything a test
   * needs. Asserts the invariant that settlement never writes `tasks.status`.
   */
  async function runWith(
    outcome: SettleOutcome | 'throw',
    seed: Partial<TaskRow> = {},
    trigger: SettleTrigger = 'accept',
  ) {
    const f: FakeFacilitator = enablePaymentsForTests(outcome === 'throw' ? {} : { settle: [outcome] });
    let calls = 0;
    if (outcome === 'throw') {
      f.settle = async () => { calls++; throw new Error('boom'); };
    }
    const { taskId, requirements } = await seedPaidTask(seed);
    const result = await settleTask(db, env, taskId, trigger, NOW);
    await flush();
    const after = await row(taskId);
    expect(after.status).toBe('verified'); // (g) settlement never touches tasks.status
    return { f, calls: outcome === 'throw' ? calls : f.settleCalls.length, taskId, requirements, result, row: after, events: await events(taskId) };
  }

  // ─── settleBackoffMs ───

  describe('settleBackoffMs', () => {
    it('doubles from 2 minutes and caps at 30', () => {
      const m = 60_000;
      expect(settleBackoffMs(0)).toBe(2 * m);
      expect(settleBackoffMs(1)).toBe(2 * m);
      expect(settleBackoffMs(2)).toBe(4 * m);
      expect(settleBackoffMs(3)).toBe(8 * m);
      expect(settleBackoffMs(4)).toBe(16 * m);
      expect(settleBackoffMs(5)).toBe(30 * m);
      expect(settleBackoffMs(6)).toBe(30 * m);
      expect(settleBackoffMs(50)).toBe(30 * m);
    });
  });

  // ─── The OUTCOME TABLE ───

  describe('outcome table', () => {
    it("{kind:'settled'} → settled row, `settled` event, chain entry for the deliverer, task_paid funnel, webhooks", async () => {
      const outcome: SettleOutcome = { kind: 'settled', transaction: TEST_TX, network: 'eip155:8453', payer: TEST_PAYER };
      const { result, row: r, events: ev, taskId, f, requirements } = await runWith(outcome);

      expect(result).toEqual({ skipped: false, payment_status: 'settled', tx_hash: TEST_TX, error: null, facilitator: outcome });
      expect(r).toMatchObject({
        payment_status: 'settled', payment_settled: 1, payment_tx_hash: TEST_TX, settled_at: NOW,
        settle_next_at: null, last_settle_error: null, settle_broadcast: 1, settle_attempts: 1, settle_started_at: NOW,
      });

      expect(ev.map((e) => e.event_type)).toEqual(['settled']);
      expect(ev[0].details).toEqual({ transaction: TEST_TX, network: 'eip155:8453', trigger: 'accept' });

      expect(await chainEntries()).toEqual([{ agent_id: deliverer.agentId, entry_type: 'task_payment_settled' }]);
      expect(await funnelRows()).toEqual([{ event: 'task_paid', funnel_id: taskId, provider: 'accept' }]);

      // The facilitator received the exact stored payload + requirements.
      expect(f.settleCalls).toHaveLength(1);
      expect(f.settleCalls[0].requirements).toEqual(requirements);
      expect(f.settleCalls[0].payload.accepted).toEqual(requirements);
      expect(f.settleCalls[0].payload.payload.authorization.to).toBe(TEST_WALLET);

      const hooks = webhookEvents();
      expect(hooks.map((h) => [h.url, h.type])).toEqual(expect.arrayContaining([
        [DELIVERER_HOOK, 'task.payment_settled'],
        [CREATOR_HOOK, 'task.payment_settled'],
      ]));
      const toDeliverer = hooks.find((h) => h.url === DELIVERER_HOOK)!;
      expect(toDeliverer.body).toEqual({
        type: 'task.payment_settled', agent_id: deliverer.agentId, task_id: taskId,
        payment_tx_hash: TEST_TX, amount_atomic: '5000000', network: 'eip155:8453',
      });
    });

    it('the cron trigger is recorded on the event and the funnel row', async () => {
      const { events: ev, taskId } = await runWith({ kind: 'settled', transaction: TEST_TX }, {}, 'cron');
      expect(ev[0].details).toMatchObject({ trigger: 'cron' });
      expect(await funnelRows()).toEqual([{ event: 'task_paid', funnel_id: taskId, provider: 'cron' }]);
    });

    it("{kind:'pending'} → stays settling with the tx stored, retry in 2 minutes, `settle_pending` event", async () => {
      const outcome: SettleOutcome = { kind: 'pending', transaction: TEST_TX };
      const { result, row: r, events: ev } = await runWith(outcome);

      expect(result).toEqual({ skipped: false, payment_status: 'settling', tx_hash: TEST_TX, error: 'settlement_pending', facilitator: outcome });
      expect(r).toMatchObject({
        payment_status: 'settling', payment_settled: 0, payment_tx_hash: TEST_TX, settled_at: null,
        last_settle_error: 'settlement_pending', settle_broadcast: 1, settle_attempts: 1,
      });
      expectNear(r.settle_next_at, isoPlus(NOW, 2 * 60_000));

      expect(ev.map((e) => e.event_type)).toEqual(['settle_pending']);
      expect(ev[0].details).toEqual({ transaction: TEST_TX, trigger: 'accept' });
      expect(await chainEntries()).toEqual([]);
      expect(await funnelRows()).toEqual([]);
      expect(webhookEvents()).toEqual([]);
    });

    it('rejected duplicate_settlement → settled (inferred) with the reported tx', async () => {
      const outcome: SettleOutcome = { kind: 'rejected', reason: 'duplicate_settlement', transaction: TEST_TX, http: 400 };
      const { result, row: r, events: ev, taskId } = await runWith(outcome);

      expect(result).toEqual({ skipped: false, payment_status: 'settled', tx_hash: TEST_TX, error: null, facilitator: outcome });
      expect(r).toMatchObject({ payment_status: 'settled', payment_settled: 1, payment_tx_hash: TEST_TX, settled_at: NOW, settle_next_at: null });
      expect(r.last_settle_error).toBe('settled_inferred_duplicate_settlement');
      expect(r.last_settle_error!.startsWith('settled_inferred_')).toBe(true);

      expect(ev.map((e) => e.event_type)).toEqual(['settled']);
      expect(ev[0].details).toMatchObject({ transaction: TEST_TX, inferred_from: 'duplicate_settlement' });
      expect(await chainEntries()).toEqual([{ agent_id: deliverer.agentId, entry_type: 'task_payment_settled' }]);
      expect(await funnelRows()).toEqual([{ event: 'task_paid', funnel_id: taskId, provider: 'accept' }]);
    });

    it('rejected duplicate_settlement without a tx keeps the tx recorded by an earlier pending answer', async () => {
      const outcome: SettleOutcome = { kind: 'rejected', reason: 'duplicate_settlement', http: 400 };
      const { result, row: r, events: ev } = await runWith(outcome, {
        payment_status: 'settling', payment_tx_hash: PRIOR_TX, settle_attempts: 1, settle_broadcast: 1, settle_next_at: NOW,
      });
      expect(result).toMatchObject({ skipped: false, payment_status: 'settled', tx_hash: PRIOR_TX });
      expect(r).toMatchObject({ payment_status: 'settled', payment_tx_hash: PRIOR_TX, settle_attempts: 2, last_settle_error: 'settled_inferred_duplicate_settlement' });
      expect(ev[0].details).toMatchObject({ transaction: PRIOR_TX, inferred_from: 'duplicate_settlement' });
    });

    it('rejected nonce_already_used on the FIRST attempt → terminal nonce_conflict (no retry, buyer notified)', async () => {
      const outcome: SettleOutcome = { kind: 'rejected', reason: 'invalid_exact_evm_nonce_already_used', http: 400 };
      const { result, row: r, events: ev, taskId } = await runWith(outcome);

      expect(result).toEqual({ skipped: false, payment_status: 'failed', tx_hash: null, error: 'nonce_conflict', facilitator: outcome });
      expect(r).toMatchObject({
        payment_status: 'failed', payment_settled: 0, settle_next_at: null, last_settle_error: 'nonce_conflict',
        settle_broadcast: 1, settle_attempts: 1, settled_at: null,
      });
      expect(ev.map((e) => e.event_type)).toEqual(['settle_failed']);
      expect(ev[0].details).toEqual({ error: 'nonce_conflict', retryable: false, trigger: 'accept' });
      expect(await chainEntries()).toEqual([]);
      expect(await funnelRows()).toEqual([]);

      const failed = webhookEvents().filter((h) => h.type === 'task.payment_failed');
      expect(failed.map((h) => h.url).sort()).toEqual([CREATOR_HOOK, DELIVERER_HOOK].sort());
      expect(failed[0].body).toMatchObject({ task_id: taskId, reason: 'nonce_conflict' });
    });

    it('rejected nonce_already_used on a SECOND attempt → settled (inferred nonce_used): it was our own landing', async () => {
      const outcome: SettleOutcome = { kind: 'rejected', reason: 'invalid_exact_evm_nonce_already_used', http: 400 };
      const { result, row: r, events: ev, taskId } = await runWith(outcome, {
        settle_attempts: 1, settle_broadcast: 1, payment_status: 'failed', settle_next_at: NOW,
        last_settle_error: 'settle_exact_evm_transaction_confirmation_timed_out',
      });

      expect(result).toEqual({ skipped: false, payment_status: 'settled', tx_hash: null, error: null, facilitator: outcome });
      expect(r).toMatchObject({
        payment_status: 'settled', payment_settled: 1, payment_tx_hash: null, settled_at: NOW, settle_next_at: null,
        last_settle_error: 'settled_inferred_nonce_used', settle_attempts: 2,
      });
      expect(ev.map((e) => e.event_type)).toEqual(['settled']);
      expect(ev[0].details).toMatchObject({ transaction: null, inferred_from: 'nonce_used' });
      expect(await chainEntries()).toEqual([{ agent_id: deliverer.agentId, entry_type: 'task_payment_settled' }]);
      expect(await funnelRows()).toEqual([{ event: 'task_paid', funnel_id: taskId, provider: 'accept' }]);
      expect(webhookEvents().map((h) => h.type)).toEqual(['task.payment_settled', 'task.payment_settled']);
    });

    it('rejected …authorization_valid_before → expired, no retry, `expired` event, payment_failed webhooks', async () => {
      const outcome: SettleOutcome = { kind: 'rejected', reason: 'invalid_exact_evm_payload_authorization_valid_before', http: 400 };
      const { result, row: r, events: ev, taskId } = await runWith(outcome);

      expect(result).toEqual({ skipped: false, payment_status: 'expired', tx_hash: null, error: 'authorization_expired', facilitator: outcome });
      expect(r).toMatchObject({ payment_status: 'expired', payment_settled: 0, settle_next_at: null, last_settle_error: 'authorization_expired', settle_broadcast: 1 });
      expect(ev.map((e) => e.event_type)).toEqual(['expired']);
      expect(ev[0].details).toEqual({ reason: 'authorization_expired', trigger: 'accept' });
      const failed = webhookEvents().filter((h) => h.type === 'task.payment_failed');
      expect(failed).toHaveLength(2);
      expect(failed[0].body).toMatchObject({ task_id: taskId, reason: 'expired' });
    });

    it('rejected insufficient_funds with the authorization far from expiry → failed, retry in 10 minutes', async () => {
      const outcome: SettleOutcome = { kind: 'rejected', reason: 'insufficient_funds', http: 400 };
      const { result, row: r, events: ev } = await runWith(outcome, { payment_expires_at: isoPlus(NOW, 60 * 60_000) });

      expect(result).toMatchObject({ skipped: false, payment_status: 'failed', error: 'insufficient_funds' });
      expect(r).toMatchObject({ payment_status: 'failed', last_settle_error: 'insufficient_funds', payment_settled: 0 });
      expectNear(r.settle_next_at, isoPlus(NOW, 10 * 60_000));
      expect(ev[0]).toEqual({ event_type: 'settle_failed', details: { error: 'insufficient_funds', retryable: true, trigger: 'accept' } });
      expect(webhookEvents().filter((h) => h.type === 'task.payment_failed').map((h) => h.body.reason)).toEqual(['insufficient_funds', 'insufficient_funds']);
    });

    it('rejected insufficient_funds with the authorization expiring within 15 minutes → failed, no retry', async () => {
      const outcome: SettleOutcome = { kind: 'rejected', reason: 'insufficient_funds', http: 400 };
      const { row: r, events: ev } = await runWith(outcome, { payment_expires_at: isoPlus(NOW, 10 * 60_000) });

      expect(r).toMatchObject({ payment_status: 'failed', last_settle_error: 'insufficient_funds', settle_next_at: null });
      expect(ev[0].details).toMatchObject({ retryable: false });
    });

    it('rejected …transaction_confirmation_timed_out → transient: retry after settleBackoffMs(1) = 2 minutes', async () => {
      const outcome: SettleOutcome = { kind: 'rejected', reason: 'settle_exact_evm_transaction_confirmation_timed_out', http: 400 };
      const { result, row: r, events: ev } = await runWith(outcome);

      expect(result).toMatchObject({ skipped: false, payment_status: 'failed', error: outcome.reason });
      expect(r).toMatchObject({ payment_status: 'failed', last_settle_error: outcome.reason, settle_attempts: 1, settle_broadcast: 1 });
      expectNear(r.settle_next_at, isoPlus(NOW, settleBackoffMs(1)));
      expectNear(r.settle_next_at, isoPlus(NOW, 2 * 60_000));
      expect(ev[0].details).toEqual({ error: outcome.reason, retryable: true, trigger: 'accept' });
      // Transient outcomes do not notify anyone.
      expect(webhookEvents()).toEqual([]);
    });

    it('…transaction_confirmation_timed_out on the second attempt → retry after settleBackoffMs(2) = 4 minutes', async () => {
      const outcome: SettleOutcome = { kind: 'rejected', reason: 'settle_exact_evm_transaction_confirmation_timed_out', http: 400 };
      const { row: r } = await runWith(outcome, { settle_attempts: 1, settle_broadcast: 1, payment_status: 'failed', settle_next_at: NOW });

      expect(r.settle_attempts).toBe(2);
      expectNear(r.settle_next_at, isoPlus(NOW, settleBackoffMs(2)));
      expectNear(r.settle_next_at, isoPlus(NOW, 4 * 60_000));
    });

    it('rejected …recipient_mismatch → terminal: failed with no retry, buyer notified', async () => {
      const outcome: SettleOutcome = { kind: 'rejected', reason: 'invalid_exact_evm_payload_recipient_mismatch', http: 400 };
      const { result, row: r, events: ev } = await runWith(outcome);

      expect(result).toMatchObject({ skipped: false, payment_status: 'failed', error: outcome.reason });
      expect(r).toMatchObject({ payment_status: 'failed', settle_next_at: null, last_settle_error: outcome.reason, payment_settled: 0 });
      expect(ev[0].details).toEqual({ error: outcome.reason, retryable: false, trigger: 'accept' });
      expect(webhookEvents().filter((h) => h.type === 'task.payment_failed')).toHaveLength(2);
    });

    it.each([
      ['billing', 'facilitator_billing', 60 * 60_000],
      ['auth', 'facilitator_auth', 60 * 60_000],
      ['rate_limited', 'facilitator_rate_limited', 5 * 60_000],
    ] as const)('unavailable %s → failed with last_settle_error=%s and retry in %ims', async (cause, error, delay) => {
      const outcome: SettleOutcome = { kind: 'unavailable', cause, http: 500, detail: `HTTP 500 ${cause}` };
      const { result, row: r, events: ev } = await runWith(outcome);

      expect(result).toMatchObject({ skipped: false, payment_status: 'failed', error });
      expect(r).toMatchObject({ payment_status: 'failed', last_settle_error: error, settle_broadcast: 1, settle_attempts: 1 });
      expectNear(r.settle_next_at, isoPlus(NOW, delay));
      expect(ev[0].details).toEqual({ error, retryable: true, trigger: 'accept' });
      // Our infrastructure trouble is never reported to the parties.
      expect(webhookEvents()).toEqual([]);
    });

    it.each(['network', 'server', 'malformed'] as const)('unavailable %s → transient backoff (2 minutes on the first attempt)', async (cause) => {
      const outcome: SettleOutcome = { kind: 'unavailable', cause, detail: `${cause} detail` };
      const { result, row: r, events: ev } = await runWith(outcome);

      const expectedError = `facilitator_${cause}: ${cause} detail`;
      expect(result).toMatchObject({ skipped: false, payment_status: 'failed', error: expectedError });
      expect(r).toMatchObject({ payment_status: 'failed', last_settle_error: expectedError });
      expectNear(r.settle_next_at, isoPlus(NOW, settleBackoffMs(1)));
      expect(ev[0].details).toMatchObject({ error: expectedError, retryable: true });
    });

    it('unavailable network on the third attempt → backoff settleBackoffMs(3) = 8 minutes', async () => {
      const { row: r } = await runWith(
        { kind: 'unavailable', cause: 'network', detail: 'ECONNRESET' },
        { settle_attempts: 2, settle_broadcast: 1, payment_status: 'failed', settle_next_at: NOW },
      );
      expect(r.settle_attempts).toBe(3);
      expectNear(r.settle_next_at, isoPlus(NOW, 8 * 60_000));
    });

    it('a facilitator whose settle() THROWS is treated as a transient network outage', async () => {
      const { result, row: r, events: ev, calls } = await runWith('throw');

      expect(calls).toBe(1);
      expect(result).toMatchObject({
        skipped: false, payment_status: 'failed', error: 'facilitator_network: Error: boom',
        facilitator: { kind: 'unavailable', cause: 'network', detail: 'Error: boom' },
      });
      expect(r).toMatchObject({ payment_status: 'failed', last_settle_error: 'facilitator_network: Error: boom', settle_broadcast: 1, settle_attempts: 1 });
      expectNear(r.settle_next_at, isoPlus(NOW, 2 * 60_000));
      expect(ev[0].details).toMatchObject({ error: 'facilitator_network: Error: boom', retryable: true });
    });
  });

  // ─── Ordering, slots and prechecks ───

  describe('slot claim and broadcast ordering', () => {
    it('(a) settle_broadcast=1 and payment_status=settling are committed BEFORE the facilitator is called', async () => {
      const f = enablePaymentsForTests();
      const { taskId } = await seedPaidTask();
      let seen: TaskRow | null = null;
      const original = f.settle.bind(f);
      f.settle = async (payload, requirements) => {
        seen = await row(taskId);
        return original(payload, requirements);
      };

      const result = await settleTask(db, env, taskId, 'accept', NOW);
      expect(result).toMatchObject({ skipped: false, payment_status: 'settled' });
      expect(seen).not.toBeNull();
      expect(seen!).toMatchObject({
        payment_status: 'settling', settle_broadcast: 1, settle_attempts: 1, settle_started_at: NOW, settle_next_at: null,
        payment_settled: 0, payment_tx_hash: null, status: 'verified',
      });
    });

    it('(b) two concurrent settleTask calls on one row → one facilitator call, one winner, one not_due', async () => {
      const f = enablePaymentsForTests();
      const { taskId } = await seedPaidTask();

      const results = await Promise.all([
        settleTask(db, env, taskId, 'accept', NOW),
        settleTask(db, env, taskId, 'cron', NOW),
      ]);

      expect(f.settleCalls).toHaveLength(1);
      const winners = results.filter((r) => !r.skipped);
      const losers = results.filter((r) => r.skipped);
      expect(winners).toHaveLength(1);
      expect(winners[0]).toMatchObject({ payment_status: 'settled', tx_hash: TEST_TX });
      expect(losers).toEqual([{ skipped: true, reason: 'not_due' }]);

      const r = await row(taskId);
      expect(r).toMatchObject({ payment_status: 'settled', settle_attempts: 1 });
      expect((await events(taskId)).map((e) => e.event_type)).toEqual(['settled']);
      expect(await chainEntries()).toHaveLength(1);
    });

    it('(c) a row whose settle_next_at is in the future → not_due, no facilitator call, row untouched', async () => {
      const f = enablePaymentsForTests();
      const { taskId } = await seedPaidTask({ settle_next_at: isoPlus(NOW, 60_000) });

      const result = await settleTask(db, env, taskId, 'cron', NOW);

      expect(result).toEqual({ skipped: true, reason: 'not_due' });
      expect(f.settleCalls).toHaveLength(0);
      expect(await row(taskId)).toMatchObject({
        payment_status: 'authorized', settle_attempts: 0, settle_broadcast: 0, settle_started_at: null,
        settle_next_at: isoPlus(NOW, 60_000), status: 'verified',
      });
      expect(await events(taskId)).toEqual([]);
    });

    it('(c′) a row with settle_next_at NULL (terminal) is never picked up', async () => {
      const f = enablePaymentsForTests();
      const { taskId } = await seedPaidTask({ payment_status: 'failed', settle_next_at: null, last_settle_error: 'invalid_exact_evm_payload_signature', settle_attempts: 1, settle_broadcast: 1 });
      expect(await settleTask(db, env, taskId, 'cron', NOW)).toEqual({ skipped: true, reason: 'not_due' });
      expect(f.settleCalls).toHaveLength(0);
      expect((await row(taskId)).settle_attempts).toBe(1);
    });

    it('(d) expiry precheck: an un-broadcast authorization expiring within 30 s is expired without a facilitator call', async () => {
      const f = enablePaymentsForTests();
      const { taskId } = await seedPaidTask({ payment_expires_at: isoPlus(NOW, 20_000) });

      const result = await settleTask(db, env, taskId, 'accept', NOW);
      await flush();

      expect(result).toEqual({ skipped: true, reason: 'expired' });
      expect(f.settleCalls).toHaveLength(0);
      expect(await row(taskId)).toMatchObject({
        payment_status: 'expired', settle_next_at: null, last_settle_error: 'authorization_expired',
        settle_attempts: 0, settle_broadcast: 0, settle_started_at: null, status: 'verified',
      });
      const ev = await events(taskId);
      expect(ev).toEqual([{ event_type: 'expired', details: { reason: 'authorization_expired', trigger: 'settle' } }]);
      const failed = webhookEvents().filter((h) => h.type === 'task.payment_failed');
      expect(failed.map((h) => h.url).sort()).toEqual([CREATOR_HOOK, DELIVERER_HOOK].sort());
      expect(failed[0].body).toMatchObject({ task_id: taskId, reason: 'expired' });
    });

    it('(d′) the precheck also covers a `failed` un-broadcast row', async () => {
      const f = enablePaymentsForTests();
      const { taskId } = await seedPaidTask({
        payment_status: 'failed', settle_attempts: 1, settle_broadcast: 0, last_settle_error: 'payments_not_configured',
        payment_expires_at: isoPlus(NOW, -1_000),
      });
      expect(await settleTask(db, env, taskId, 'cron', NOW)).toEqual({ skipped: true, reason: 'expired' });
      expect(f.settleCalls).toHaveLength(0);
      expect((await row(taskId)).payment_status).toBe('expired');
    });

    it('(d″) a BROADCAST row past its expiry is never pre-expired: only the facilitator may resolve it (N11)', async () => {
      const f = enablePaymentsForTests({ settle: [{ kind: 'settled', transaction: TEST_TX }] });
      const { taskId } = await seedPaidTask({
        payment_status: 'failed', settle_attempts: 1, settle_broadcast: 1, settle_next_at: NOW,
        last_settle_error: 'settle_exact_evm_transaction_confirmation_timed_out',
        payment_expires_at: isoPlus(NOW, -60 * 60_000),
      });

      const result = await settleTask(db, env, taskId, 'cron', NOW);

      expect(f.settleCalls).toHaveLength(1);
      expect(result).toMatchObject({ skipped: false, payment_status: 'settled' });
      expect(await row(taskId)).toMatchObject({ payment_status: 'settled', settle_attempts: 2 });
    });

    it('(e) no provider (setPaymentProviderForTests(null)) → failed payments_not_configured, retry in 1 hour, slot consumed', async () => {
      setPaymentProviderForTests(null);
      const { taskId } = await seedPaidTask();

      const result = await settleTask(db, env, taskId, 'cron', NOW);

      expect(result).toEqual({ skipped: false, payment_status: 'failed', tx_hash: null, error: 'payments_not_configured', facilitator: null });
      const r = await row(taskId);
      expect(r).toMatchObject({
        payment_status: 'failed', last_settle_error: 'payments_not_configured', settle_attempts: 1, settle_started_at: NOW,
        settle_broadcast: 0, status: 'verified',
      });
      expectNear(r.settle_next_at, isoPlus(NOW, 60 * 60_000));
      expect(await events(taskId)).toEqual([{ event_type: 'settle_failed', details: { error: 'payments_not_configured', trigger: 'cron' } }]);
      expect(webhookEvents()).toEqual([]);
    });

    it('(e′) a provider without PAYMENT_ENCRYPTION_KEY in env is also payments_not_configured', async () => {
      const f = enablePaymentsForTests();
      const { taskId } = await seedPaidTask();
      const result = await settleTask(db, {} as Bindings, taskId, 'accept', NOW);
      expect(result).toMatchObject({ skipped: false, payment_status: 'failed', error: 'payments_not_configured' });
      expect(f.settleCalls).toHaveLength(0);
      expect((await row(taskId)).settle_broadcast).toBe(0);
    });

    it('(f) an unreadable stored payload → failed stored_payload_unreadable, terminal, never broadcast', async () => {
      const f = enablePaymentsForTests();
      const { taskId } = await seedPaidTask({ payment_signature: 'garbage' });

      const result = await settleTask(db, env, taskId, 'accept', NOW);

      expect(result).toEqual({ skipped: false, payment_status: 'failed', tx_hash: null, error: 'stored_payload_unreadable', facilitator: null });
      expect(f.settleCalls).toHaveLength(0);
      expect(await row(taskId)).toMatchObject({
        payment_status: 'failed', settle_next_at: null, last_settle_error: 'stored_payload_unreadable',
        settle_broadcast: 0, settle_attempts: 1, status: 'verified',
      });
      const ev = await events(taskId);
      expect(ev).toHaveLength(1);
      expect(ev[0].event_type).toBe('settle_failed');
      expect(String(ev[0].details!.error).startsWith('stored_payload_unreadable')).toBe(true);
      expect(ev[0].details!.trigger).toBe('accept');
    });

    it('(f′) stored requirements that no longer parse → stored_payload_unreadable as well', async () => {
      const f = enablePaymentsForTests();
      const { taskId } = await seedPaidTask({ payment_requirements: '{"scheme":"exact"}' });
      const result = await settleTask(db, env, taskId, 'accept', NOW);
      expect(result).toMatchObject({ skipped: false, payment_status: 'failed', error: 'stored_payload_unreadable' });
      expect(f.settleCalls).toHaveLength(0);
      expect((await row(taskId)).settle_next_at).toBeNull();
    });

    it('(f″) a missing stored payload (NULL signature) → stored_payload_unreadable', async () => {
      enablePaymentsForTests();
      const { taskId } = await seedPaidTask({ payment_signature: null });
      expect(await settleTask(db, env, taskId, 'cron', NOW)).toMatchObject({ skipped: false, error: 'stored_payload_unreadable' });
    });

    it('(g) a settled row is never re-settled: skipped not_due, no facilitator call, nothing rewritten', async () => {
      const f = enablePaymentsForTests();
      const settledAt = isoPlus(NOW, -10 * 60_000);
      const { taskId } = await seedPaidTask({
        payment_status: 'settled', payment_settled: 1, payment_tx_hash: PRIOR_TX, settled_at: settledAt,
        settle_attempts: 1, settle_broadcast: 1, settle_next_at: NOW,
      });

      const result = await settleTask(db, env, taskId, 'cron', NOW);

      expect(result).toEqual({ skipped: true, reason: 'not_due' });
      expect(f.settleCalls).toHaveLength(0);
      expect(await row(taskId)).toMatchObject({
        payment_status: 'settled', payment_settled: 1, payment_tx_hash: PRIOR_TX, settled_at: settledAt, settle_attempts: 1, status: 'verified',
      });
      expect(await events(taskId)).toEqual([]);
    });

    it("(g′) the slot requires status='verified': a submitted row with a due settle_next_at is not_due", async () => {
      const f = enablePaymentsForTests();
      const { taskId } = await seedPaidTask({ status: 'submitted', verified_at: null, accepted_by: null });
      expect(await settleTask(db, env, taskId, 'cron', NOW)).toEqual({ skipped: true, reason: 'not_due' });
      expect(f.settleCalls).toHaveLength(0);
      expect(await row(taskId)).toMatchObject({ status: 'submitted', payment_status: 'authorized', settle_attempts: 0 });
    });

    it('an unknown task id → no_row', async () => {
      enablePaymentsForTests();
      expect(await settleTask(db, env, 'task_doesnotexist', 'cron', NOW)).toEqual({ skipped: true, reason: 'no_row' });
    });

    it('a facilitator answer that lands AFTER a competing writer resolved the row → not_due, nothing rewritten', async () => {
      const f = enablePaymentsForTests();
      const { taskId } = await seedPaidTask();
      f.settle = async () => {
        // Someone else (e.g. a crash-recovery + second cron tick) resolved the row meanwhile.
        await db.run(`UPDATE tasks SET payment_status = 'expired', settle_next_at = NULL WHERE task_id = ?`, taskId);
        return { kind: 'settled', transaction: TEST_TX };
      };
      const result = await settleTask(db, env, taskId, 'accept', NOW);
      expect(result).toEqual({ skipped: true, reason: 'not_due' });
      expect(await row(taskId)).toMatchObject({ payment_status: 'expired', payment_settled: 0, payment_tx_hash: null });
      expect(await events(taskId)).toEqual([]);
      expect(await chainEntries()).toEqual([]);
    });
  });

  // ─── applySettleOutcome: every write is predicated on payment_status = 'settling' ───

  describe('applySettleOutcome predicate', () => {
    const outcomes: Array<[string, SettleOutcome]> = [
      ['settled', { kind: 'settled', transaction: TEST_TX }],
      ['pending', { kind: 'pending', transaction: TEST_TX }],
      ['rejected duplicate', { kind: 'rejected', reason: 'duplicate_settlement', http: 400 }],
      ['rejected nonce_used', { kind: 'rejected', reason: 'invalid_exact_evm_nonce_already_used', http: 400 }],
      ['rejected expired', { kind: 'rejected', reason: 'invalid_exact_evm_payload_authorization_valid_before', http: 400 }],
      ['rejected insufficient', { kind: 'rejected', reason: 'insufficient_funds', http: 400 }],
      ['rejected terminal', { kind: 'rejected', reason: 'invalid_exact_evm_payload_signature', http: 400 }],
      ['rejected transient', { kind: 'rejected', reason: 'settle_exact_evm_transaction_confirmation_timed_out', http: 400 }],
      ['unavailable billing', { kind: 'unavailable', cause: 'billing', detail: 'x' }],
      ['unavailable network', { kind: 'unavailable', cause: 'network', detail: 'x' }],
    ];

    it.each(outcomes)('%s on a row that is not `settling` → not_due and no write, event, chain or webhook', async (_label, outcome) => {
      const { taskId } = await seedPaidTask({ payment_status: 'authorized', settle_attempts: 1 });
      const before = await row(taskId);

      const result = await applySettleOutcome(db, before, outcome, 'cron', NOW);
      await flush();

      expect(result).toEqual({ skipped: true, reason: 'not_due' });
      expect(await row(taskId)).toEqual(before);
      expect(await events(taskId)).toEqual([]);
      expect(await chainEntries()).toEqual([]);
      expect(await funnelRows()).toEqual([]);
      expect(webhookEvents()).toEqual([]);
    });

    it('applies the settled branch directly to a `settling` row (the shape the accept route hands it)', async () => {
      const { taskId } = await seedPaidTask({ payment_status: 'settling', settle_attempts: 1, settle_broadcast: 1, settle_started_at: NOW, settle_next_at: null });
      const task = await row(taskId);
      const result = await applySettleOutcome(db, task, { kind: 'settled', transaction: TEST_TX }, 'accept', NOW);
      expect(result).toMatchObject({ skipped: false, payment_status: 'settled', tx_hash: TEST_TX });
      expect(await row(taskId)).toMatchObject({ payment_status: 'settled', payment_settled: 1, settled_at: NOW, status: 'verified' });
    });
  });
});
