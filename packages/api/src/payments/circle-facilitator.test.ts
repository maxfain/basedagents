/**
 * Circle Facilitator Service adapter: the request (Bearer key, x402 v2 envelope,
 * the payment-identifier on settle), and how each answer in Circle's OpenAPI
 * (facilitator-service.yaml) maps onto the outcome table settle.ts applies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CircleFacilitator, DEFAULT_CIRCLE_FACILITATOR_URL, circlePaymentId } from './circle-facilitator.js';
import { buildRequirements, PaymentPayloadV2 } from './x402.js';
import { classifyRejection } from './settle.js';

const PAY_TO = '0x1111111111111111111111111111111111111111';
const BUYER = '0x2222222222222222222222222222222222222222';
const TX = '0x' + 'ab'.repeat(32);
const REQ = buildRequirements({ task_id: 'task_abc', bounty_amount: '1000000', bounty_network: 'eip155:5042' }, PAY_TO);
const PAYLOAD = PaymentPayloadV2.parse({
  x402Version: 2,
  accepted: REQ,
  extensions: { bazaar: { info: { input: { type: 'http' } } } },
  payload: {
    signature: '0x' + 'cd'.repeat(65),
    authorization: { from: BUYER, to: PAY_TO, value: '1000000', validAfter: '0', validBefore: '1800003600', nonce: '0x' + '1F'.repeat(32) },
  },
});

type Call = { url: string; init: RequestInit };
let calls: Call[];
let responder: (call: Call) => Response | Promise<Response>;
const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const call = { url: String(input), init: init ?? {} };
  calls.push(call);
  return responder(call);
}) as unknown as typeof fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const make = (baseUrl = DEFAULT_CIRCLE_FACILITATOR_URL) => new CircleFacilitator({ apiKey: 'LIVE_API_KEY:id:secret', baseUrl, fetchImpl });
const body = (c: Call) => JSON.parse(String(c.init.body)) as { x402Version: number; paymentPayload: Record<string, unknown>; paymentRequirements: Record<string, unknown> };

beforeEach(() => {
  calls = [];
  responder = () => json(200, { isValid: true, payer: BUYER });
});

describe('CircleFacilitator', () => {
  it('posts the x402 v2 envelope with the API key as a Bearer token', async () => {
    expect(await make().verify(PAYLOAD, REQ)).toEqual({ kind: 'valid', payer: BUYER });
    expect(calls[0].url).toBe('https://api.circle.com/v1/facilitator/x402/verify');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer LIVE_API_KEY:id:secret');
    expect(body(calls[0])).toEqual({ x402Version: 2, paymentPayload: JSON.parse(JSON.stringify(PAYLOAD)), paymentRequirements: JSON.parse(JSON.stringify(REQ)) });
    // Arc's offer carries the transfer method Circle asks for.
    expect(REQ.extra).toEqual({ name: 'USDC', version: '2', assetTransferMethod: 'eip3009' });
  });

  it('settles with a payment-identifier derived from the nonce, keeping the echoed extensions', async () => {
    responder = () => json(200, { success: true, payer: BUYER, transaction: TX, network: 'eip155:5042', amount: '1000000' });
    expect(await make('https://api-sandbox.circle.com/v1/facilitator/x402/').settle(PAYLOAD, REQ)).toEqual({ kind: 'settled', transaction: TX, network: 'eip155:5042', payer: BUYER });
    expect(calls[0].url).toBe('https://api-sandbox.circle.com/v1/facilitator/x402/settle');
    const ext = body(calls[0]).paymentPayload.extensions as Record<string, unknown>;
    expect(ext['payment-identifier']).toEqual({ info: { required: true, id: circlePaymentId(PAYLOAD) } });
    expect(ext.bazaar).toEqual({ info: { input: { type: 'http' } } });
    // 16–128 of [A-Za-z0-9_-], one per authorization.
    expect(circlePaymentId(PAYLOAD)).toMatch(/^ba_[0-9a-f]{64}$/);
    // The stored payload itself is not changed.
    expect(PAYLOAD.extensions).toEqual({ bazaar: { info: { input: { type: 'http' } } } });
  });

  it('maps verify refusals and settle failures', async () => {
    responder = () => json(200, { isValid: false, invalidReason: 'insufficient_funds', payer: BUYER });
    expect(await make().verify(PAYLOAD, REQ)).toEqual({ kind: 'invalid', reason: 'insufficient_funds', payer: BUYER, http: 200 });
    responder = () => json(200, { success: false, errorReason: 'invalid_exact_evm_payload_signature', payer: BUYER, transaction: '', network: 'eip155:5042' });
    expect(await make().settle(PAYLOAD, REQ)).toEqual({ kind: 'rejected', reason: 'invalid_exact_evm_payload_signature', http: 200 });
    // "Reusing a nonce that already settled returns invalid_transaction_state."
    expect(classifyRejection('invalid_transaction_state')).toBe('nonce_used');
  });

  it('pending without a transaction is still pending, never a failure', async () => {
    responder = () => json(200, {
      success: false, errorReason: 'settlement_pending', payer: BUYER, transaction: '', network: 'eip155:5042',
      extensions: { 'settlement-status': { status: 'pending', paymentId: '5b3f6c1e-9d2a-4f08-b1c7-2e9a14d0c3aa' } },
    });
    expect(await make().settle(PAYLOAD, REQ)).toEqual({ kind: 'pending' });
    responder = () => json(200, { success: false, errorReason: 'settlement_pending', payer: BUYER, transaction: TX, network: 'eip155:5042' });
    expect(await make().settle(PAYLOAD, REQ)).toEqual({ kind: 'pending', transaction: TX });
    // A success without a hash is not believed.
    responder = () => json(200, { success: true, payer: BUYER, transaction: '', network: 'eip155:5042' });
    expect(await make().settle(PAYLOAD, REQ)).toMatchObject({ kind: 'unavailable', cause: 'malformed' });
  });

  it('classifies the error statuses; a 409 conflict is retried, never re-signed', async () => {
    const cases: Array<[number, unknown, string]> = [
      [401, { code: 401, message: 'Invalid credentials.' }, 'auth'],
      [403, { code: 403, message: 'Registration required', errors: [{ reason: 'registration_required' }] }, 'auth'],
      [409, { code: 409, message: 'conflict', errors: [{ reason: 'payment_identifier_conflict' }] }, 'server'],
      [415, { code: 415, message: 'Unsupported' }, 'malformed'],
      [429, { code: 429, message: 'slow down' }, 'rate_limited'],
      [503, { code: 503, message: 'down' }, 'server'],
      [400, { code: 400, message: 'mixed authentication modes' }, 'malformed'],
    ];
    for (const [status, payload, cause] of cases) {
      responder = () => json(status, payload);
      expect(await make().settle(PAYLOAD, REQ), `HTTP ${status}`).toMatchObject({ kind: 'unavailable', cause, http: status });
    }
    responder = () => json(403, { code: 403, message: 'Registration required', errors: [{ reason: 'registration_required' }] });
    expect(await make().settle(PAYLOAD, REQ)).toMatchObject({ detail: 'HTTP 403 registration_required: Registration required' });
  });

  it('never throws: transport failures and non-JSON are unavailable', async () => {
    responder = () => { throw new TypeError('connection reset'); };
    expect(await make().verify(PAYLOAD, REQ)).toMatchObject({ kind: 'unavailable', cause: 'network' });
    responder = () => new Response('<html>oops</html>', { status: 200 });
    expect(await make().settle(PAYLOAD, REQ)).toMatchObject({ kind: 'unavailable', cause: 'malformed' });
  });

  it('reads /supported without credentials', async () => {
    responder = () => json(200, { x402Version: 2, kinds: [{ scheme: 'exact', network: 'eip155:5042' }], signers: {} });
    expect(await make().supported()).toMatchObject({ kinds: [{ network: 'eip155:5042' }] });
    expect(calls[0].url).toBe('https://api.circle.com/v1/facilitator/x402/supported');
    expect((calls[0].init.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
  });
});
