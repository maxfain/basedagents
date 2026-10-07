/**
 * Test-only helpers for the sign-at-accept payment flow. Not shipped: only
 * *.test.ts files import this module.
 */
import type { Facilitator, VerifyOutcome, SettleOutcome } from './cdp-facilitator.js';
import { setPaymentProviderForTests } from './index.js';
import { encodeB64Json, type PaymentRequirementsV2, type PaymentPayloadV2 } from './x402.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, type RlpItem } from './evm.js';
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

/** Minimal RLP decoder (tests only): strings → bytes, lists → arrays. */
export function rlpDecode(input: Uint8Array): RlpItem {
  const read = (at: number): [RlpItem, number] => {
    const b = input[at];
    const int = (from: number, len: number) => input.slice(from, from + len).reduce((n, x) => n * 256 + x, 0);
    if (b < 0x80) return [input.slice(at, at + 1), at + 1];
    if (b <= 0xb7) return [input.slice(at + 1, at + 1 + b - 0x80), at + 1 + b - 0x80];
    if (b <= 0xbf) { const ll = b - 0xb7; const len = int(at + 1, ll); return [input.slice(at + 1 + ll, at + 1 + ll + len), at + 1 + ll + len]; }
    const ll = b <= 0xf7 ? 0 : b - 0xf7;
    const len = b <= 0xf7 ? b - 0xc0 : int(at + 1, ll);
    const end = at + 1 + ll + len;
    const out: RlpItem[] = [];
    for (let p = at + 1 + ll; p < end;) { const [item, next] = read(p); out.push(item); p = next; }
    return [out, end];
  };
  return read(0)[0];
}

const toBig = (b: Uint8Array) => (b.length ? BigInt('0x' + bytesToHex(b)) : 0n);
const hexOf = (n: bigint) => '0x' + n.toString(16);

/** The authorization a transferWithAuthorization calldata carries (lowercase), or null for other calldata. */
export function authorizationInCalldata(data: string): { from: string; to: string; value: bigint; validBefore: bigint; nonce: string } | null {
  const d = data.replace(/^0x/, '').toLowerCase();
  if (!d.startsWith('e3ee160e')) return null;
  const w = (i: number) => d.slice(8 + i * 64, 8 + (i + 1) * 64);
  return { from: '0x' + w(0).slice(24), to: '0x' + w(1).slice(24), value: BigInt('0x' + w(2)), validBefore: BigInt('0x' + w(4)), nonce: '0x' + w(5) };
}

/** A decoded type-2 transaction from the escrow wallet. */
export interface FakeArcTx { hash: string; raw: string; nonce: bigint; data: string }

/** Decode a signed type-2 transaction (0x02 ‖ rlp): its hash, nonce and calldata. */
export function decodeArcTx(raw: string): FakeArcTx {
  const bytes = hexToBytes(raw);
  const fields = rlpDecode(bytes.slice(1)) as Uint8Array[];
  return { hash: '0x' + bytesToHex(keccak_256(bytes)), raw, nonce: toBig(fields[1]), data: '0x' + bytesToHex(fields[7]) };
}

/**
 * A fake Arc node for the relay (payments/arc.ts), keeping the state the relay reads:
 *  - the escrow wallet's nonces: `latest` counts mined transactions, `pending` adds the mempool,
 *    and a broadcast on a nonce already taken is refused like a real node refuses it;
 *  - USDC's authorization state, changed only when a transaction is MINED (and only when its
 *    authorization is unused and unexpired at that block), with its AuthorizationUsed log;
 *  - blocks two a second, so every block number has a timestamp, and the chain's clock is
 *    `nowSec` (the head's timestamp), moved on with `advance()`;
 *  - eth_getLogs honours fromBlock/toBlock and refuses more than 5,000 blocks, as Arc's nodes do;
 *  - eth_call at a block number it hasn't reached answers "header not found".
 * With `autoMine`, the mempool is mined on the receipt poll after `mineAfterPolls` polls;
 * otherwise only `mine()` mines it.
 */
export class FakeArcNode {
  calls: ArcRpcCall[] = [];
  /** authorizer:nonce (lowercase) → the transaction that used it and its block. */
  used = new Map<string, { hash: string; block: bigint }>();
  logs: Array<{ topics: string[]; transactionHash: string; blockNumber: bigint }> = [];
  mempool: FakeArcTx[] = [];
  receipts = new Map<string, { status: string; blockNumber: bigint }>();
  /** Raw transactions the node accepted, in order. */
  sent: string[] = [];
  latestNonce = 4n;
  baseFee = 20_000_000_000n;
  tip = 2000n;
  balance = 100n * 10n ** 18n; // 100 USDC of native balance
  head = 25_000_000n;
  autoMine = true;
  mineAfterPolls = 0;
  estimateError: string | null = null;
  sendError: string | null = null;
  /** Mined escrow transfers revert (e.g. the recipient was blocklisted after the simulation). */
  revertOnMine = false;
  /** eth_call pinned to a block number errors, as a node a block behind does. */
  lagPinned = false;
  /** Called with the transaction about to enter the mempool, before the node checks its nonce. */
  beforeSend?: (tx: FakeArcTx) => void;
  /** Called on each receipt poll, before the node answers it. */
  onReceiptPoll?: (hash: string) => void;
  private readonly genesisTs: bigint;
  private polls = 0;

  constructor(nowSec: number = Math.floor(Date.now() / 1000)) {
    this.genesisTs = BigInt(nowSec) - this.head / 2n;
  }

