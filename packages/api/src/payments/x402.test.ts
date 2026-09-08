/**
 * x402 helpers (spec §11 "x402 helpers"): header decode in every accepted
 * encoding and every rejection, each local precheck reason, the amount
 * boundary, and the requirement / PaymentRequired shapes the 402 serves.
 */
import { describe, it, expect } from 'vitest';
import {
  ASSETS,
  assetFor,
  decodePaymentHeader,
  PaymentMalformed,
  buildRequirements,
  buildPaymentRequired,
  encodeB64Json,
  localPrechecks,
  usdcToAtomic,
  atomicToDisplay,
  bytesToBase64,
  base64ToBytes,
  base64urlEncode,
  HEADER_MAX_BYTES,
  MAX_TIMEOUT_SECONDS,
  MIN_VALID_BEFORE_SLACK,
  MAX_VALID_BEFORE_SKEW,
  SETTLE_PRECHECK_SLACK,
  BOUNTY_AMOUNT_RE,
  MAX_BOUNTY_ATOMIC,
  PaymentPayloadV2,
  PaymentRequirementsV2,
  isNetwork,
  type PaymentRequirementsV2 as Requirements,
  type ExactEvmAuthorization,
} from './x402.js';

const PAY_TO = '0x1111111111111111111111111111111111111111';
const BUYER = '0x2222222222222222222222222222222222222222';
const NOW = 1_800_000_000;
const SIG = '0x' + 'ab'.repeat(65);
const NONCE = '0x' + '11'.repeat(32);
const TASK = { task_id: 'task_abc', bounty_amount: '5000000', bounty_network: 'eip155:8453' };

function makePayload(opts: {
  auth?: Partial<ExactEvmAuthorization>;
  accepted?: Partial<Requirements>;
  x402Version?: unknown;
  resource?: unknown;
} = {}): Record<string, unknown> {
  const req = buildRequirements(TASK, PAY_TO);
  return {
    x402Version: opts.x402Version ?? 2,
    ...(opts.resource !== undefined ? { resource: opts.resource } : {}),
    accepted: { ...req, ...opts.accepted },
    payload: {
      signature: SIG,
      authorization: {
        from: BUYER,
        to: PAY_TO,
        value: '5000000',
        validAfter: '0',
        validBefore: String(NOW + MAX_TIMEOUT_SECONDS),
        nonce: NONCE,
        ...opts.auth,
      },
    },
  };
}

const utf8 = new TextEncoder();
const toB64 = (v: unknown) => bytesToBase64(utf8.encode(JSON.stringify(v)));
const toB64url = (v: unknown) => base64urlEncode(utf8.encode(JSON.stringify(v)));

describe('constants', () => {
  it('match spec §2', () => {
    expect(MAX_TIMEOUT_SECONDS).toBe(3600);
    expect(MIN_VALID_BEFORE_SLACK).toBe(120);
    expect(MAX_VALID_BEFORE_SKEW).toBe(600);
    expect(SETTLE_PRECHECK_SLACK).toBe(30);
    expect(HEADER_MAX_BYTES).toBe(16384);
    expect(MAX_BOUNTY_ATOMIC).toBe(1_000_000_000n);
  });

  it('BOUNTY_AMOUNT_RE accepts atomic strings up to 10 digits without leading zeros', () => {
    for (const ok of ['1', '5000000', '1000000000', '9999999999']) expect(BOUNTY_AMOUNT_RE.test(ok)).toBe(true);
    for (const bad of ['0', '05', '', '5.00', '$5', '10000000000', '-1', '1e6']) {
      expect(BOUNTY_AMOUNT_RE.test(bad)).toBe(false);
    }
  });
});

describe('ASSETS / assetFor', () => {
  it('pins USDC on Base and Base Sepolia', () => {
    expect(ASSETS['eip155:8453']).toEqual({
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      chainId: 8453,
      defaultExtra: { name: 'USD Coin', version: '2' },
    });
    expect(ASSETS['eip155:84532']).toEqual({
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      chainId: 84532,
      defaultExtra: { name: 'USDC', version: '2' },
    });
    expect(isNetwork('eip155:8453')).toBe(true);
    expect(isNetwork('eip155:137')).toBe(false);
    expect(isNetwork(null)).toBe(false);
  });

  it('applies X402_EIP712_NAME/VERSION to mainnet only', () => {
    const env = { X402_EIP712_NAME: 'USDC', X402_EIP712_VERSION: '3' };
    expect(assetFor('eip155:8453', env)).toEqual({
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      extra: { name: 'USDC', version: '3' },
    });
    expect(assetFor('eip155:84532', env).extra).toEqual({ name: 'USDC', version: '2' });
    expect(assetFor('eip155:8453', undefined).extra).toEqual({ name: 'USD Coin', version: '2' });
    expect(assetFor('eip155:8453', { X402_EIP712_NAME: '' }).extra.name).toBe('USD Coin');
  });
});

