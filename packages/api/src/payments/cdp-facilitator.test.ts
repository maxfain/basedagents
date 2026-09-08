/**
 * Facilitator adapter (spec §11 "Facilitator adapter"): the request envelope
 * and headers (Bearer JWT with the right kid/sub/uris), every response
 * classification in §6, X402_FACILITATOR_URL honoured, and "never throws".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPublicKey, utils, verifyAsync, etc } from '@noble/ed25519';
import { CdpFacilitator, DEFAULT_FACILITATOR_URL, type Facilitator } from './cdp-facilitator.js';
import { base64ToBytes, bytesToBase64, buildRequirements, PaymentPayloadV2, type PaymentPayloadV2 as Payload } from './x402.js';

const utf8 = new TextEncoder();
const dec = new TextDecoder();

const KEY_ID = 'organizations/org-1/apiKeys/key-1';
const seed = utils.randomPrivateKey();
const pub = getPublicKey(seed);
const SECRET = bytesToBase64(etc.concatBytes(seed, pub));

const PAY_TO = '0x1111111111111111111111111111111111111111';
const BUYER = '0x2222222222222222222222222222222222222222';
const TX = '0x' + 'ab'.repeat(32);
const TASK = { task_id: 'task_abc', bounty_amount: '5000000', bounty_network: 'eip155:8453' };
const REQ = buildRequirements(TASK, PAY_TO);
const PAYLOAD: Payload = PaymentPayloadV2.parse({
  x402Version: 2,
  accepted: REQ,
  payload: {
    signature: '0x' + 'cd'.repeat(65),
    authorization: {
      from: BUYER,
      to: PAY_TO,
      value: '5000000',
      validAfter: '0',
      validBefore: '1800003600',
      nonce: '0x' + '11'.repeat(32),
    },
  },
});

type Call = { url: string; init: RequestInit };
let calls: Call[];
let responder: (call: Call) => Promise<Response> | Response;

const fetchImpl: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const call = { url: String(input), init: init ?? {} };
  calls.push(call);
  return responder(call);
}) as unknown as typeof fetch;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function make(baseUrl = DEFAULT_FACILITATOR_URL): Facilitator {
  return new CdpFacilitator({ keyId: KEY_ID, secret: SECRET, baseUrl, fetchImpl, sourceVersion: '0.5.0' });
}

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(dec.decode(base64ToBytes(part)));
}

async function assertBearer(init: RequestInit, expectedUri: string): Promise<void> {
  const headers = init.headers as Record<string, string>;
  const auth = headers['Authorization'];
  expect(auth).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const [h, c, s] = auth.slice('Bearer '.length).split('.');
  const header = decodePart(h);
  const claims = decodePart(c);
  expect(header).toMatchObject({ alg: 'EdDSA', kid: KEY_ID, typ: 'JWT' });
  expect(header.nonce).toMatch(/^[0-9a-f]{32}$/);
  expect(claims.sub).toBe(KEY_ID);
  expect(claims.iss).toBe('cdp');
  expect(claims.uris).toEqual([expectedUri]);
  expect((claims.exp as number) - (claims.iat as number)).toBe(120);
  expect(claims.nbf).toBe(claims.iat);
  expect(await verifyAsync(base64ToBytes(s), utf8.encode(`${h}.${c}`), pub)).toBe(true);
}

beforeEach(() => {
  calls = [];
  responder = () => json(200, { isValid: true, payer: BUYER });
});

describe('request shape', () => {
  it('POSTs the v2 envelope to /verify with JSON, Bearer JWT and Correlation-Context', async () => {
    const out = await make().verify(PAYLOAD, REQ);
    expect(out).toEqual({ kind: 'valid', payer: BUYER });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe('https://api.cdp.coinbase.com/platform/v2/x402/verify');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Correlation-Context']).toBe('sdkLanguage=typescript,source=basedagents-api,sourceVersion=0.5.0');
    expect(Object.keys(headers).sort()).toEqual(['Authorization', 'Content-Type', 'Correlation-Context']);
    await assertBearer(init, 'POST api.cdp.coinbase.com/platform/v2/x402/verify');
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ x402Version: 2, paymentPayload: PAYLOAD, paymentRequirements: REQ });
    expect(body.paymentRequirements).toMatchObject({
      payTo: PAY_TO,
      amount: '5000000',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      scheme: 'exact',
      maxTimeoutSeconds: 3600,
    });
  });

  it('POSTs /settle with a JWT bound to the settle path', async () => {
    responder = () => json(200, { success: true, transaction: TX, network: 'eip155:8453', payer: BUYER });
    const out = await make().settle(PAYLOAD, REQ);
    expect(out).toEqual({ kind: 'settled', transaction: TX, network: 'eip155:8453', payer: BUYER });
    expect(calls[0].url).toBe('https://api.cdp.coinbase.com/platform/v2/x402/settle');
    await assertBearer(calls[0].init, 'POST api.cdp.coinbase.com/platform/v2/x402/settle');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ x402Version: 2, paymentPayload: PAYLOAD, paymentRequirements: REQ });
  });

  it('mints a fresh JWT per call', async () => {
    const f = make();
    await f.verify(PAYLOAD, REQ);
    await f.verify(PAYLOAD, REQ);
    const nonce = (i: number) =>
      decodePart((calls[i].init.headers as Record<string, string>)['Authorization'].slice(7).split('.')[0]).nonce;
    expect(nonce(0)).not.toBe(nonce(1));
  });

  it('honours X402_FACILITATOR_URL (host/port/path in both the URL and the JWT uris)', async () => {
    const f = make('https://staging.example.com:8443/x402/');
    await f.verify(PAYLOAD, REQ);
    expect(calls[0].url).toBe('https://staging.example.com:8443/x402/verify');
    await assertBearer(calls[0].init, 'POST staging.example.com:8443/x402/verify');
    responder = () => json(200, { success: true, transaction: TX });
    await f.settle(PAYLOAD, REQ);
    expect(calls[1].url).toBe('https://staging.example.com:8443/x402/settle');
    await assertBearer(calls[1].init, 'POST staging.example.com:8443/x402/settle');
  });

  it('rejects an unparsable baseUrl at construction', () => {
    expect(() => make('not a url')).toThrow();
  });
});

describe('verify classification', () => {
  it('200 isValid:true without payer', async () => {
    responder = () => json(200, { isValid: true });
    expect(await make().verify(PAYLOAD, REQ)).toEqual({ kind: 'valid' });
  });

  it('200 isValid:false IS invalid (reason, message, payer, http:200)', async () => {
    responder = () => json(200, { isValid: false, invalidReason: 'insufficient_funds', invalidMessage: 'Insufficient funds', payer: BUYER });
    expect(await make().verify(PAYLOAD, REQ)).toEqual({
      kind: 'invalid',
      reason: 'insufficient_funds',
      message: 'Insufficient funds',
      payer: BUYER,
      http: 200,
    });
  });

  it('400 rejection shape → invalid with reason and http:400', async () => {
    responder = () => json(400, { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature', payer: null });
    expect(await make().verify(PAYLOAD, REQ)).toEqual({ kind: 'invalid', reason: 'invalid_exact_evm_payload_signature', http: 400 });
  });

  it('isValid:false without a reason → invalid/unknown', async () => {
    responder = () => json(200, { isValid: false });
    expect(await make().verify(PAYLOAD, REQ)).toEqual({ kind: 'invalid', reason: 'unknown', http: 200 });
  });

  it('400 generic CDP error envelope → unavailable/malformed with the errorType in detail', async () => {
    responder = () => json(400, { errorType: 'invalid_request', errorMessage: 'Invalid request.', correlationId: 'abc' });
    const out = await make().verify(PAYLOAD, REQ);
    expect(out).toMatchObject({ kind: 'unavailable', cause: 'malformed', http: 400 });
    expect((out as { detail: string }).detail).toMatch(/invalid_request: Invalid request\./);
  });

  it('200 off-shape JSON → unavailable/malformed', async () => {
    responder = () => json(200, { valid: true });
    expect(await make().verify(PAYLOAD, REQ)).toMatchObject({ kind: 'unavailable', cause: 'malformed', http: 200 });
  });
});

describe('settle classification', () => {
  it('success:true with a valid tx → settled (network/payer optional)', async () => {
    responder = () => json(200, { success: true, transaction: TX });
    expect(await make().settle(PAYLOAD, REQ)).toEqual({ kind: 'settled', transaction: TX });
  });

  it('success:true without a 32-byte tx hash → unavailable/malformed', async () => {
    responder = () => json(200, { success: true, transaction: '0x1234' });
    expect(await make().settle(PAYLOAD, REQ)).toMatchObject({ kind: 'unavailable', cause: 'malformed', http: 200 });
    responder = () => json(200, { success: true });
    expect(await make().settle(PAYLOAD, REQ)).toMatchObject({ kind: 'unavailable', cause: 'malformed' });
    responder = () => json(200, { success: true, transaction: '' });
    expect(await make().settle(PAYLOAD, REQ)).toMatchObject({ kind: 'unavailable', cause: 'malformed' });
  });

  it('settlement_pending with a tx → pending (200 or 400)', async () => {
    responder = () => json(400, { success: false, errorReason: 'settlement_pending', errorMessage: 'pending', transaction: TX, network: 'eip155:8453' });
    expect(await make().settle(PAYLOAD, REQ)).toEqual({ kind: 'pending', transaction: TX });
    responder = () => json(200, { success: false, errorReason: 'settlement_pending', transaction: TX });
    expect(await make().settle(PAYLOAD, REQ)).toEqual({ kind: 'pending', transaction: TX });
  });

  it('settlement_pending without a usable tx → rejected (the OUTCOME TABLE retries it)', async () => {
    responder = () => json(200, { success: false, errorReason: 'settlement_pending' });
    expect(await make().settle(PAYLOAD, REQ)).toEqual({ kind: 'rejected', reason: 'settlement_pending', http: 200 });
    responder = () => json(200, { success: false, errorReason: 'settlement_pending', transaction: 'garbage' });
    expect(await make().settle(PAYLOAD, REQ)).toEqual({ kind: 'rejected', reason: 'settlement_pending', http: 200 });
  });

  it('other success:false → rejected with reason/message/transaction/http', async () => {
    responder = () => json(400, { success: false, errorReason: 'insufficient_funds', errorMessage: 'Insufficient funds', payer: BUYER });
    expect(await make().settle(PAYLOAD, REQ)).toEqual({ kind: 'rejected', reason: 'insufficient_funds', message: 'Insufficient funds', http: 400 });
    responder = () => json(200, { success: false, errorReason: 'invalid_exact_evm_nonce_already_used', transaction: TX });
    expect(await make().settle(PAYLOAD, REQ)).toEqual({ kind: 'rejected', reason: 'invalid_exact_evm_nonce_already_used', transaction: TX, http: 200 });
    responder = () => json(400, { success: false, errorReason: null, transaction: '' });
    expect(await make().settle(PAYLOAD, REQ)).toEqual({ kind: 'rejected', reason: 'unknown', http: 400 });
  });

  it('400 generic CDP error envelope → unavailable/malformed', async () => {
    responder = () => json(400, { errorType: 'invalid_request', errorMessage: 'bad' });
    expect(await make().settle(PAYLOAD, REQ)).toMatchObject({ kind: 'unavailable', cause: 'malformed', http: 400 });
  });
});

describe('transport classification (both operations)', () => {
  const ops: Array<['verify' | 'settle']> = [['verify'], ['settle']];

  it.each(ops)('%s: 402 → unavailable/billing', async (op) => {
    responder = () => json(402, { errorType: 'payment_method_required', errorMessage: 'A valid payment method is required' });
    const out = await make()[op](PAYLOAD, REQ);
    expect(out).toMatchObject({ kind: 'unavailable', cause: 'billing', http: 402 });
    expect((out as { detail: string }).detail).toMatch(/payment_method_required/);
  });

  it.each(ops)('%s: 401/403 → unavailable/auth', async (op) => {
    responder = () => json(401, { errorType: 'unauthorized', errorMessage: 'nope' });
    expect(await make()[op](PAYLOAD, REQ)).toMatchObject({ kind: 'unavailable', cause: 'auth', http: 401 });
    responder = () => json(403, { errorType: 'forbidden' });
    expect(await make()[op](PAYLOAD, REQ)).toMatchObject({ kind: 'unavailable', cause: 'auth', http: 403 });
  });

  it.each(ops)('%s: 429 → unavailable/rate_limited', async (op) => {
    responder = () => new Response('slow down', { status: 429 });
    expect(await make()[op](PAYLOAD, REQ)).toMatchObject({ kind: 'unavailable', cause: 'rate_limited', http: 429, detail: 'HTTP 429: slow down' });
  });

  it.each(ops)('%s: 5xx → unavailable/server (JSON or HTML body)', async (op) => {
    responder = () => json(500, { errorType: 'internal_server_error', errorMessage: 'boom' });
    expect(await make()[op](PAYLOAD, REQ)).toMatchObject({ kind: 'unavailable', cause: 'server', http: 500 });
    responder = () => new Response('<html>502 Bad Gateway</html>', { status: 502 });
    expect(await make()[op](PAYLOAD, REQ)).toMatchObject({ kind: 'unavailable', cause: 'server', http: 502, detail: 'HTTP 502: <html>502 Bad Gateway</html>' });
    responder = () => new Response('', { status: 503 });
    expect(await make()[op](PAYLOAD, REQ)).toMatchObject({ kind: 'unavailable', cause: 'server', http: 503, detail: 'HTTP 503: <empty response>' });
  });

  it.each(ops)('%s: other statuses (404) → unavailable/server, flagged unexpected', async (op) => {
    responder = () => new Response('not found', { status: 404 });
    const out = await make()[op](PAYLOAD, REQ);
    expect(out).toMatchObject({ kind: 'unavailable', cause: 'server', http: 404 });
    expect((out as { detail: string }).detail).toMatch(/^unexpected HTTP 404/);
  });

  it.each(ops)('%s: fetch throw → unavailable/network', async (op) => {
    responder = () => {
      throw new TypeError('fetch failed');
    };
    const out = await make()[op](PAYLOAD, REQ);
    expect(out).toMatchObject({ kind: 'unavailable', cause: 'network' });
    expect((out as { detail: string }).detail).toMatch(/fetch failed/);
    expect((out as { http?: number }).http).toBeUndefined();
  });

  it.each(ops)('%s: timeout abort → unavailable/network mentioning the timeout', async (op) => {
    responder = () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    const out = await make()[op](PAYLOAD, REQ);
    expect(out).toMatchObject({ kind: 'unavailable', cause: 'network' });
    expect((out as { detail: string }).detail).toMatch(/timed out after 15000ms/);
  });

  it.each(ops)('%s: 200 non-JSON → unavailable/malformed', async (op) => {
    responder = () => new Response('<html>ok</html>', { status: 200 });
    const out = await make()[op](PAYLOAD, REQ);
    expect(out).toMatchObject({ kind: 'unavailable', cause: 'malformed', http: 200 });
    expect((out as { detail: string }).detail).toMatch(/non-JSON/);
  });

  it.each(ops)('%s: body read failure → unavailable/network, never throws', async (op) => {
    responder = () => ({ status: 200, text: () => Promise.reject(new Error('socket hang up')) }) as unknown as Response;
    const out = await make()[op](PAYLOAD, REQ);
    expect(out).toMatchObject({ kind: 'unavailable', cause: 'network', http: 200 });
  });

  it.each(ops)('%s: an unusable secret → unavailable/auth without a request, never throws', async (op) => {
    const f = new CdpFacilitator({ keyId: KEY_ID, secret: 'AAAA', baseUrl: DEFAULT_FACILITATOR_URL, fetchImpl, sourceVersion: '0.5.0' });
    const out = await f[op](PAYLOAD, REQ);
    expect(out).toMatchObject({ kind: 'unavailable', cause: 'auth' });
    expect((out as { detail: string }).detail).toMatch(/cannot sign CDP JWT/);
    expect(calls).toHaveLength(0);
  });
});

describe('supported()', () => {
  it('GETs /supported with a GET-bound JWT and returns the parsed JSON', async () => {
    const kinds = { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }], extensions: [], signers: {} };
    responder = () => json(200, kinds);
    const out = await make().supported();
    expect(out).toEqual(kinds);
    expect(calls[0].url).toBe('https://api.cdp.coinbase.com/platform/v2/x402/supported');
    expect(calls[0].init.method).toBe('GET');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    expect(headers['Correlation-Context']).toBe('sdkLanguage=typescript,source=basedagents-api,sourceVersion=0.5.0');
    await assertBearer(calls[0].init, 'GET api.cdp.coinbase.com/platform/v2/x402/supported');
  });

  it('throws on a non-2xx (only the check script calls it)', async () => {
    responder = () => json(401, { errorType: 'unauthorized' });
    await expect(make().supported()).rejects.toThrow(/supported failed \(401\)/);
  });
});