  timestampOf(block: bigint): bigint { return this.genesisTs + block / 2n; }
  get nowSec(): bigint { return this.timestampOf(this.head); }
  /** Let `seconds` pass on the chain. */
  advance(seconds: number): void { this.head += BigInt(seconds) * 2n; }
  /** The block whose timestamp is `ts` (the first of its two). */
  blockOf(ts: bigint): bigint { return (ts - this.genesisTs) * 2n; }

  /** Mark an authorization used by `hash` at `block`, with its log. */
  markUsed(authorizer: string, nonce: string, hash: string, block: bigint): void {
    this.used.set(`${authorizer}:${nonce}`.toLowerCase(), { hash, block });
    this.logs.push({ topics: [AUTHORIZATION_USED_TOPIC, '0x' + authorizer.slice(2).toLowerCase().padStart(64, '0'), nonce.toLowerCase()], transactionHash: hash, blockNumber: block });
  }

  /** Mine the mempool in nonce order, one block per transaction. */
  mine(): void {
    this.mempool.sort((a, b) => (a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0));
    while (this.mempool.length && this.mempool[0].nonce === this.latestNonce) {
      const tx = this.mempool.shift()!;
      this.head += 1n;
      const a = authorizationInCalldata(tx.data);
      let ok = true;
      if (a) {
        ok = !this.revertOnMine && !this.used.has(`${a.from}:${a.nonce}`) && this.timestampOf(this.head) < a.validBefore;
        if (ok) this.markUsed(a.from, a.nonce, tx.hash, this.head);
      }
      this.receipts.set(tx.hash, { status: ok ? '0x1' : '0x0', blockNumber: this.head });
      this.latestNonce += 1n;
    }
  }

  /** Forget a pending transaction, as a node that dropped it would. */
  drop(hash: string): void {
    this.mempool = this.mempool.filter((t) => t.hash !== hash);
  }

  /** Put a transaction of the escrow wallet's straight into the mempool (another payout's, say). */
  inject(tx: FakeArcTx): void {
    this.mempool.push(tx);
  }

  private block(n: bigint) {
    return { number: hexOf(n), timestamp: hexOf(this.timestampOf(n)), baseFeePerGas: hexOf(this.baseFee) };
  }

  handle(req: ArcRpcCall): unknown {
    this.calls.push(req);
    const p = req.params;
    switch (req.method) {
      case 'eth_call': {
        const data = (p[0] as { data: string }).data.toLowerCase();
        const tag = p[1] as string;
        let at = this.head;
        if (tag !== 'latest') {
          at = BigInt(tag);
          if (at > this.head || this.lagPinned) throw { code: -32000, message: 'header not found' };
        }
        const key = `0x${data.slice(10 + 24, 10 + 64)}:0x${data.slice(10 + 64, 10 + 128)}`;
        const use = this.used.get(key);
        return '0x' + (use && use.block <= at ? '1' : '0').padStart(64, '0');
      }
      case 'eth_getTransactionCount':
        return hexOf(p[1] === 'pending' ? this.latestNonce + BigInt(this.mempool.length) : this.latestNonce);
      case 'eth_estimateGas': {
        if (this.estimateError) throw { code: 3, message: this.estimateError };
        const a = authorizationInCalldata((p[0] as { data: string }).data);
        if (a && this.used.has(`${a.from}:${a.nonce}`)) throw { code: 3, message: 'execution reverted: FiatTokenV2: authorization is used or canceled' };
        if (a && this.timestampOf(this.head + 1n) >= a.validBefore) throw { code: 3, message: 'execution reverted: FiatTokenV2: authorization is expired' };
        return hexOf(80_000n);
      }
      case 'eth_getBlockByNumber': {
        const tag = p[0] as string;
        if (tag === 'latest') return this.block(this.head);
        const n = BigInt(tag);
        return n <= this.head && n >= 0n ? this.block(n) : null;
      }
      case 'eth_maxPriorityFeePerGas': return hexOf(this.tip);
      case 'eth_getBalance': return hexOf(this.balance);
      case 'eth_sendRawTransaction': {
        if (this.sendError) throw { code: -32000, message: this.sendError };
        const tx = decodeArcTx(p[0] as string);
        this.beforeSend?.(tx);
        if (this.receipts.has(tx.hash) || this.mempool.some((t) => t.hash === tx.hash)) throw { code: -32000, message: 'already known' };
        if (tx.nonce < this.latestNonce) throw { code: -32000, message: 'nonce too low' };
        if (this.mempool.some((t) => t.nonce === tx.nonce)) throw { code: -32000, message: 'replacement transaction underpriced' };
        this.mempool.push(tx);
        this.sent.push(tx.raw);
        return tx.hash;
      }
      case 'eth_getTransactionReceipt': {
        const hash = p[0] as string;
        this.onReceiptPoll?.(hash);
        if (!this.receipts.has(hash) && this.autoMine && this.mempool.some((t) => t.hash === hash) && this.polls++ >= this.mineAfterPolls) this.mine();
        const r = this.receipts.get(hash);
        return r ? { transactionHash: hash, status: r.status, blockNumber: hexOf(r.blockNumber) } : null;
      }
      case 'eth_getLogs': {
        const q = p[0] as { fromBlock: string; toBlock: string; topics: string[] };
        const from = BigInt(q.fromBlock);
        const to = BigInt(q.toBlock);
        if (to - from + 1n > 5_000n) throw { code: -32000, message: 'requested range too large' };
        return this.logs
          .filter((l) => l.blockNumber >= from && l.blockNumber <= to && l.topics.every((t, i) => t.toLowerCase() === q.topics[i]?.toLowerCase()))
          .map((l) => ({ transactionHash: l.transactionHash, blockNumber: hexOf(l.blockNumber), topics: l.topics }));
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