describe('base64 codec', () => {
  it('round-trips and matches btoa/atob for every remainder length', () => {
    for (let n = 0; n <= 10; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + 251) & 0xff);
      const std = bytesToBase64(bytes);
      expect(std).toBe(btoa(String.fromCharCode(...bytes)));
      expect(Array.from(base64ToBytes(std))).toEqual(Array.from(bytes));
      const url = base64urlEncode(bytes);
      expect(url).not.toMatch(/[+/=]/);
      expect(Array.from(base64ToBytes(url))).toEqual(Array.from(bytes));
    }
  });

  it('decodes the url-safe alphabet and rejects foreign characters', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x3e, 0x3f]);
    const std = bytesToBase64(bytes);
    expect(std).toMatch(/[+/]/);
    const url = std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(Array.from(base64ToBytes(url))).toEqual(Array.from(bytes));
    expect(() => base64ToBytes('ab!c')).toThrow();
    expect(() => base64ToBytes('a')).toThrow();
    expect(() => base64ToBytes('ab cd')).toThrow();
  });
});

describe('decodePaymentHeader', () => {
  it('accepts standard base64', () => {
    const p = decodePaymentHeader(toB64(makePayload()));
    expect(p.x402Version).toBe(2);
    expect(p.accepted.payTo).toBe(PAY_TO);
    expect(p.payload.authorization.nonce).toBe(NONCE);
    expect(PaymentPayloadV2.safeParse(p).success).toBe(true);
  });

  it('accepts base64url without padding', () => {
    const raw = toB64url(makePayload({ resource: { url: 'https://x/?a=1&b=~~>>??' } }));
    expect(raw).not.toMatch(/[+/=]/);
    const p = decodePaymentHeader(raw);
    expect(p.resource?.url).toBe('https://x/?a=1&b=~~>>??');
  });

  it('accepts raw JSON (with surrounding whitespace)', () => {
    const p = decodePaymentHeader('  \n' + JSON.stringify(makePayload()) + '\n');
    expect(p.payload.authorization.to).toBe(PAY_TO);
  });

  it('decoded base64 of raw JSON with whitespace also works', () => {
    const p = decodePaymentHeader(' ' + toB64(makePayload()) + ' ');
    expect(p.accepted.amount).toBe('5000000');
  });

  it('rejects headers over 16 KB', () => {
    const big = makePayload({ resource: { url: 'https://x', description: 'd'.repeat(HEADER_MAX_BYTES) } });
    const raw = toB64(big);
    expect(utf8.encode(raw).byteLength).toBeGreaterThan(HEADER_MAX_BYTES);
    let err: unknown;
    try {
      decodePaymentHeader(raw);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PaymentMalformed);
    expect((err as PaymentMalformed).detail).toMatch(/16384 bytes/);
  });

  it('rejects x402 v1 with a v1-specific detail', () => {
    const v1 = { x402Version: 1, scheme: 'exact', network: 'base', payload: {} };
    expect(() => decodePaymentHeader(toB64(v1))).toThrow(PaymentMalformed);
    try {
      decodePaymentHeader(JSON.stringify(v1));
    } catch (e) {
      expect((e as PaymentMalformed).detail).toMatch(/v1 payloads are not supported/);
    }
  });

  it('rejects other versions, non-objects, and missing version', () => {
    for (const bad of [
      makePayload({ x402Version: 3 }),
      makePayload({ x402Version: '2' }),
      { accepted: {}, payload: {} },
    ]) {
      expect(() => decodePaymentHeader(toB64(bad))).toThrow(PaymentMalformed);
    }
    expect(() => decodePaymentHeader(toB64([1, 2]))).toThrow(/JSON object/);
    expect(() => decodePaymentHeader(toB64('str'))).toThrow(/JSON object/);
  });

  it('rejects undecodable, non-JSON and empty headers', () => {
    expect(() => decodePaymentHeader('')).toThrow(/empty/);
    expect(() => decodePaymentHeader('   ')).toThrow(/empty/);
    expect(() => decodePaymentHeader('not base64!!')).toThrow(/neither JSON nor base64/);
    expect(() => decodePaymentHeader(bytesToBase64(utf8.encode('hello')))).toThrow(/not valid JSON/);
    expect(() => decodePaymentHeader('{not json')).toThrow(/not valid JSON/);
    expect(() => decodePaymentHeader(bytesToBase64(new Uint8Array([0xff, 0xfe, 0x7b])))).toThrow(/UTF-8/);
  });

  it('rejects off-shape payloads with a path in detail', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [makePayload({ auth: { nonce: '0x1234' } }), /payload\.authorization\.nonce/],
      [makePayload({ auth: { to: 'nope' } }), /payload\.authorization\.to/],
      [makePayload({ auth: { value: '5.0' } }), /payload\.authorization\.value/],
      [makePayload({ auth: { validBefore: '1234567890123' } }), /validBefore/],
      [makePayload({ accepted: { network: 'eip155:137' as never } }), /accepted\.network/],
      [makePayload({ accepted: { scheme: 'upto' as never } }), /accepted\.scheme/],
      [makePayload({ accepted: { extra: undefined as never } }), /accepted\.extra/],
    ];
    for (const [bad, re] of cases) {
      let err: unknown;
      try {
        decodePaymentHeader(toB64(bad));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(PaymentMalformed);
      expect((err as PaymentMalformed).detail).toMatch(re);
    }
    const shortSig = makePayload();
    (shortSig.payload as { signature: string }).signature = '0x' + 'ab'.repeat(64);
    expect(() => decodePaymentHeader(toB64(shortSig))).toThrow(/signature/);
  });

  it('keeps passthrough keys on accepted.extra and drops unknown top-level keys', () => {
    const p = makePayload({ accepted: { extra: { name: 'USD Coin', version: '2', foo: 'bar' } as never } });
    (p as Record<string, unknown>).extensions = { x: 1 };
    const out = decodePaymentHeader(toB64(p));
    expect((out.accepted.extra as Record<string, unknown>).foo).toBe('bar');
    expect((out as Record<string, unknown>).extensions).toBeUndefined();
  });
});

