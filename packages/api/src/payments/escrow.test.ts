/**
 * Escrow (Tasks P1) over HTTP with the fake facilitator and a real house
 * key: post (402 → deposit → funded) → claim → deliver → accept (house-signed
 * release) / cancel (house-signed refund), the failure branches, the opt-out,
 * and the fail-closed switch.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setupTestDb, createTestApp, createTestAgent, signRequest, type TestKeypair } from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import {
  enablePaymentsForTests, disablePaymentsForTests, resetPaymentsForTests, paymentHeaderFor, paymentPayloadFor,
  TEST_WALLET, TEST_PAYER, TEST_TX, type FakeFacilitator,
} from './test-fixtures.js';
import { encodeB64Json, type PaymentRequirementsV2 } from './x402.js';
import {
  houseWalletFromPrivateKey, parseHousePrivateKey, recoverAuthorizationSigner, setHouseWalletForTests,
} from './house-wallet.js';
import { ESCROW_MAX_LEG_ATTEMPTS } from './escrow.js';
import { runTaskCron } from '../cron/tasks.js';
import { drainOutbox } from '../events/service.js';
import { isoPlus, REVIEW_WINDOW_MS } from '../tasks/service.js';
import type { Bindings } from '../types/index.js';

vi.mock('../lib/twitter.js', () => ({
  postTweet: vi.fn(),
  registrationTweet: vi.fn(() => 'mock tweet'),
  firstVerificationTweet: vi.fn(() => 'mock tweet'),
}));
vi.mock('../skills/resolver.js', () => ({
  resolveAllAgentSkills: vi.fn().mockResolvedValue({ updated: 0 }),
  computeSkillReputations: vi.fn().mockResolvedValue(undefined),
}));

const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

/** Hardhat account #0 — a public test key. */
const HOUSE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const HOUSE_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const house = houseWalletFromPrivateKey(parseHousePrivateKey(HOUSE_KEY));
const REFUND_TX = '0x' + 'ef'.repeat(32);
const RELEASE_TX = '0x' + '12'.repeat(32);
const ENV: Partial<Bindings> = { PAYMENT_ENCRYPTION_KEY: 'a'.repeat(64) };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('Escrow (Tasks P1)', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;
  let creator: TestKeypair & { name: string };
  let claimer: TestKeypair & { name: string };
  let facilitator: FakeFacilitator;

  beforeEach(async () => {
    db = setupTestDb();
    app = createTestApp(db, ENV);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);
    facilitator = enablePaymentsForTests();
    setHouseWalletForTests(house);
    creator = await createTestAgent(db, { status: 'active', capabilities: ['research'], webhookUrl: 'https://creator.example.com/hook' });
    claimer = await createTestAgent(db, { status: 'active', capabilities: ['code', 'research'], webhookUrl: 'https://claimer.example.com/hook' });
    await db.run('UPDATE agents SET wallet_address = ? WHERE id = ?', TEST_WALLET, claimer.agentId);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetPaymentsForTests();
    setHouseWalletForTests(undefined);
  });

  // ─── Helpers ───

  async function signedPost(agent: TestKeypair, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers = await signRequest(agent, 'POST', path, text);
    return app.request(path, {
      method: 'POST',
      headers: { ...(text ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders, ...headers },
      body: text,
    });
  }

  const TASK_BODY = {
    title: 'Escrowed research', description: 'Research something for 5 USDC', category: 'research',
    required_capabilities: ['research'], bounty: { amount: '5000000', token: 'USDC', network: 'eip155:8453' },
  };

  /** POST without a header → the 402 challenge (payTo = house). */
  async function challenge(body: Json = TASK_BODY): Promise<{ res: Response; requirements: PaymentRequirementsV2; json: Json }> {
    const res = await signedPost(creator, '/v1/tasks', body);
    const json = await res.json() as Json;
    return { res, requirements: json.accepts?.[0], json };
  }

  /** The full post: 402, sign the deposit, retry → a funded task. */
  async function postFunded(body: Json = TASK_BODY): Promise<{ taskId: string; json: Json; res: Response }> {
    const { res: first, requirements } = await challenge(body);
    expect(first.status).toBe(402);
    const res = await signedPost(creator, '/v1/tasks', body, { 'PAYMENT-SIGNATURE': paymentHeaderFor(requirements) });
    const json = await res.json() as Json;
    return { taskId: json.task_id, json, res };
  }

  async function claimAndDeliver(taskId: string): Promise<void> {
    const claim = await signedPost(claimer, `/v1/tasks/${taskId}/claim`);
    expect(claim.status).toBe(200);
    const deliver = await signedPost(claimer, `/v1/tasks/${taskId}/deliver`, { summary: 'Done', submission_type: 'json', submission_content: '{"r":1}' });
    expect(deliver.status).toBe(200);
  }

  async function row(taskId: string): Promise<Json> {
    return (await db.get<Json>('SELECT * FROM tasks WHERE task_id = ?', taskId))!;
  }

  async function eventTypes(taskId: string): Promise<string[]> {
    const rows = await db.all<{ event_type: string }>('SELECT event_type FROM payment_events WHERE task_id = ? ORDER BY created_at ASC, rowid ASC', taskId);
    return rows.map((r) => r.event_type);
  }

  async function inboxTypes(agentId: string): Promise<string[]> {
    const rows = await db.all<{ type: string }>('SELECT type FROM agent_events WHERE agent_id = ? ORDER BY seq', agentId);
    return rows.map((r) => r.type);
  }

  // ─── Posting ───

  describe('POST /v1/tasks with a bounty', () => {
    it('answers 402 with the house wallet as payTo and writes nothing', async () => {
      const { res, requirements, json } = await challenge();
      expect(res.status).toBe(402);
      expect(res.headers.get('PAYMENT-REQUIRED')).toBeTruthy();
      expect(json.error).toBe('payment_required');
      expect(json.escrow).toEqual({ wallet: HOUSE_ADDR });
      expect(json.fund_endpoint).toBe('POST /v1/tasks');
      expect(json.resource.url).toBe('https://api.basedagents.ai/v1/tasks');
      expect(requirements.payTo).toBe(HOUSE_ADDR);
      expect(requirements.amount).toBe('5000000');
      expect(requirements.network).toBe('eip155:8453');
      expect(json.task_id).toBeUndefined();
      expect(await db.get('SELECT count(*) AS n FROM tasks')).toEqual({ n: 0 });
      expect(facilitator.verifyCalls).toHaveLength(0);
    });

    it('with the signed deposit: verifies, creates the task, settles the deposit into escrow, funded + claimable', async () => {
      const { res, json, taskId } = await postFunded();
      expect(res.status).toBe(200);
      expect(json.status).toBe('open');
      expect(json.payment_status).toBe('pending');
      expect(json.claimable).toBe(true);
      expect(json.escrow.status).toBe('funded');
      expect(json.escrow.wallet).toBe(HOUSE_ADDR);
      expect(json.escrow.deposit_tx_hash).toBe(TEST_TX);
      expect(json.deposit_tx_hash).toBe(TEST_TX);
      expect(json.bounty.amount_display).toBe('5.00');
      expect(res.headers.get('PAYMENT-RESPONSE')).toBeTruthy();

      expect(facilitator.verifyCalls).toHaveLength(1);
      expect(facilitator.settleCalls).toHaveLength(1);
      expect(facilitator.settleCalls[0].requirements.payTo).toBe(HOUSE_ADDR);

      const r = await row(taskId);
      expect(r.escrow).toBe(1);
      expect(r.escrow_status).toBe('funded');
      expect(r.escrow_leg).toBeNull();
      expect(r.escrow_wallet).toBe(HOUSE_ADDR);
      expect(r.escrow_deposit_payer).toBe(TEST_PAYER);
      expect(r.escrow_deposit_tx_hash).toBe(TEST_TX);
      expect(r.escrow_deposit_nonce).toMatch(/^0x[0-9a-f]{64}$/);
      // The payment columns are cleared for the payout leg; the deposit's secret never lingers.
      expect(r.payment_signature).toBeNull();
      expect(r.payment_nonce).toBeNull();
      expect(r.payment_tx_hash).toBeNull();
      expect(r.payment_status).toBe('pending');
      expect(await eventTypes(taskId)).toEqual(['bounty_declared', 'escrow_deposit_authorized', 'escrow_funded']);
      // Matching agents are advertised only now that it is claimable; the creator learns it landed.
      expect(await inboxTypes(claimer.agentId)).toEqual(['task.available']);
      expect(await inboxTypes(creator.agentId)).toEqual(['task.escrow_funded']);
    });

    it('public reads expose the escrow record but never the deposit nonce or payer', async () => {
      const { taskId } = await postFunded();
      const detail = await (await app.request(`/v1/tasks/${taskId}`)).json() as Json;
      expect(detail.task.escrow).toMatchObject({ status: 'funded', wallet: HOUSE_ADDR, deposit_tx_hash: TEST_TX });
      expect(detail.task.claimable).toBe(true);
      expect(detail.task.payment_due).toBe(false);
      expect(detail.task.escrow_deposit_nonce).toBeUndefined();
      expect(detail.task.escrow_deposit_payer).toBeUndefined();
      expect(detail.task.escrow_wallet).toBeUndefined();
      expect(detail.payment.escrow.status).toBe('funded');
      const list = await (await app.request('/v1/tasks')).json() as Json;
      expect(list.tasks[0].escrow.status).toBe('funded');

      const pay = await (await app.request(`/v1/tasks/${taskId}/payment`)).json() as Json;
      expect(pay.requirements).toBeNull();
      expect(pay.requirements_unavailable_reason).toBe('escrow_held');
      expect(pay.fund_endpoint).toBe(`POST /v1/tasks/${taskId}/fund`);
    });

    it('a deposit nonce is spent once: the same header again → 409 authorization_reused naming the task', async () => {
      const { requirements } = await challenge();
      const header = paymentHeaderFor(requirements);
      const first = await signedPost(creator, '/v1/tasks', TASK_BODY, { 'PAYMENT-SIGNATURE': header });
      expect(first.status).toBe(200);
      const { task_id } = await first.json() as Json;
      const again = await signedPost(creator, '/v1/tasks', TASK_BODY, { 'PAYMENT-SIGNATURE': header });
      expect(again.status).toBe(409);
      const body = await again.json() as Json;
      expect(body.error).toBe('authorization_reused');
      expect(body.task_id).toBe(task_id);
      expect(await db.get('SELECT count(*) AS n FROM tasks')).toEqual({ n: 1 });
    });

    it('a deposit signed to the wrong recipient or amount → 402 payment_invalid, nothing written', async () => {
      const { requirements } = await challenge();
      const wrongTo = paymentHeaderFor(requirements, undefined, { authorization: { to: TEST_WALLET } });
      const res = await signedPost(creator, '/v1/tasks', TASK_BODY, { 'PAYMENT-SIGNATURE': wrongTo });
      expect(res.status).toBe(402);
      expect((await res.json() as Json).reason).toBe('recipient_mismatch');
      const wrongAmount = paymentHeaderFor(requirements, undefined, { authorization: { value: '4000000' } });
      const res2 = await signedPost(creator, '/v1/tasks', TASK_BODY, { 'PAYMENT-SIGNATURE': wrongAmount });
      expect((await res2.json() as Json).reason).toBe('amount_mismatch');
      expect(await db.get('SELECT count(*) AS n FROM tasks')).toEqual({ n: 0 });
      expect(facilitator.verifyCalls).toHaveLength(0);
    });

    it('a malformed header → 400; facilitator invalid → 402 with the payer; unavailable → 503; nothing written', async () => {
      const { requirements } = await challenge();
      expect((await signedPost(creator, '/v1/tasks', TASK_BODY, { 'PAYMENT-SIGNATURE': '!!' })).status).toBe(400);
      facilitator.verifyOutcomes = [{ kind: 'invalid', reason: 'insufficient_funds', payer: TEST_PAYER, http: 200 }];
      const r1 = await signedPost(creator, '/v1/tasks', TASK_BODY, { 'PAYMENT-SIGNATURE': paymentHeaderFor(requirements) });
      expect(r1.status).toBe(402);
      expect((await r1.json() as Json).error).toBe('insufficient_funds');
      facilitator.verifyOutcomes = [{ kind: 'unavailable', cause: 'server', detail: 'boom' }];
      const r2 = await signedPost(creator, '/v1/tasks', TASK_BODY, { 'PAYMENT-SIGNATURE': paymentHeaderFor(requirements) });
      expect(r2.status).toBe(503);
      expect(await db.get('SELECT count(*) AS n FROM tasks')).toEqual({ n: 0 });
    });

    it('a deposit that settles slowly leaves the task open but NOT claimable; the cron finishes it', async () => {
      facilitator.settleOutcomes = [{ kind: 'unavailable', cause: 'network', detail: 'timeout' }];
      const { res, json, taskId } = await postFunded();
      expect(res.status).toBe(200);
      expect(json.status).toBe('open');
      expect(json.claimable).toBe(false);
      expect(json.escrow.status).toBe('funding');
      expect(json.payment_status).toBe('failed');
      expect(json.settle_error).toMatch(/facilitator_network/);

      const claim = await signedPost(claimer, `/v1/tasks/${taskId}/claim`);
      expect(claim.status).toBe(409);
      expect((await claim.json() as Json).error).toBe('escrow_not_funded');
      // Not advertised yet either.
      expect(await inboxTypes(claimer.agentId)).toEqual([]);
      const pay = await (await app.request(`/v1/tasks/${taskId}/payment`)).json() as Json;
      expect(pay.requirements_unavailable_reason).toBe('escrow_funding');

      // The retry is due after the 2-minute backoff; the cron settles the same deposit (no new signature).
      facilitator.settleOutcomes = [];
      const r1 = await row(taskId);
      const summary = await runTaskCron(db, ENV as Bindings, isoPlus(r1.settle_next_at as string, 1000));
      expect(summary.settle_attempted).toBe(1);
      expect(facilitator.settleCalls).toHaveLength(2);
      const r2 = await row(taskId);
      expect(r2.escrow_status).toBe('funded');
      expect(r2.escrow_deposit_tx_hash).toBe(TEST_TX);
      expect(await inboxTypes(claimer.agentId)).toEqual(['task.available']);
      expect((await signedPost(claimer, `/v1/tasks/${taskId}/claim`)).status).toBe(200);
    });

    it('a deposit the chain rejects for good → unfunded; the buyer can cancel, or fund again via POST /fund', async () => {
      facilitator.settleOutcomes = [{ kind: 'rejected', reason: 'invalid_exact_evm_payload_signature', http: 200 }];
      const { taskId, json } = await postFunded();
      expect(json.escrow.status).toBe('unfunded');
      expect(json.payment_status).toBe('failed');
      let r = await row(taskId);
      expect(r.escrow_status).toBe('unfunded');
      expect(r.settle_next_at).toBeNull();

      // The requirements to sign again are served, payTo = house.
      const pay = await (await app.request(`/v1/tasks/${taskId}/payment`)).json() as Json;
      expect(pay.requirements.payTo).toBe(HOUSE_ADDR);
      expect(pay.payment_required.resource.url).toBe(`https://api.basedagents.ai/v1/tasks/${taskId}/fund`);

      // /fund: 402 without a header, then a fresh deposit funds it.
      const c1 = await signedPost(creator, `/v1/tasks/${taskId}/fund`);
      expect(c1.status).toBe(402);
      expect((await c1.json() as Json).task_id).toBe(taskId);
      facilitator.settleOutcomes = [];
      const c2 = await signedPost(creator, `/v1/tasks/${taskId}/fund`, undefined, { 'PAYMENT-SIGNATURE': paymentHeaderFor(pay.requirements) });
      expect(c2.status).toBe(200);
      expect((await c2.json() as Json).escrow.status).toBe('funded');
      r = await row(taskId);
      expect(r.escrow_status).toBe('funded');
      expect(await eventTypes(taskId)).toEqual([
        'bounty_declared', 'escrow_deposit_authorized', 'settle_failed', 'escrow_deposit_authorized', 'escrow_funded',
      ]);
      // Only the creator may fund; a funded task cannot be funded twice.
      expect((await signedPost(claimer, `/v1/tasks/${taskId}/fund`)).status).toBe(403);
      expect((await signedPost(creator, `/v1/tasks/${taskId}/fund`)).status).toBe(409);
    });

    it('cancelling an unfunded escrow task voids it with nothing to refund', async () => {
      facilitator.settleOutcomes = [{ kind: 'rejected', reason: 'invalid_exact_evm_payload_signature', http: 200 }];
      const { taskId } = await postFunded();
      const res = await signedPost(creator, `/v1/tasks/${taskId}/cancel`);
      expect(res.status).toBe(200);
      const body = await res.json() as Json;
      expect(body.payment_status).toBe('expired');
      expect(body.escrow.status).toBe('unfunded');
      expect(facilitator.settleCalls).toHaveLength(1); // no refund leg
    });

    it('cancelling while the deposit is still moving in is refused (payment_in_flight)', async () => {
      facilitator.settleOutcomes = [{ kind: 'pending', transaction: TEST_TX }];
      const { taskId, json } = await postFunded();
      expect(json.escrow.status).toBe('funding');
      const res = await signedPost(creator, `/v1/tasks/${taskId}/cancel`);
      expect(res.status).toBe(409);
      expect((await res.json() as Json).error).toBe('payment_in_flight');
    });

    it('escrow: false keeps the sign-at-accept flow (no header expected, nothing deposited)', async () => {
      const res = await signedPost(creator, '/v1/tasks', { ...TASK_BODY, escrow: false });
      expect(res.status).toBe(200);
      const json = await res.json() as Json;
      expect(json.payment_status).toBe('pending');
      expect(json.escrow).toBeNull();
      expect(json.claimable).toBe(true);
      expect((await row(json.task_id)).escrow).toBe(0);
      const withHeader = await signedPost(creator, '/v1/tasks', { ...TASK_BODY, escrow: false }, { 'PAYMENT-SIGNATURE': 'x' });
      expect(withHeader.status).toBe(400);
      expect((await withHeader.json() as Json).error).toBe('payment_not_expected');
    });

    it('without a house wallet: escrow omitted falls back to sign-at-accept; escrow: true → 503 escrow_unavailable', async () => {
      setHouseWalletForTests(null);
      const fallback = await signedPost(creator, '/v1/tasks', TASK_BODY);
      expect(fallback.status).toBe(200);
      expect((await fallback.json() as Json).escrow).toBeNull();
      const explicit = await signedPost(creator, '/v1/tasks', { ...TASK_BODY, escrow: true });
      expect(explicit.status).toBe(503);
      const body = await explicit.json() as Json;
      expect(body.error).toBe('escrow_unavailable');
      expect(body.reason).toMatch(/house wallet/);
    });

    it('with payments off entirely a bounty is refused before any escrow logic', async () => {
      disablePaymentsForTests();
      const res = await signedPost(creator, '/v1/tasks', TASK_BODY);
      expect(res.status).toBe(503);
      expect((await res.json() as Json).error).toBe('payments_unavailable');
    });

    it('an unpaid task ignores the escrow flag', async () => {
      const res = await signedPost(creator, '/v1/tasks', { title: 't', description: 'd', escrow: true });
      expect(res.status).toBe(200);
      const json = await res.json() as Json;
      expect(json.escrow).toBeNull();
      expect(json.claimable).toBe(true);
    });
  });

  // ─── Acceptance → release ───

  describe('accepting a delivered escrow task', () => {
    it('releases the deposit: the house signs a transfer to the deliverer, settled through the facilitator', async () => {
      const { taskId } = await postFunded();
      await claimAndDeliver(taskId);
      facilitator.settleOutcomes = [{ kind: 'settled', transaction: RELEASE_TX, network: 'eip155:8453', payer: HOUSE_ADDR }];

      const res = await signedPost(creator, `/v1/tasks/${taskId}/accept`, { note: 'great' });
      expect(res.status).toBe(200);
      const body = await res.json() as Json;
      expect(body.status).toBe('verified');
      expect(body.accepted_by).toBe('creator');
      expect(body.payment_status).toBe('settled');
      expect(body.payment_tx_hash).toBe(RELEASE_TX);
      expect(body.escrow.status).toBe('released');
      expect(body.escrow.release_tx_hash).toBe(RELEASE_TX);
      expect(body.chain_sequence).not.toBeNull();
      expect(res.headers.get('PAYMENT-RESPONSE')).toBeTruthy();

      // The release is a house-signed x402 payload: from = house, to = the deliverer's wallet, exact amount, recoverable.
      expect(facilitator.verifyCalls).toHaveLength(1); // only the deposit was verified; the house trusts its own signature
      expect(facilitator.settleCalls).toHaveLength(2);
      const release = facilitator.settleCalls[1];
      expect(release.requirements.payTo).toBe(TEST_WALLET);
      expect(release.requirements.amount).toBe('5000000');
      expect(release.payload.payload.authorization.from).toBe(HOUSE_ADDR);
      expect(release.payload.payload.authorization.to).toBe(TEST_WALLET);
      expect(recoverAuthorizationSigner(release.payload)).toBe(HOUSE_ADDR);

      const r = await row(taskId);
      expect(r.escrow_status).toBe('released');
      expect(r.escrow_leg).toBe('release');
      expect(r.escrow_leg_attempts).toBe(1);
      expect(r.payment_settled).toBe(1);
      expect(r.payment_payer).toBe(HOUSE_ADDR);
      expect(r.escrow_deposit_tx_hash).toBe(TEST_TX);
      expect(await eventTypes(taskId)).toEqual([
        'bounty_declared', 'escrow_deposit_authorized', 'escrow_funded', 'escrow_release_authorized', 'settled',
      ]);
      const chain = await db.all<{ entry_type: string }>('SELECT entry_type FROM chain ORDER BY sequence');
      expect(chain.map((c) => c.entry_type)).toEqual(['task_delivered', 'task_verified', 'task_payment_settled']);
      await drainOutbox(db, new Date().toISOString());
      const types = await inboxTypes(claimer.agentId);
      expect(types).toContain('task.verified');
      expect(types).toContain('task.payment_settled');
    });

    it('is idempotent once released, and never asks the buyer for a signature', async () => {
      const { taskId } = await postFunded();
      await claimAndDeliver(taskId);
      expect((await signedPost(creator, `/v1/tasks/${taskId}/accept`)).status).toBe(200);
      const again = await signedPost(creator, `/v1/tasks/${taskId}/accept`);
      expect(again.status).toBe(200);
      expect((await again.json() as Json).payment_status).toBe('settled');
      expect(facilitator.settleCalls).toHaveLength(2);
      const withHeader = await signedPost(creator, `/v1/tasks/${taskId}/accept`, {}, { 'PAYMENT-SIGNATURE': 'x' });
      expect(withHeader.status).toBe(400);
      expect((await withHeader.json() as Json).error).toBe('payment_not_expected');
    });

    it('a release the facilitator cannot settle right now stays releasing and is retried by the cron with the SAME authorization', async () => {
      const { taskId } = await postFunded();
      await claimAndDeliver(taskId);
      facilitator.settleOutcomes = [{ kind: 'unavailable', cause: 'server', detail: '502' }];
      const res = await signedPost(creator, `/v1/tasks/${taskId}/accept`);
      expect(res.status).toBe(200);
      const body = await res.json() as Json;
      expect(body.status).toBe('verified');
      expect(body.payment_status).toBe('failed');
      expect(body.escrow.status).toBe('releasing');
      let r = await row(taskId);
      expect(r.settle_broadcast).toBe(1);
      const nonce = r.payment_nonce;

      facilitator.settleOutcomes = [];
      const summary = await runTaskCron(db, ENV as Bindings, isoPlus(r.settle_next_at as string, 1000));
      expect(summary.settle_attempted).toBe(1);
      expect(summary.escrow_swept).toBe(0);
      r = await row(taskId);
      expect(r.escrow_status).toBe('released');
      expect(r.payment_nonce).toBe(nonce); // never re-signed after a broadcast
      expect(r.escrow_leg_attempts).toBe(1);
    });

    it('a release the chain rejects for good drops back to funded and the cron re-signs a fresh authorization', async () => {
      const { taskId } = await postFunded();
      await claimAndDeliver(taskId);
      facilitator.settleOutcomes = [{ kind: 'rejected', reason: 'invalid_exact_evm_token_name_mismatch', http: 200 }];
      const res = await signedPost(creator, `/v1/tasks/${taskId}/accept`);
      expect((await res.json() as Json).escrow.status).toBe('funded');
      let r = await row(taskId);
      expect(r.status).toBe('verified');
      expect(r.escrow_status).toBe('funded');
      expect(r.escrow_leg).toBe('release');
      expect(r.escrow_leg_attempts).toBe(1);
      const firstNonce = r.payment_nonce;

      facilitator.settleOutcomes = [];
      const summary = await runTaskCron(db, ENV as Bindings, new Date().toISOString());
      expect(summary.escrow_swept).toBe(1);
      r = await row(taskId);
      expect(r.escrow_status).toBe('released');
      expect(r.escrow_leg_attempts).toBe(2);
      expect(r.payment_nonce).not.toBe(firstNonce);
      expect(r.escrow_release_tx_hash).toBe(TEST_TX);
    });

    it('gives up after the attempt cap and reports it for a human', async () => {
      const { taskId } = await postFunded();
      await claimAndDeliver(taskId);
      facilitator.settleOutcomes = [{ kind: 'rejected', reason: 'invalid_exact_evm_token_name_mismatch', http: 200 }];
      await signedPost(creator, `/v1/tasks/${taskId}/accept`);
      for (let i = 1; i < ESCROW_MAX_LEG_ATTEMPTS; i++) {
        const s = await runTaskCron(db, ENV as Bindings, new Date().toISOString());
        expect(s.escrow_swept).toBe(1);
      }
      const r = await row(taskId);
      expect(r.escrow_leg_attempts).toBe(ESCROW_MAX_LEG_ATTEMPTS);
      expect(r.escrow_status).toBe('funded');
      const s = await runTaskCron(db, ENV as Bindings, new Date().toISOString());
      expect(s.escrow_swept).toBe(0);
      expect(s.escrow_stuck).toBe(1);
      expect(facilitator.settleCalls).toHaveLength(1 + ESCROW_MAX_LEG_ATTEMPTS);
    });

    it('the 7-day auto-accept releases the deposit too — silence pays the deliverer', async () => {
      const { taskId } = await postFunded();
      await claimAndDeliver(taskId);
      const r0 = await row(taskId);
      const later = isoPlus(r0.auto_release_at as string, 60_000);
      facilitator.settleOutcomes = [{ kind: 'settled', transaction: RELEASE_TX, network: 'eip155:8453' }];
      const summary = await runTaskCron(db, ENV as Bindings, later);
      expect(summary.auto_accepted).toBe(1);
      const r = await row(taskId);
      expect(r.status).toBe('verified');
      expect(r.accepted_by).toBe('auto');
      expect(r.escrow_status).toBe('released');
      expect(r.escrow_release_tx_hash).toBe(RELEASE_TX);
      expect(r.payment_status).toBe('settled');
      // No "payment due" nag for the creator — nothing is due.
      expect(await inboxTypes(creator.agentId)).not.toContain('task.payment_due');
      const detail = await (await app.request(`/v1/tasks/${taskId}`)).json() as Json;
      expect(detail.task.payment_due).toBe(false);
      expect(detail.task.escrow.status).toBe('released');
      void REVIEW_WINDOW_MS;
    });

    it('an accept whose signing is impossible (house key gone) still records acceptance; the sweep releases later', async () => {
      const { taskId } = await postFunded();
      await claimAndDeliver(taskId);
      setHouseWalletForTests(null);
      const res = await signedPost(creator, `/v1/tasks/${taskId}/accept`);
      expect(res.status).toBe(200);
      const body = await res.json() as Json;
      expect(body.status).toBe('verified');
      expect(body.escrow.status).toBe('funded');
      expect(body.release_deferred).toBe('escrow_unavailable');
      setHouseWalletForTests(house);
      const summary = await runTaskCron(db, ENV as Bindings, new Date().toISOString());
      expect(summary.escrow_swept).toBe(1);
      expect((await row(taskId)).escrow_status).toBe('released');
    });

    it('a rotated house key cannot move an older deposit: the leg is refused and reported', async () => {
      const { taskId } = await postFunded();
      await claimAndDeliver(taskId);
      const other = houseWalletFromPrivateKey(parseHousePrivateKey('0x' + '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'));
      setHouseWalletForTests(other);
      const body = await (await signedPost(creator, `/v1/tasks/${taskId}/accept`)).json() as Json;
      expect(body.release_deferred).toBe('wallet_mismatch');
      expect((await row(taskId)).escrow_status).toBe('funded');
    });
  });

  // ─── Cancel → refund ───

  describe('cancelling a funded escrow task', () => {
    it('refunds the deposit to the wallet that paid it (house-signed) — from open, claimed, or disputed', async () => {
      const { taskId } = await postFunded();
      facilitator.settleOutcomes = [{ kind: 'settled', transaction: REFUND_TX, network: 'eip155:8453', payer: HOUSE_ADDR }];
      const res = await signedPost(creator, `/v1/tasks/${taskId}/cancel`, { reason: 'changed my mind' });
      expect(res.status).toBe(200);
      const body = await res.json() as Json;
      expect(body.status).toBe('cancelled');
      expect(body.payment_status).toBe('refunded');
      expect(body.escrow.status).toBe('refunded');
      expect(body.refund_tx_hash).toBe(REFUND_TX);

      const refund = facilitator.settleCalls[1];
      expect(refund.requirements.payTo).toBe(TEST_PAYER);
      expect(refund.payload.payload.authorization.from).toBe(HOUSE_ADDR);
      expect(recoverAuthorizationSigner(refund.payload)).toBe(HOUSE_ADDR);

      const r = await row(taskId);
      expect(r.escrow_status).toBe('refunded');
      expect(r.escrow_refund_tx_hash).toBe(REFUND_TX);
      expect(r.payment_settled).toBe(0);
      expect(await eventTypes(taskId)).toEqual([
        'bounty_declared', 'escrow_deposit_authorized', 'escrow_funded', 'escrow_refund_requested', 'escrow_refund_authorized', 'escrow_refunded',
      ]);
      expect(await inboxTypes(creator.agentId)).toContain('task.escrow_refunded');
      const detail = await (await app.request(`/v1/tasks/${taskId}`)).json() as Json;
      expect(detail.task.escrow.status).toBe('refunded');
      expect(detail.payment.status).toBe('refunded');
    });

    it('delivered work still needs a dispute first; after it, cancel refunds', async () => {
      const { taskId } = await postFunded();
      await claimAndDeliver(taskId);
      const early = await signedPost(creator, `/v1/tasks/${taskId}/cancel`);
      expect(early.status).toBe(409);
      expect((await early.json() as Json).error).toBe('dispute_first');
      expect((await signedPost(creator, `/v1/tasks/${taskId}/dispute`, { reason: 'wrong' })).status).toBe(200);
      const res = await signedPost(creator, `/v1/tasks/${taskId}/cancel`);
      expect(res.status).toBe(200);
      expect((await res.json() as Json).escrow.status).toBe('refunded');
    });

    it('a refund that fails transiently is retried by the cron; accepted work cannot be cancelled', async () => {
      const { taskId } = await postFunded();
      facilitator.settleOutcomes = [{ kind: 'unavailable', cause: 'network', detail: 'x' }];
      const body = await (await signedPost(creator, `/v1/tasks/${taskId}/cancel`)).json() as Json;
      expect(body.escrow.status).toBe('refunding');
      expect(body.payment_status).toBe('failed');
      let r = await row(taskId);
      facilitator.settleOutcomes = [];
      await runTaskCron(db, ENV as Bindings, isoPlus(r.settle_next_at as string, 1000));
      r = await row(taskId);
      expect(r.escrow_status).toBe('refunded');
      expect(r.payment_status).toBe('refunded');

      const { taskId: t2 } = await postFunded();
      await claimAndDeliver(t2);
      await signedPost(creator, `/v1/tasks/${t2}/accept`);
      const res = await signedPost(creator, `/v1/tasks/${t2}/cancel`);
      expect(res.status).toBe(409);
      expect((await res.json() as Json).error).toBe('already_accepted');
    });
  });

  // ─── Discovery ───

  it('advertises escrow on /v1/tasks/:id/payment and the accept route rejects a buyer signature for it', async () => {
    const { taskId } = await postFunded();
    await claimAndDeliver(taskId);
    const pay = await (await app.request(`/v1/tasks/${taskId}/payment`)).json() as Json;
    expect(pay.payment.escrow.status).toBe('funded');
    expect(pay.requirements).toBeNull();
    expect(pay.requirements_unavailable_reason).toBe('escrow_held');
    // A sign-at-accept payload for the deliverer would be nonsense here.
    const bogus = encodeB64Json(paymentPayloadFor({ ...pay.payment_required?.accepts?.[0] ?? { scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '5000000', payTo: TEST_WALLET, maxTimeoutSeconds: 3600, extra: { name: 'USD Coin', version: '2' } } }));
    const res = await signedPost(creator, `/v1/tasks/${taskId}/accept`, {}, { 'PAYMENT-SIGNATURE': bogus });
    expect(res.status).toBe(400);
  });
});
