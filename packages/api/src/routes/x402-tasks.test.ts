/**
 * Wallet-only hiring over x402 (routes/x402-tasks.ts, migration 0051): the
 * price check, the paid POST (tiers and a buyer-chosen bounty), managing the
 * task by token or by the paying wallet's signature, and attaching the
 * wallet's tasks when an agent binds that wallet. Fake facilitator, real
 * house key, real EOA signatures.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  setupTestDb, createTestApp, createTestAgent, signRequest, walletBindBody, personalSign, TEST_WALLET_KEYS, type TestKeypair,
} from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import {
  enablePaymentsForTests, resetPaymentsForTests, paymentHeaderFor, paymentPayloadFor, TEST_WALLET, TEST_TX, type FakeFacilitator,
} from '../payments/test-fixtures.js';
import { encodeB64Json, type PaymentRequirementsV2 } from '../payments/x402.js';
import { houseWalletFromPrivateKey, parseHousePrivateKey, setHouseWalletForTests, addressFromPrivateKey } from '../payments/house-wallet.js';
import { parseActionMessage } from '../wallets/action.js';
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

const mockFetch = vi.fn();
/**
 * Webhooks get a 200; a chain RPC call (a signature that is not the paying key's
 * falls through to the smart-wallet check) answers like Base for a plain
 * address: the validator returns 0x00, not a valid signature.
 */
function fakeNetwork(_url: string, init?: RequestInit): Promise<unknown> {
  let method: string | undefined;
  try { method = (JSON.parse(String(init?.body ?? '')) as { method?: string }).method; } catch { method = undefined; }
  if (method === 'eth_blockNumber' || method === 'eth_call') {
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: method === 'eth_blockNumber' ? '0x10' : '0x00' }), { status: 200 }));
  }
  return Promise.resolve({ ok: true, status: 200 });
}

/** Hardhat account #0 holds the escrow; the buyer pays from account #1, whose key signs its actions. */
const house = houseWalletFromPrivateKey(parseHousePrivateKey('0x' + TEST_WALLET_KEYS.a));
const BUYER_KEY = TEST_WALLET_KEYS.b;
const BUYER = addressFromPrivateKey(parseHousePrivateKey('0x' + BUYER_KEY));
const ENV: Partial<Bindings> = { PAYMENT_ENCRYPTION_KEY: 'a'.repeat(64) };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const BRIEF = { title: 'Summarize this week in Base', description: 'Five items, one paragraph each, with links.', category: 'research', required_capabilities: ['research'] };