describe('buildRequirements / buildPaymentRequired', () => {
  it('builds the exact-scheme requirements from the task and live payTo', () => {
    const req = buildRequirements(TASK, PAY_TO);
    expect(req).toEqual({
      scheme: 'exact',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '5000000',
      payTo: PAY_TO,
      maxTimeoutSeconds: 3600,
      extra: { name: 'USD Coin', version: '2' },
    });
    expect(PaymentRequirementsV2.safeParse(req).success).toBe(true);
  });

  it('honours the EIP-712 env override and the Sepolia asset', () => {
    const req = buildRequirements(TASK, PAY_TO, { X402_EIP712_NAME: 'USDC' });
    expect(req.extra).toEqual({ name: 'USDC', version: '2' });
    const sep = buildRequirements({ ...TASK, bounty_network: 'eip155:84532' }, PAY_TO, { X402_EIP712_NAME: 'X' });
    expect(sep.asset).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
    expect(sep.extra).toEqual({ name: 'USDC', version: '2' });
  });

  it('throws on missing bounty, unsupported network, or bad payTo', () => {
    expect(() => buildRequirements({ ...TASK, bounty_amount: null }, PAY_TO)).toThrow(/bounty_amount/);
    expect(() => buildRequirements({ ...TASK, bounty_network: 'base-mainnet' }, PAY_TO)).toThrow(/bounty_network/);
    expect(() => buildRequirements({ ...TASK, bounty_network: null }, PAY_TO)).toThrow(/bounty_network/);
    expect(() => buildRequirements(TASK, '0xabc')).toThrow(/payTo/);
    expect(() => buildRequirements({ ...TASK, bounty_amount: '5.00' }, PAY_TO)).toThrow();
  });

  it('wraps requirements in the v2 PaymentRequired envelope', () => {
    const req = buildRequirements(TASK, PAY_TO);
    expect(buildPaymentRequired(TASK, req)).toEqual({
      x402Version: 2,
      resource: {
        url: 'https://api.basedagents.ai/v1/tasks/task_abc/accept',
        description: 'BasedAgents task task_abc bounty',
        mimeType: 'application/json',
      },
      accepts: [req],
    });
    const withErr = buildPaymentRequired(TASK, req, 'payment_required');
    expect(withErr.error).toBe('payment_required');
    expect(Object.keys(buildPaymentRequired(TASK, req))).not.toContain('error');
  });

  it('encodeB64Json is standard base64 of the JSON', () => {
    const req = buildRequirements(TASK, PAY_TO);
    const pr = buildPaymentRequired(TASK, req);
    const encoded = encodeB64Json(pr);
    expect(encoded).toBe(btoa(JSON.stringify(pr)));
    expect(JSON.parse(new TextDecoder().decode(base64ToBytes(encoded)))).toEqual(pr);
    // and it round-trips through decodePaymentHeader-style base64 for a payload
    expect(decodePaymentHeader(encodeB64Json(makePayload())).accepted).toEqual(req);
  });
});

