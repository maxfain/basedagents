/**
 * Test-only helpers for the sign-at-accept payment flow. Not shipped: only
 * *.test.ts files import this module.
 */
import type { Facilitator, VerifyOutcome, SettleOutcome } from './cdp-facilitator.js';
import { setPaymentProviderForTests } from './index.js';
import { encodeB64Json, type PaymentRequirementsV2, type PaymentPayloadV2 } from './x402.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from './evm.js';
import { AUTHORIZATION_USED_TOPIC } from './arc.js';

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

type ArcRpcCall = { method: string; params: unknown[] };

/**
 * A fake Arc node for the relay (payments/arc.ts): the token's authorization state,
 * a one-transaction mempool, receipts and AuthorizationUsed logs. Each sent
 * transaction is mined (and its authorization used) on the first receipt poll
 * unless `minedAfterPolls` says otherwise.
 */
export class FakeArcNode {
  calls: ArcRpcCall[] = [];
  used = new Map<string, string>(); // authorizer:nonce → tx hash
  logs: Array<{ topics: string[]; transactionHash: string; blockNumber: string }> = [];
  latestNonce = 4n;
  pendingNonce = 4n;
  baseFee = 20_000_000_000n;
  tip = 2000n;
  balance = 100n * 10n ** 18n; // 100 USDC of native balance
  head = 25_000_000n;
  estimateError: string | null = null;
  sendError: string | null = null;
  /** Polls of eth_getTransactionReceipt before the tx is mined (Infinity: never). */
  minedAfterPolls = 0;
  receiptStatus = '0x1';
  sent: string[] = [];
  private polls = 0;
  private mined = new Map<string, string>();

  constructor(private readonly nowSec: number = Math.floor(Date.now() / 1000)) {}

  handle(req: ArcRpcCall): unknown {
    this.calls.push(req);
    const p = req.params;
    switch (req.method) {
      case 'eth_call': {
        const data = (p[0] as { data: string }).data;
        const key = `0x${data.slice(10 + 24, 10 + 64)}:0x${data.slice(10 + 64)}`.toLowerCase();
        return '0x' + (this.used.has(key) ? '1' : '0').padStart(64, '0');
      }
      case 'eth_getTransactionCount': return '0x' + (p[1] === 'pending' ? this.pendingNonce : this.latestNonce).toString(16);
      case 'eth_estimateGas': if (this.estimateError) throw { code: 3, message: this.estimateError }; return '0x' + (80_000).toString(16);
      case 'eth_getBlockByNumber': return { number: '0x' + this.head.toString(16), timestamp: '0x' + this.nowSec.toString(16), baseFeePerGas: '0x' + this.baseFee.toString(16) };
      case 'eth_maxPriorityFeePerGas': return '0x' + this.tip.toString(16);
      case 'eth_getBalance': return '0x' + this.balance.toString(16);
      case 'eth_sendRawTransaction': {
        if (this.sendError) throw { code: -32000, message: this.sendError };
        const raw = p[0] as string;
        this.sent.push(raw);
        const hash = '0x' + bytesToHex(keccak_256(hexToBytes(raw)));
        this.mined.set(hash, raw);
        // Mining it uses the authorization: from and nonce sit in the calldata's 1st and 6th words.
        const at = raw.indexOf('e3ee160e') + 8;
        if (at > 8 && this.receiptStatus === '0x1') {
          const from = raw.slice(at + 24, at + 64);
          const nonce = raw.slice(at + 64 * 5, at + 64 * 6);
          this.used.set(`0x${from}:0x${nonce}`.toLowerCase(), hash);
          this.logs.push({ topics: [AUTHORIZATION_USED_TOPIC, '0x' + from.padStart(64, '0'), '0x' + nonce], transactionHash: hash, blockNumber: '0x' + this.head.toString(16) });
        }
        return hash;
      }
      case 'eth_getTransactionReceipt': {
        const hash = p[0] as string;
        if (!this.mined.has(hash) || this.polls++ < this.minedAfterPolls) return null;
        return { transactionHash: hash, status: this.receiptStatus };
      }
      case 'eth_getLogs': {
        const topics = (p[0] as { topics: string[] }).topics;
        return this.logs.filter((l) => l.topics.every((t, i) => t.toLowerCase() === topics[i]?.toLowerCase()));
      }
      default: throw { code: -32601, message: `method ${req.method} not found` };
    }
  }

  fetch(down: string[] = []): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (down.includes(url)) return new Response('busy', { status: 503 });
      const req = JSON.parse(String(init?.body)) as ArcRpcCall;
      try {
        return Response.json({ jsonrpc: '2.0', id: 1, result: this.handle(req) });
      } catch (err) {
        return Response.json({ jsonrpc: '2.0', id: 1, error: err });
      }
    }) as typeof fetch;
  }
}
