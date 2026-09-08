/**
 * Fail-closed provider factory (spec N6): null for each missing/invalid piece,
 * exactly one log line per isolate, X402_FACILITATOR_URL honoured, and the
 * test-override semantics every route/cron test relies on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getPublicKey, utils, etc } from '@noble/ed25519';
import {
  paymentProviderFor,
  paymentsDisabledReason,
  setPaymentProviderForTests,
  PAYMENTS_SOURCE_VERSION,
  type Facilitator,
  type PaymentsEnv,
} from './index.js';
import { CdpFacilitator } from './cdp-facilitator.js';
import { bytesToBase64, buildRequirements, PaymentPayloadV2 } from './x402.js';

const seed = utils.randomPrivateKey();
const pub = getPublicKey(seed);
const SECRET = bytesToBase64(etc.concatBytes(seed, pub));
const ENC_KEY = 'ab'.repeat(32);

const VALID: PaymentsEnv = {
  TASK_PAYMENTS_ENABLED: '1',
  CDP_API_KEY_ID: 'key-1',
  CDP_API_KEY_SECRET: SECRET,
  PAYMENT_ENCRYPTION_KEY: ENC_KEY,
};

const fake: Facilitator = {
  verify: async () => ({ kind: 'valid' }),
  settle: async () => ({ kind: 'settled', transaction: '0x' + '00'.repeat(32) }),
  supported: async () => ({}),
};

beforeEach(() => {
  setPaymentProviderForTests(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  setPaymentProviderForTests(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('paymentProviderFor', () => {
  it('returns a CdpFacilitator when every piece is valid, memoised per config', () => {
    const p = paymentProviderFor(VALID);
    expect(p).toBeInstanceOf(CdpFacilitator);
    expect(paymentProviderFor({ ...VALID })).toBe(p);
    expect(paymentProviderFor({ ...VALID, X402_FACILITATOR_URL: 'https://staging.example.com/x402' })).not.toBe(p);
    expect(paymentsDisabledReason(VALID)).toBeNull();
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(PAYMENTS_SOURCE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each<[string, PaymentsEnv | undefined, RegExp]>([
    ['no env', undefined, /no env bindings/],
    ['flag absent', { ...VALID, TASK_PAYMENTS_ENABLED: undefined }, /TASK_PAYMENTS_ENABLED/],
    ['flag not "1"', { ...VALID, TASK_PAYMENTS_ENABLED: 'true' }, /TASK_PAYMENTS_ENABLED/],
    ['key id missing', { ...VALID, CDP_API_KEY_ID: '' }, /CDP_API_KEY_ID/],
    ['secret missing', { ...VALID, CDP_API_KEY_SECRET: undefined }, /CDP_API_KEY_SECRET is not set/],
    ['secret is PEM', { ...VALID, CDP_API_KEY_SECRET: '-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----' }, /not an Ed25519 key \(.*PEM/],
    ['secret 63 bytes', { ...VALID, CDP_API_KEY_SECRET: bytesToBase64(etc.concatBytes(seed, pub).slice(0, 63)) }, /not an Ed25519 key/],
    ['secret pub mismatch', { ...VALID, CDP_API_KEY_SECRET: bytesToBase64(etc.concatBytes(seed, getPublicKey(utils.randomPrivateKey()))) }, /not an Ed25519 key/],
    ['encryption key missing', { ...VALID, PAYMENT_ENCRYPTION_KEY: undefined }, /PAYMENT_ENCRYPTION_KEY/],
    ['encryption key 63 hex', { ...VALID, PAYMENT_ENCRYPTION_KEY: 'a'.repeat(63) }, /PAYMENT_ENCRYPTION_KEY/],
    ['encryption key non-hex', { ...VALID, PAYMENT_ENCRYPTION_KEY: 'g'.repeat(64) }, /PAYMENT_ENCRYPTION_KEY/],
    ['facilitator URL garbage', { ...VALID, X402_FACILITATOR_URL: 'not a url' }, /X402_FACILITATOR_URL is not a valid URL/],
    ['facilitator URL non-http', { ...VALID, X402_FACILITATOR_URL: 'ftp://x/y' }, /X402_FACILITATOR_URL is not an http\(s\) URL/],
  ])('is null when %s', (_label, env, re) => {
    expect(paymentProviderFor(env)).toBeNull();
    expect(paymentsDisabledReason(env)).toMatch(re);
  });

  it('logs the first null reason exactly once per isolate', () => {
    const env = { ...VALID, CDP_API_KEY_SECRET: '-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----' };
    expect(paymentProviderFor(env)).toBeNull();
    expect(paymentProviderFor(env)).toBeNull();
    expect(paymentProviderFor({ ...VALID, CDP_API_KEY_ID: '' })).toBeNull();
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^\[payments\] disabled: CDP_API_KEY_SECRET is not an Ed25519 key/));
    expect(console.log).not.toHaveBeenCalled();
  });

  it('logs the flag-off default as an informational line, still once', () => {
    expect(paymentProviderFor({ ...VALID, TASK_PAYMENTS_ENABLED: undefined })).toBeNull();
    expect(paymentProviderFor(undefined)).toBeNull();
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith("[payments] disabled: TASK_PAYMENTS_ENABLED is not '1'");
    expect(console.error).not.toHaveBeenCalled();
  });

  it('uses X402_FACILITATOR_URL for requests and the default otherwise', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        seen.push(String(url));
        return new Response(JSON.stringify({ isValid: true }), { status: 200 });
      }),
    );
    const req = buildRequirements({ task_id: 't', bounty_amount: '1', bounty_network: 'eip155:84532' }, '0x' + '1'.repeat(40));
    const payload = PaymentPayloadV2.parse({
      x402Version: 2,
      accepted: req,
      payload: {
        signature: '0x' + 'ab'.repeat(65),
        authorization: { from: '0x' + '2'.repeat(40), to: '0x' + '1'.repeat(40), value: '1', validAfter: '0', validBefore: '1', nonce: '0x' + '0'.repeat(64) },
      },
    });
    const staging = paymentProviderFor({ ...VALID, X402_FACILITATOR_URL: 'https://staging.example.com/x402/' })!;
    expect(await staging.verify(payload, req)).toEqual({ kind: 'valid' });
    const prod = paymentProviderFor(VALID)!;
    await prod.verify(payload, req);
    expect(seen).toEqual(['https://staging.example.com/x402/verify', 'https://api.cdp.coinbase.com/platform/v2/x402/verify']);
  });
});

describe('setPaymentProviderForTests', () => {
  it('an injected provider is returned regardless of env', () => {
    setPaymentProviderForTests(fake);
    expect(paymentProviderFor(undefined)).toBe(fake);
    expect(paymentProviderFor(VALID)).toBe(fake);
    expect(paymentProviderFor({ ...VALID, CDP_API_KEY_ID: '' })).toBe(fake);
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('null forces "disabled" even with a valid env, without logging', () => {
    setPaymentProviderForTests(null);
    expect(paymentProviderFor(VALID)).toBeNull();
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('undefined restores env-derived behaviour and resets the once-flag', () => {
    expect(paymentProviderFor(undefined)).toBeNull();
    expect(console.log).toHaveBeenCalledTimes(1);
    setPaymentProviderForTests(fake);
    expect(paymentProviderFor(undefined)).toBe(fake);
    setPaymentProviderForTests(undefined);
    expect(paymentProviderFor(VALID)).toBeInstanceOf(CdpFacilitator);
    expect(paymentProviderFor(undefined)).toBeNull();
    expect(console.log).toHaveBeenCalledTimes(2);
  });
});