describe('localPrechecks', () => {
  const req = buildRequirements(TASK, PAY_TO);
  const parse = (o: Record<string, unknown>) => PaymentPayloadV2.parse(o);

  it('passes a well-bound payload', () => {
    expect(localPrechecks(parse(makePayload()), req, NOW)).toEqual({ ok: true });
  });

  it('recipient_mismatch (case-insensitive compare)', () => {
    const upper = PAY_TO.replace(/1/g, '1').toUpperCase().replace('0X', '0x');
    expect(localPrechecks(parse(makePayload({ auth: { to: upper } })), req, NOW)).toEqual({ ok: true });
    const other = '0x3333333333333333333333333333333333333333';
    expect(localPrechecks(parse(makePayload({ auth: { to: other } })), req, NOW)).toEqual({
      ok: false,
      reason: 'recipient_mismatch',
      expected: PAY_TO,
      got: other,
    });
  });

  it('amount_mismatch uses BigInt equality', () => {
    expect(localPrechecks(parse(makePayload({ auth: { value: '05000000' } })), req, NOW)).toEqual({ ok: true });
    expect(localPrechecks(parse(makePayload({ auth: { value: '5000001' } })), req, NOW)).toEqual({
      ok: false,
      reason: 'amount_mismatch',
      expected: '5000000',
      got: '5000001',
    });
    expect(localPrechecks(parse(makePayload({ auth: { value: '99999999999999999999999999' } })), req, NOW).ok).toBe(false);
  });

  it('requirements_mismatch for each of network/asset/payTo/amount in accepted', () => {
    const sepolia = ASSETS['eip155:84532'].asset;
    const other = '0x3333333333333333333333333333333333333333';
    const r1 = localPrechecks(parse(makePayload({ accepted: { network: 'eip155:84532' } })), req, NOW);
    expect(r1).toEqual({ ok: false, reason: 'requirements_mismatch', expected: 'network=eip155:8453', got: 'network=eip155:84532' });
    const r2 = localPrechecks(parse(makePayload({ accepted: { asset: sepolia } })), req, NOW);
    expect(r2).toMatchObject({ ok: false, reason: 'requirements_mismatch', got: `asset=${sepolia}` });
    const r3 = localPrechecks(parse(makePayload({ accepted: { payTo: other } })), req, NOW);
    expect(r3).toMatchObject({ ok: false, reason: 'requirements_mismatch', got: `payTo=${other}` });
    const r4 = localPrechecks(parse(makePayload({ accepted: { amount: '5000001' } })), req, NOW);
    expect(r4).toMatchObject({ ok: false, reason: 'requirements_mismatch', expected: 'amount=5000000', got: 'amount=5000001' });
    // asset compare is case-insensitive
    const lower = localPrechecks(parse(makePayload({ accepted: { asset: req.asset.toLowerCase() as never } })), req, NOW);
    expect(lower).toEqual({ ok: true });
    // several at once are all reported
    const multi = localPrechecks(parse(makePayload({ accepted: { network: 'eip155:84532', amount: '1' } })), req, NOW);
    expect(multi).toMatchObject({ reason: 'requirements_mismatch', got: 'network=eip155:84532,amount=1' });
  });

  it('not_yet_valid when validAfter is in the future', () => {
    expect(localPrechecks(parse(makePayload({ auth: { validAfter: String(NOW) } })), req, NOW)).toEqual({ ok: true });
    expect(localPrechecks(parse(makePayload({ auth: { validAfter: String(NOW + 1) } })), req, NOW)).toEqual({
      ok: false,
      reason: 'not_yet_valid',
      expected: `validAfter<=${NOW}`,
      got: String(NOW + 1),
    });
  });

  it('valid_before_out_of_range enforces [now+120, now+4200]', () => {
    const ok = (vb: number) => localPrechecks(parse(makePayload({ auth: { validBefore: String(vb) } })), req, NOW);
    expect(ok(NOW + 120)).toEqual({ ok: true });
    expect(ok(NOW + 4200)).toEqual({ ok: true });
    expect(ok(NOW + 119)).toEqual({
      ok: false,
      reason: 'valid_before_out_of_range',
      expected: `${NOW + 120}..${NOW + 4200}`,
      got: String(NOW + 119),
    });
    expect(ok(NOW + 4201)).toMatchObject({ ok: false, reason: 'valid_before_out_of_range' });
    expect(ok(0)).toMatchObject({ ok: false, reason: 'valid_before_out_of_range' });
  });

  it('reports the recipient before the amount before the accepted block', () => {
    const other = '0x3333333333333333333333333333333333333333';
    const p = parse(makePayload({ auth: { to: other, value: '1', validBefore: '1' }, accepted: { amount: '1' } }));
    expect(localPrechecks(p, req, NOW)).toMatchObject({ reason: 'recipient_mismatch' });
    const p2 = parse(makePayload({ auth: { value: '1', validBefore: '1' }, accepted: { amount: '1' } }));
    expect(localPrechecks(p2, req, NOW)).toMatchObject({ reason: 'amount_mismatch' });
    const p3 = parse(makePayload({ auth: { validBefore: '1' }, accepted: { network: 'eip155:84532' } }));
    expect(localPrechecks(p3, req, NOW)).toMatchObject({ reason: 'requirements_mismatch' });
  });
});