describe('Wallet-only hiring over x402 (/v1/x402/tasks)', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;
  let claimer: TestKeypair & { name: string };
  let facilitator: FakeFacilitator;

  beforeEach(async () => {
    db = setupTestDb();
    app = createTestApp(db, ENV);
    mockFetch.mockReset();
    mockFetch.mockImplementation(fakeNetwork);
    vi.stubGlobal('fetch', mockFetch);
    facilitator = enablePaymentsForTests({
      verify: [{ kind: 'valid', payer: BUYER }],
      settle: [{ kind: 'settled', transaction: TEST_TX, network: 'eip155:8453', payer: BUYER }],
    });
    setHouseWalletForTests(house);
    claimer = await createTestAgent(db, { status: 'active', capabilities: ['research'], webhookUrl: 'https://claimer.example.com/hook' });
    await db.run('UPDATE agents SET wallet_address = ? WHERE id = ?', TEST_WALLET, claimer.agentId);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetPaymentsForTests();
    setHouseWalletForTests(undefined);
  });

  // ─── Helpers ───

  async function post(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    return app.request(path, { method: 'POST', headers: { ...(text ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: text });
  }

  async function signedPost(agent: TestKeypair, path: string, body?: unknown): Promise<Response> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers = await signRequest(agent, 'POST', path, text);
    return app.request(path, { method: 'POST', headers: { ...(text ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: text });
  }

  /** The 402 for `body` at `path`, then the paid retry from BUYER. */
  async function hire(path = '/v1/x402/tasks/usd-5', body: Json = BRIEF, network = 'eip155:8453'): Promise<{ res: Response; json: Json; taskId: string; token: string }> {
    const first = await post(path, body);
    expect(first.status).toBe(402);
    const requirements = (((await first.json()) as Json).accepts as PaymentRequirementsV2[]).find((a) => a.network === network)!;
    const res = await post(path, body, { 'PAYMENT-SIGNATURE': paymentHeaderFor(requirements, undefined, { authorization: { from: BUYER } }) });
    const json = await res.json() as Json;
    return { res, json, taskId: json.task_id, token: json.manage?.token };
  }

  async function claimAndDeliver(taskId: string): Promise<void> {
    expect((await signedPost(claimer, `/v1/tasks/${taskId}/claim`)).status).toBe(200);
    const deliver = await signedPost(claimer, `/v1/tasks/${taskId}/deliver`, { summary: 'Done', submission_type: 'json', submission_content: '{"items":5}' });
    expect(deliver.status).toBe(200);
  }

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Ask without auth, sign the returned message with `key`, and return the two headers. */
  async function walletHeaders(taskId: string, method: 'GET' | 'POST', path: string, key: string = BUYER_KEY): Promise<Record<string, string>> {
    const res = method === 'GET' ? await app.request(path) : await post(path, {});
    expect(res.status).toBe(401);
    const json = await res.json() as Json;
    return { 'X-Wallet-Message': json.sign_this_hex, 'X-Wallet-Signature': personalSign(json.sign_this, key) };
  }

  async function row(taskId: string): Promise<Json> {
    return (await db.get<Json>('SELECT * FROM tasks WHERE task_id = ?', taskId))!;
  }

  // ─── Price list and price checks ───

  it('GET /v1/x402/tasks lists the endpoints, prices, minimum and escrow wallet', async () => {
    const json = await (await app.request('/v1/x402/tasks')).json() as Json;
    expect(json.escrow_wallet).toBe(house.address);
    expect(json.escrow_available).toBe(true);
    expect(json.endpoints.map((e: Json) => e.endpoint)).toEqual(['POST /v1/x402/tasks', 'POST /v1/x402/tasks/usd-1', 'POST /v1/x402/tasks/usd-5', 'POST /v1/x402/tasks/usd-20']);
    expect(json.endpoints[0]).toMatchObject({ minimum_usdc: '0.10', minimum_amount: '100000' });
    expect(json.endpoints[3]).toMatchObject({ price_usdc: '20.00', price_amount: '20000000' });
  });

  it('an empty POST to a tier is a price check: 402 at the tier price, Bazaar discovery, nothing written', async () => {
    const res = await post('/v1/x402/tasks/usd-5');
    expect(res.status).toBe(402);
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeTruthy();
    const json = await res.json() as Json;
    expect(json.accepts[0]).toMatchObject({ amount: '5000000', payTo: house.address, network: 'eip155:8453' });
    expect(json.resource.url).toBe('https://api.basedagents.ai/v1/x402/tasks/usd-5');
    expect(json.fund_endpoint).toBe('POST /v1/x402/tasks/usd-5');
    expect(json.extensions.bazaar.info.input).toMatchObject({ type: 'http', method: 'POST', bodyType: 'json' });
    expect(json.extensions.bazaar.schema.properties.input.properties.body.required).toEqual(['title', 'description']);
    expect(json.body_example.title).toBeTruthy();
    // The header carries the same envelope, discovery block included.
    const header = JSON.parse(atob(res.headers.get('PAYMENT-REQUIRED')!)) as Json;
    expect(header.extensions.bazaar).toBeTruthy();
    expect(await db.get('SELECT count(*) AS n FROM tasks')).toEqual({ n: 0 });
    expect(facilitator.verifyCalls).toHaveLength(0);
  });

  it('a GET on a tier quotes the same 402 (CLI inspect, health checks); a payment sent with a GET is refused unused', async () => {
    const res = await app.request('/v1/x402/tasks/usd-5');
    expect(res.status).toBe(402);
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeTruthy();
    const json = await res.json() as Json;
    expect(json.accepts[0]).toMatchObject({ amount: '5000000', payTo: house.address });
    expect(json.extensions.bazaar.info.input.method).toBe('POST');
    const paid = await app.request('/v1/x402/tasks/usd-5', { headers: { 'PAYMENT-SIGNATURE': paymentHeaderFor(json.accepts[0], undefined, { authorization: { from: BUYER } }) } });
    expect(paid.status).toBe(405);
    expect(paid.headers.get('Allow')).toBe('POST');
    expect(facilitator.verifyCalls).toHaveLength(0);
    expect(await db.get('SELECT count(*) AS n FROM tasks')).toEqual({ n: 0 });
  });

  it('the bazaar block a client echoes in its payment reaches the facilitator (that is what catalogs the service)', async () => {
    const first = await (await post('/v1/x402/tasks/usd-1', BRIEF)).json() as Json;
    const payload = { ...paymentPayloadFor(first.accepts[0], undefined, { authorization: { from: BUYER } }), resource: first.resource, extensions: first.extensions };
    const res = await post('/v1/x402/tasks/usd-1', BRIEF, { 'PAYMENT-SIGNATURE': encodeB64Json(payload) });
    expect(res.status).toBe(200);
    const sent = facilitator.verifyCalls[0].payload as Json;
    expect(sent.extensions.bazaar.info.input).toMatchObject({ type: 'http', method: 'POST' });
    expect(sent.resource.url).toBe('https://api.basedagents.ai/v1/x402/tasks/usd-1');
    // Settled from the stored header, the echo is still there.
    expect((facilitator.settleCalls[0].payload as Json).extensions.bazaar).toBeTruthy();
  });

  it('the custom endpoint quotes the minimum when empty, and the chosen bounty once described', async () => {
    const empty = await (await post('/v1/x402/tasks')).json() as Json;
    expect(empty.accepts[0].amount).toBe('100000');
    expect(empty.extensions.bazaar.schema.properties.input.properties.body.required).toContain('bounty_usdc');
    const described = await post('/v1/x402/tasks', { ...BRIEF, bounty_usdc: '2.50' });
    expect(described.status).toBe(402);
    expect(((await described.json()) as Json).accepts[0].amount).toBe('2500000');
  });

  // ─── Paid POST ───

  it('a paid tier POST creates a funded task owned by the paying wallet and returns the manage token once', async () => {
    const { res, json, taskId, token } = await hire();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, status: 'open', claimable: true, poster: { kind: 'wallet', wallet: BUYER.toLowerCase() } });
    expect(json.escrow.status).toBe('funded');
    expect(json.bounty.amount_display).toBe('5.00');
    expect(token).toMatch(/^bat_[A-Za-z0-9_-]{43}$/);
    expect(json.manage.task_url).toBe(`https://api.basedagents.ai/v1/x402/tasks/${taskId}`);

    const r = await row(taskId);
    expect(r).toMatchObject({ creator_kind: 'wallet', creator_agent_id: null, creator_owner_id: null, creator_wallet: BUYER.toLowerCase(), escrow_deposit_payer: BUYER });
    expect(r.manage_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.manage_token_hash).not.toContain(token);

    // Public reads show the wallet as the poster, never the token hash.
    const detail = await (await app.request(`/v1/tasks/${taskId}`)).json() as Json;
    expect(detail.task.creator).toMatchObject({ kind: 'wallet', id: null, wallet: BUYER.toLowerCase(), short_id: `${BUYER.toLowerCase().slice(0, 6)}…${BUYER.toLowerCase().slice(-4)}` });
    expect(detail.task.manage_token_hash).toBeUndefined();
    expect(detail.task.creator_wallet).toBeUndefined();
    // Matching agents hear about it once funded, like any escrow task.
    const inbox = await db.all<{ type: string }>('SELECT type FROM agent_events WHERE agent_id = ?', claimer.agentId);
    expect(inbox.map((e) => e.type)).toContain('task.available');
  });

  it('a buyer-chosen bounty is posted at that amount', async () => {
    const { res, taskId } = await hire('/v1/x402/tasks', { ...BRIEF, bounty_usdc: '2.5' });
    expect(res.status).toBe(200);
    expect((await row(taskId)).bounty_amount).toBe('2500000');
  });

  it('refuses a bad body before touching the payment, and a bounty under the minimum', async () => {
    const header = paymentHeaderFor({ scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '5000000', payTo: house.address, maxTimeoutSeconds: 600, extra: {} } as PaymentRequirementsV2);
    const empty = await post('/v1/x402/tasks/usd-5', undefined, { 'PAYMENT-SIGNATURE': header });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as Json).message).toMatch(/Your payment was not used/);
    // A tier's price is fixed; the strict body refuses a bounty field there.
    expect((await post('/v1/x402/tasks/usd-5', { ...BRIEF, bounty_usdc: '50' })).status).toBe(400);
    const low = await post('/v1/x402/tasks', { ...BRIEF, bounty_usdc: '0.05' });
    expect(low.status).toBe(400);
    expect(((await low.json()) as Json).error).toBe('bounty_below_minimum');
    expect(facilitator.verifyCalls).toHaveLength(0);
    expect(await db.get('SELECT count(*) AS n FROM tasks')).toEqual({ n: 0 });
  });

  it('a signature for a cheaper tier does not buy a dearer one', async () => {
    const quote = await (await post('/v1/x402/tasks/usd-1', BRIEF)).json() as Json;
    const res = await post('/v1/x402/tasks/usd-5', BRIEF, { 'PAYMENT-SIGNATURE': paymentHeaderFor(quote.accepts[0], undefined, { authorization: { from: BUYER } }) });
    expect(res.status).toBe(402);
    expect(((await res.json()) as Json).error).toBe('payment_invalid');
    expect(await db.get('SELECT count(*) AS n FROM tasks')).toEqual({ n: 0 });
  });

  it('a tier under the live minimum is neither listed nor quoted', async () => {
    const raised = createTestApp(db, { ...ENV, MIN_BOUNTY_ATOMIC_A2A: '2000000' });
    const list = await (await raised.request('/v1/x402/tasks')).json() as Json;
    expect(list.endpoints.map((e: Json) => e.endpoint)).toEqual(['POST /v1/x402/tasks', 'POST /v1/x402/tasks/usd-5', 'POST /v1/x402/tasks/usd-20']);
    const res = await raised.request('/v1/x402/tasks/usd-1', { method: 'POST' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Json)).toMatchObject({ error: 'bounty_below_minimum', minimum_usdc: '2.00' });
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
    expect((await raised.request('/v1/x402/tasks/usd-5', { method: 'POST' })).status).toBe(402);
  });

  it('without escrow the endpoints answer 503 instead of a 402', async () => {
    setHouseWalletForTests(null);
    const res = await post('/v1/x402/tasks/usd-1');
    expect(res.status).toBe(503);
    expect(((await res.json()) as Json).error).toBe('escrow_unavailable');
  });

  // ─── Managing: token or wallet signature ───

  it('without auth: 401 with the exact message to sign, a Circle command, and the headers to send', async () => {
    const { taskId } = await hire();
    const res = await app.request(`/v1/x402/tasks/${taskId}`);
    expect(res.status).toBe(401);
    const json = await res.json() as Json;
    expect(json.error).toBe('auth_required');
    expect(parseActionMessage(json.sign_this)).toMatchObject({ taskId, action: 'read', wallet: BUYER.toLowerCase(), network: 'eip155:8453' });
    expect(Buffer.from(json.sign_this_hex.slice(2), 'hex').toString('utf8')).toBe(json.sign_this);
    expect(json.circle_sign_command).toBe(`circle wallet sign message ${json.sign_this_hex} --hex --address ${BUYER.toLowerCase()} --chain BASE`);
    expect(Object.keys(json.send_headers)).toEqual(['X-Wallet-Message', 'X-Wallet-Signature']);
  });

  it('the manage token reads the task; a wrong token is 401', async () => {
    const { taskId, token } = await hire();
    const ok = await app.request(`/v1/x402/tasks/${taskId}`, { headers: bearer(token) });
    expect(ok.status).toBe(200);
    const json = await ok.json() as Json;
    expect(json).toMatchObject({ ok: true, authorized_by: 'token', submission: null });
    expect(json.task.task_id).toBe(taskId);
    expect(json.payment.escrow.status).toBe('funded');
    const other = await hire();
    expect((await app.request(`/v1/x402/tasks/${taskId}`, { headers: bearer(other.token) })).status).toBe(401);
    expect((await app.request(`/v1/x402/tasks/${taskId}`, { headers: bearer('bat_nope') })).status).toBe(401);
  });

  it('the paying wallet signs instead of the token; each signed message works once, for one action', async () => {
    const { taskId } = await hire();
    const path = `/v1/x402/tasks/${taskId}`;
    const headers = await walletHeaders(taskId, 'GET', path);
    const ok = await app.request(path, { headers });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Json).authorized_by).toBe('wallet');
    // The poster's private view is never stored by a shared cache.
    expect(ok.headers.get('Cache-Control')).toBe('no-store');

    const replay = await app.request(path, { headers });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as Json).error).toBe('wallet_proof_reused');

    // Signed by another key: not the wallet that paid.
    const stranger = await walletHeaders(taskId, 'GET', path, TEST_WALLET_KEYS.a);
    const bad = await app.request(path, { headers: stranger });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as Json)).toMatchObject({ error: 'wallet_proof_invalid', reason: 'bad_signature' });

    // A "read" message does not authorize a cancel.
    const readOnly = await walletHeaders(taskId, 'GET', path);
    const cancel = await post(`${path}/cancel`, {}, readOnly);
    expect(cancel.status).toBe(401);
    expect(((await cancel.json()) as Json).reason).toBe('action_mismatch');
    expect((await row(taskId)).status).toBe('open');

    const garbled = await app.request(path, { headers: { 'X-Wallet-Message': 'nothex', 'X-Wallet-Signature': '0x12' } });
    expect(garbled.status).toBe(400);
  });

  it('a task posted by an agent is not managed here', async () => {
    const agent = await createTestAgent(db, { status: 'active' });
    const created = await signedPost(agent, '/v1/tasks', { title: 'Free task', description: 'No bounty' });
    const { task_id } = await created.json() as Json;
    expect((await app.request(`/v1/x402/tasks/${task_id}`)).status).toBe(404);
  });

  // ─── The lifecycle ───

  it('delivered → read the submission → accept by wallet signature: the house releases the deposit', async () => {
    const { taskId, token } = await hire();
    await claimAndDeliver(taskId);

    const sub = await app.request(`/v1/x402/tasks/${taskId}/submission`, { headers: bearer(token) });
    expect(sub.status).toBe(200);
    expect(sub.headers.get('Cache-Control')).toBe('no-store');
    expect(((await sub.json()) as Json).submission.content).toBe('{"items":5}');

    // An agent that is not the poster cannot accept it through the agent routes.
    const agentTry = await signedPost(claimer, `/v1/tasks/${taskId}/accept`, {});
    expect(agentTry.status).toBe(403);
    expect(((await agentTry.json()) as Json).message).toMatch(/\/v1\/x402\/tasks\/\{id\}\/accept/);

    const headers = await walletHeaders(taskId, 'POST', `/v1/x402/tasks/${taskId}/accept`);
    const res = await post(`/v1/x402/tasks/${taskId}/accept`, { rating: 5 }, headers);
    expect(res.status).toBe(200);
    const json = await res.json() as Json;
    expect(json).toMatchObject({ ok: true, status: 'verified', accepted_by: 'creator', rating: 5 });
    const r = await row(taskId);
    expect(r.status).toBe('verified');
    expect(r.escrow_status).toBe('released');
    // The release went to the deliverer's wallet.
    expect(facilitator.settleCalls.at(-1)!.requirements.payTo.toLowerCase()).toBe(TEST_WALLET.toLowerCase());
  });

  it('revision, dispute, then cancel with the token: the deposit is refunded to the wallet that paid', async () => {
    const { taskId, token } = await hire();
    await claimAndDeliver(taskId);

    const rev = await post(`/v1/x402/tasks/${taskId}/revision`, { note: 'Add links' }, bearer(token));
    expect(rev.status).toBe(200);
    expect(((await rev.json()) as Json)).toMatchObject({ status: 'claimed', revision_count: 1 });
    const inbox = await db.all<{ type: string }>('SELECT type FROM agent_events WHERE agent_id = ?', claimer.agentId);
    expect(inbox.map((e) => e.type)).toContain('task.revision_requested');

    const again = await signedPost(claimer, `/v1/tasks/${taskId}/deliver`, { summary: 'Done v2', submission_type: 'json', submission_content: '{"items":5,"links":true}' });
    expect(again.status).toBe(200);
    const dispute = await post(`/v1/x402/tasks/${taskId}/dispute`, { reason: 'Links are dead' }, bearer(token));
    expect(dispute.status).toBe(200);
    expect(((await dispute.json()) as Json).review_state).toBe('disputed');

    const cancel = await post(`/v1/x402/tasks/${taskId}/cancel`, { reason: 'Not usable' }, bearer(token));
    expect(cancel.status).toBe(200);
    const json = await cancel.json() as Json;
    expect(json).toMatchObject({ status: 'cancelled', refund_to: BUYER });
    expect((await row(taskId)).escrow_status).toBe('refunded');
    expect(facilitator.settleCalls.at(-1)!.requirements.payTo.toLowerCase()).toBe(BUYER.toLowerCase());
  });

  it('cancelling an open task refunds the deposit; accepting work that is not delivered is 409', async () => {
    const { taskId, token } = await hire();
    expect((await post(`/v1/x402/tasks/${taskId}/accept`, {}, bearer(token))).status).toBe(409);
    const cancel = await post(`/v1/x402/tasks/${taskId}/cancel`, {}, bearer(token));
    expect(cancel.status).toBe(200);
    expect((await row(taskId)).status).toBe('cancelled');
  });

  // ─── Networks: Base and Polygon ───

  /** Hardhat account #2, a public test key: a deliverer whose payout wallet is a plain key. */
  const DELIVERER_KEY = '5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
  const DELIVERER = addressFromPrivateKey(parseHousePrivateKey('0x' + DELIVERER_KEY));

  /** Bind the claimer's payout wallet with a real signature (D8) on `network`. */
  async function bindClaimer(network = 'eip155:8453'): Promise<void> {
    const body = walletBindBody(claimer.agentId, DELIVERER_KEY, network);
    const text = JSON.stringify(body);
    const headers = await signRequest(claimer, 'PATCH', `/v1/agents/${claimer.agentId}/wallet`, text);
    const res = await app.request(`/v1/agents/${claimer.agentId}/wallet`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: text });
    expect(res.status).toBe(200);
  }

  it('the 402 offers the same price on every accepted network, Base first, all paid to the escrow wallet', async () => {
    const json = await (await post('/v1/x402/tasks/usd-5')).json() as Json;
    const offers = json.accepts as PaymentRequirementsV2[];
    expect(offers[0].network).toBe('eip155:8453');
    expect(offers.map((o) => o.network)).toContain('eip155:137');
    for (const o of offers) expect(o).toMatchObject({ amount: '5000000', payTo: house.address, scheme: 'exact' });
    expect(offers.find((o) => o.network === 'eip155:137')!.asset).toBe('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359');
    expect(json.networks).toEqual(offers.map((o) => o.network));
    // The price list says the same.
    const list = await (await app.request('/v1/x402/tasks')).json() as Json;
    expect(list.networks).toEqual(offers.map((o) => o.network));
    // Naming a network in the body offers that one only.
    const only = await (await post('/v1/x402/tasks/usd-5', { ...BRIEF, network: 'eip155:137' })).json() as Json;
    expect(only.accepts.map((o: Json) => o.network)).toEqual(['eip155:137']);
  });

  it('production offers Base and Polygon mainnet, never the testnet', async () => {
    const prod = createTestApp(db, { ...ENV, ENVIRONMENT: 'production' });
    const json = await (await prod.request('/v1/x402/tasks/usd-1', { method: 'POST' })).json() as Json;
    expect(json.accepts.map((o: Json) => o.network)).toEqual(['eip155:8453', 'eip155:137']);
  });

  it('paying the Polygon offer posts a Polygon bounty: deposited, held and settled on Polygon', async () => {
    const { res, json, taskId } = await hire('/v1/x402/tasks/usd-5', BRIEF, 'eip155:137');
    expect(res.status).toBe(200);
    expect(json.bounty).toMatchObject({ network: 'eip155:137', amount_display: '5.00' });
    expect(json.escrow.status).toBe('funded');
    expect((await row(taskId)).bounty_network).toBe('eip155:137');
    expect(facilitator.verifyCalls[0].requirements.network).toBe('eip155:137');
    expect(facilitator.settleCalls[0].requirements).toMatchObject({ network: 'eip155:137', payTo: house.address });
  });

  it('a plain-key payout wallet bound on Base claims a Polygon task and is paid at the same address on Polygon', async () => {
    await bindClaimer('eip155:8453');
    const { taskId, token } = await hire('/v1/x402/tasks/usd-5', BRIEF, 'eip155:137');
    await claimAndDeliver(taskId);
    const accept = await post(`/v1/x402/tasks/${taskId}/accept`, {}, bearer(token));
    expect(accept.status).toBe(200);
    expect((await row(taskId)).escrow_status).toBe('released');
    expect(facilitator.settleCalls.at(-1)!.requirements).toMatchObject({ network: 'eip155:137', payTo: DELIVERER });
  });

  it('a payout wallet with no proof of being a plain key claims only on its own network', async () => {
    // beforeEach gave the claimer an address on Base with no bind proof: it may be a smart wallet.
    const { taskId } = await hire('/v1/x402/tasks/usd-5', BRIEF, 'eip155:137');
    const claim = await signedPost(claimer, `/v1/tasks/${taskId}/claim`);
    expect(claim.status).toBe(409);
    expect(await claim.json()).toMatchObject({ error: 'wallet_network_mismatch', network: 'eip155:137', wallet_network: 'eip155:8453' });
  });

  it('a payout wallet switched to a smart wallet after the claim is not paid on another chain; the release waits', async () => {
    await bindClaimer('eip155:8453');
    const { taskId, token } = await hire('/v1/x402/tasks/usd-5', BRIEF, 'eip155:137');
    await claimAndDeliver(taskId);
    // As if the agent re-bound to a smart wallet on Base after claiming.
    await db.run("UPDATE agent_wallet_bindings SET signer_kind = 'erc1271' WHERE agent_id = ?", claimer.agentId);
    const settlesBefore = facilitator.settleCalls.length;
    const accept = await post(`/v1/x402/tasks/${taskId}/accept`, {}, bearer(token));
    expect(accept.status).toBe(200);
    expect(await accept.json()).toMatchObject({ status: 'verified', release_deferred: 'payee_wallet_wrong_network' });
    expect((await row(taskId)).escrow_status).toBe('funded');
    expect(facilitator.settleCalls.length).toBe(settlesBefore);
  });

  // ─── Wallet identity: list and attach ───

  it('GET /v1/tasks?creator=<address> lists the tasks a wallet posted, any case', async () => {
    const a = await hire();
    const b = await hire('/v1/x402/tasks/usd-1');
    const list = await (await app.request(`/v1/tasks?creator=${BUYER.toUpperCase().replace('0X', '0x')}`)).json() as Json;
    expect(list.tasks.map((t: Json) => t.task_id).sort()).toEqual([a.taskId, b.taskId].sort());
  });

  it('binding the paying wallet to an agent moves its tasks to that agent; the wallet keeps access', async () => {
    const { taskId, token } = await hire();
    const agent = await createTestAgent(db, { status: 'active' });
    const body = walletBindBody(agent.agentId, BUYER_KEY);
    const text = JSON.stringify(body);
    const headers = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/wallet`, text);
    const bind = await app.request(`/v1/agents/${agent.agentId}/wallet`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: text });
    expect(bind.status).toBe(200);
    expect(((await bind.json()) as Json).attached_tasks).toBe(1);

    const r = await row(taskId);
    expect(r).toMatchObject({ creator_kind: 'agent', creator_agent_id: agent.agentId, creator_wallet: BUYER.toLowerCase() });
    const detail = await (await app.request(`/v1/tasks/${taskId}`)).json() as Json;
    expect(detail.task.creator).toMatchObject({ kind: 'agent', id: agent.agentId });
    expect(detail.task.creator.wallet).toBeUndefined();

    // The agent now manages it with AgentSig; the token still works too.
    await claimAndDeliver(taskId);
    expect((await app.request(`/v1/x402/tasks/${taskId}`, { headers: bearer(token) })).status).toBe(200);
    const accept = await signedPost(agent, `/v1/tasks/${taskId}/accept`, {});
    expect(accept.status).toBe(200);
    expect((await row(taskId)).status).toBe('verified');

    // Still listed under the wallet.
    const list = await (await app.request(`/v1/tasks?creator=${BUYER}`)).json() as Json;
    expect(list.tasks.map((t: Json) => t.task_id)).toEqual([taskId]);
  });

  it('a bind by an unrelated wallet attaches nothing', async () => {
    const { taskId } = await hire();
    const agent = await createTestAgent(db, { status: 'active' });
    const body = walletBindBody(agent.agentId, TEST_WALLET_KEYS.a);
    const text = JSON.stringify(body);
    const headers = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/wallet`, text);
    const bind = await app.request(`/v1/agents/${agent.agentId}/wallet`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: text });
    expect(bind.status).toBe(200);
    expect(((await bind.json()) as Json).attached_tasks).toBeUndefined();
    expect((await row(taskId)).creator_kind).toBe('wallet');
  });
});
