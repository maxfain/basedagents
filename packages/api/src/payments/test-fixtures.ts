/**
 * Test-only helpers for the sign-at-accept payment flow. Not shipped: only
 * *.test.ts files import this module.
 */
import type { Facilitator, VerifyOutcome, SettleOutcome } from './cdp-facilitator.js';
import { setPaymentProviderForTests } from './index.js';
import { encodeB64Json, type PaymentRequirementsV2, type PaymentPayloadV2 } from './x402.js';

export const TEST_WALLET = '0x' + '1'.repeat(40);
export const TEST_PAYER = '0x' + '2'.repeat(40);
export const TEST_TX = '0x' + 'ab'.repeat(32);

export interface FakeFacilitator extends Facilitator {
  verifyCalls: Array<{ payload: PaymentPayloadV2; requirements: PaymentRequirementsV2 }>;
  settleCalls: Array<{ payload: PaymentPayloadV2; requirements: PaymentRequirementsV2 }>;
  /** Replace the next outcomes; each array is consumed FIFO, the last value repeats. */
  verifyOutcomes: VerifyOutcome[];
  settleOutcomes: SettleOutcome[];
}

function next<T>(queue: T[], fallback: T): T {
  if (queue.length === 0) return fallback;
  return queue.length === 1 ? queue[0] : (queue.shift() as T);
}

/** A facilitator whose answers are scripted; defaults to "valid" and "settled". */
export function fakeFacilitator(opts: { verify?: VerifyOutcome[]; settle?: SettleOutcome[] } = {}): FakeFacilitator {
  const f: FakeFacilitator = {
    verifyCalls: [],
    settleCalls: [],
    verifyOutcomes: opts.verify ?? [],
    settleOutcomes: opts.settle ?? [],
    async verify(payload, requirements) {
      f.verifyCalls.push({ payload, requirements });
      return next(f.verifyOutcomes, { kind: 'valid', payer: TEST_PAYER });
    },
    async settle(payload, requirements) {
      f.settleCalls.push({ payload, requirements });
      return next(f.settleOutcomes, { kind: 'settled', transaction: TEST_TX, network: requirements.network, payer: TEST_PAYER });
    },
    async supported() {
      return { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }], extensions: [], signers: {} };
    },
  };
  return f;
}

/** Install a fake facilitator as the provider for the current test. Returns it. */
export function enablePaymentsForTests(opts: { verify?: VerifyOutcome[]; settle?: SettleOutcome[] } = {}): FakeFacilitator {
  const f = fakeFacilitator(opts);
  setPaymentProviderForTests(f);
  return f;
}

export function disablePaymentsForTests(): void {
  setPaymentProviderForTests(null);
}

export function resetPaymentsForTests(): void {
  setPaymentProviderForTests(undefined);
}

function randomNonce(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Build a syntactically valid x402 v2 payload for `requirements` (the
 * facilitator is faked, so the signature bytes are never checked).
 */
export function paymentPayloadFor(
  requirements: PaymentRequirementsV2,
  nowSec: number = Math.floor(Date.now() / 1000),
  overrides: { authorization?: Partial<PaymentPayloadV2['payload']['authorization']>; accepted?: Partial<PaymentRequirementsV2> } = {},
): PaymentPayloadV2 {
  return {
    x402Version: 2,
    accepted: { ...requirements, ...(overrides.accepted ?? {}) },
    payload: {
      signature: '0x' + 'cd'.repeat(65),
      authorization: {
        from: TEST_PAYER,
        to: requirements.payTo,
        value: requirements.amount,
        validAfter: String(nowSec - 60),
        validBefore: String(nowSec + 3600),
        nonce: randomNonce(),
        ...(overrides.authorization ?? {}),
      },
    },
  };
}

/** The PAYMENT-SIGNATURE header value for `requirements`. */
export function paymentHeaderFor(
  requirements: PaymentRequirementsV2,
  nowSec?: number,
  overrides?: Parameters<typeof paymentPayloadFor>[2],
): string {
  return encodeB64Json(paymentPayloadFor(requirements, nowSec, overrides));
}