describe('usdcToAtomic', () => {
  it('converts plain decimals with up to 6 fraction digits', () => {
    expect(usdcToAtomic('5.00')).toBe('5000000');
    expect(usdcToAtomic('5')).toBe('5000000');
    expect(usdcToAtomic('0.5')).toBe('500000');
    expect(usdcToAtomic('0.000001')).toBe('1');
    expect(usdcToAtomic('12.345678')).toBe('12345678');
    expect(usdcToAtomic('1000')).toBe('1000000000');
    expect(usdcToAtomic('1000.000000')).toBe('1000000000');
    expect(BOUNTY_AMOUNT_RE.test(usdcToAtomic('0.000001'))).toBe(true);
  });

  it('rejects > 6 decimals, > 1000 USDC, zero, and anything but a plain decimal', () => {
    expect(() => usdcToAtomic('5.1234567')).toThrow(/6 decimals/);
    expect(() => usdcToAtomic('1000.000001')).toThrow(/1000 USDC/);
    expect(() => usdcToAtomic('1001')).toThrow(/1000 USDC/);
    expect(() => usdcToAtomic('0')).toThrow(/greater than zero/);
    expect(() => usdcToAtomic('0.000000')).toThrow(/greater than zero/);
    for (const bad of ['$5.00', '', ' 5', '5.', '.5', '-5', '1e3', '5,00', '12345678', 'abc']) {
      expect(() => usdcToAtomic(bad), bad).toThrow();
    }
    expect(() => usdcToAtomic(5 as never)).toThrow();
  });
});

describe('atomicToDisplay', () => {
  it('always shows at least 2 decimals and trims zeros beyond them', () => {
    expect(atomicToDisplay('5000000')).toBe('5.00');
    expect(atomicToDisplay('5500000')).toBe('5.50');
    expect(atomicToDisplay('5120000')).toBe('5.12');
    expect(atomicToDisplay('5100000')).toBe('5.10');
    expect(atomicToDisplay('5123456')).toBe('5.123456');
    expect(atomicToDisplay('5123450')).toBe('5.12345');
    expect(atomicToDisplay('1')).toBe('0.000001');
    expect(atomicToDisplay('0')).toBe('0.00');
    expect(atomicToDisplay('1000000000')).toBe('1000.00');
    expect(atomicToDisplay('123456789012345678')).toBe('123456789012.345678');
  });

  it('round-trips with usdcToAtomic', () => {
    for (const d of ['5.00', '0.10', '999.999999', '1000.00']) {
      expect(atomicToDisplay(usdcToAtomic(d))).toBe(d);
    }
  });

  it('rejects non-integer strings', () => {
    for (const bad of ['', '5.0', '-1', 'abc', '0x10']) expect(() => atomicToDisplay(bad), bad).toThrow();
    expect(() => atomicToDisplay(5 as never)).toThrow();
  });
});
