/**
 * Arc (eip155:5042): who settles what.
 *
 *   deposit          a buyer's transfer into the escrow wallet → Circle's Facilitator
 *                    Service (circle-facilitator.ts): it screens both parties, pays the
 *                    gas, and binds only our own escrow wallet to the Circle account.
 *   release / refund a transfer signed by the escrow wallet → this relay: the escrow
 *                    wallet broadcasts its own `transferWithAuthorization` and pays the
 *                    gas in USDC (Arc's gas token). Circle would bind the agent's or
 *                    buyer's wallet to our Circle account, so those never go there.
 *
 * The relay is a `Facilitator` like the others, so settle.ts drives it with the same
 * outcome table. Safety comes from EIP-3009 itself: the authorization's nonce can be
 * used once, so a retry after a lost answer can never pay twice. Before sending, the
 * relay asks the chain whether the authorization was already used (and if so, by which
 * transaction), and it keeps at most one escrow-wallet transaction in flight.
 *
 * The escrow wallet must hold a little USDC on Arc beyond the deposits it holds: each
 * transfer costs about 0.002 USDC in gas. A shortfall answers `insufficient_funds`.
 */
import { ARC_NETWORK } from '../types/index.js';
import { rpcEndpoints } from '../wallets/bind.js';
import type { Facilitator, SettleOutcome, VerifyOutcome } from './cdp-facilitator.js';
import { TX_HASH_RE } from './cdp-facilitator.js';
import { CircleFacilitator, DEFAULT_CIRCLE_FACILITATOR_URL } from './circle-facilitator.js';
import { addressFromPrivateKey, parseHousePrivateKey, sameAddress, signEip1559 } from './evm.js';
import { ASSETS, type PaymentPayloadV2, type PaymentRequirementsV2 } from './x402.js';

const ARC_CHAIN_ID = 5042n;
const ARC_USDC = ASSETS[ARC_NETWORK].asset;
/** transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32) */
const TRANSFER_WITH_AUTHORIZATION = 'e3ee160e';
/** authorizationState(address,bytes32) → bool */
const AUTHORIZATION_STATE = 'e94a0102';
/** keccak256("AuthorizationUsed(address,bytes32)") */
export const AUTHORIZATION_USED_TOPIC = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5';
/** Arc's mempool drops a transaction whose maxFeePerGas is under 20 gwei, silently. */
export const ARC_MIN_MAX_FEE_WEI = 20_000_000_000n;
/** Native USDC has 18 decimals; the ERC-20 interface (and our amounts) have 6. */
const WEI_PER_ATOMIC = 10n ** 12n;
/** Arc's nodes answer eth_getLogs for at most ~5,000 blocks per call (about 40 minutes). */
export const ARC_LOG_CHUNK_BLOCKS = 5_000n;
const ARC_LOG_MAX_CHUNKS = 8;
/** Arc finalizes in under a second; past this the leg is `pending` and the retry looks again. */
export const ARC_RECEIPT_WAIT_MS = 6_000;
const RPC_TIMEOUT_MS = 8_000;

// ─── JSON-RPC ───

/** The node answered with a JSON-RPC error: its verdict (e.g. a revert), not an outage. */
export class RpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'RpcError';
  }
}

/** No node answered. Nothing is known about the call. */
export class RpcUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcUnavailable';
  }
}

export class ArcRpc {
  constructor(
    private readonly urls: string[],
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {
    if (urls.length === 0) throw new Error('ArcRpc needs at least one endpoint');
  }

  /** Tries each endpoint in turn on transport failure, 429 or 5xx; a JSON-RPC error is final. */
  async call<T = string>(method: string, params: unknown[]): Promise<T> {
    let last = 'no endpoint answered';
    for (const url of this.urls) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        });
      } catch (err) {
        last = `${url}: ${(err as Error)?.message ?? String(err)}`;
        continue;
      }
      if (res.status === 429 || res.status >= 500) { last = `${url}: HTTP ${res.status}`; continue; }
      let body: { result?: T; error?: { code?: number; message?: string } };
      try {
        body = await res.json() as typeof body;
      } catch {
        last = `${url}: non-JSON answer (HTTP ${res.status})`;
        continue;
      }
      if (body.error) throw new RpcError(body.error.message ?? 'JSON-RPC error', body.error.code);
      if (body.result === undefined) { last = `${url}: no result`; continue; }
      return body.result;
    }
    throw new RpcUnavailable(`${method}: ${last}`);
  }
}

// ─── ABI helpers ───

function word(hex: string): string {
  const h = hex.replace(/^0x/, '').toLowerCase();
  if (h.length > 64) throw new Error('word: longer than 32 bytes');
  return h.padStart(64, '0');
}

function uintWord(v: string | bigint): string {
  return BigInt(v).toString(16).padStart(64, '0');
}

/** Calldata for USDC's transferWithAuthorization with the signature split into v, r, s. */
export function transferWithAuthorizationCalldata(payload: PaymentPayloadV2): string {
  const a = payload.payload.authorization;
  const sig = payload.payload.signature.slice(2);
  if (sig.length !== 130) throw new Error('expected a 65-byte r‖s‖v signature');
  let v = parseInt(sig.slice(128, 130), 16);
  if (v < 27) v += 27;
  return '0x' + TRANSFER_WITH_AUTHORIZATION + word(a.from) + word(a.to) + uintWord(a.value) + uintWord(a.validAfter)
    + uintWord(a.validBefore) + word(a.nonce) + uintWord(BigInt(v)) + sig.slice(0, 64) + sig.slice(64, 128);
}

/** A FiatToken revert reason → the structured reason settle.ts classifies. */
export function revertReason(message: string): string {
  if (/authorization is used or canceled/i.test(message)) return 'invalid_exact_evm_nonce_already_used';
  if (/authorization is expired/i.test(message)) return 'invalid_exact_evm_payload_authorization_valid_before';
  if (/authorization is not yet valid/i.test(message)) return 'authorization_not_yet_valid';
  if (/exceeds balance|insufficient/i.test(message)) return 'insufficient_funds';
  if (/blacklist|blocklist|blocked/i.test(message)) return 'invalid_exact_evm_payload_authorization_to_address_kyt';
  if (/invalid signature/i.test(message)) return 'invalid_exact_evm_payload_signature';
  return 'transaction_reverted';
}

// ─── The relay ───

export interface ArcRelayConfig {
  privateKey: Uint8Array;
  rpc: ArcRpc;
  /** Milliseconds since the epoch; injected by tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  receiptWaitMs?: number;
}

interface Receipt { status?: string; transactionHash?: string }
interface Block { number?: string; timestamp?: string; baseFeePerGas?: string }
interface Log { transactionHash?: string }
interface BlockRef { number: bigint; timestamp: bigint; baseFee: bigint }

/** Rounds of check → send → watch per settle call (a lost nonce race or a dropped tx starts a new round). */
const MAX_ROUNDS = 4;
/** How long a send waits for another escrow-wallet transaction to land before giving the slot back. */
export const ARC_IDLE_WAIT_MS = 4_000;
const POLL_MS = 400;
/** Blocks either side of the estimated validity window searched for an AuthorizationUsed log. */
const LOG_MARGIN_BLOCKS = 600n;
const hex = (n: bigint) => '0x' + n.toString(16);

export class ArcRelay implements Facilitator {
  readonly address: `0x${string}`;
  private readonly key: Uint8Array;
  private readonly rpc: ArcRpc;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly receiptWaitMs: number;

  constructor(cfg: ArcRelayConfig) {
    this.key = cfg.privateKey;
    this.address = addressFromPrivateKey(cfg.privateKey);
    this.rpc = cfg.rpc;
    this.now = cfg.now ?? (() => Date.now());
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.receiptWaitMs = cfg.receiptWaitMs ?? ARC_RECEIPT_WAIT_MS;
  }

  /** Deposits verify through Circle; the relay only sends the escrow wallet's own transfers. */
  async verify(): Promise<VerifyOutcome> {
    return { kind: 'unavailable', cause: 'malformed', detail: 'the Arc relay sends escrow-wallet transfers only; deposits verify through Circle' };
  }

  async supported(): Promise<unknown> {
    return { kinds: [{ x402Version: 2, scheme: 'exact', network: ARC_NETWORK, asset: ARC_USDC }], signer: this.address };
  }

  async settle(payload: PaymentPayloadV2, requirements: PaymentRequirementsV2): Promise<SettleOutcome> {
    try {
      return await this.send(payload, requirements);
    } catch (err) {
      if (err instanceof RpcUnavailable) return { kind: 'unavailable', cause: 'network', detail: `Arc RPC: ${err.message}`.slice(0, 500) };
      return { kind: 'unavailable', cause: 'server', detail: `Arc relay: ${String(err)}`.slice(0, 500) };
    }
  }

  private rejected(reason: string, message: string, transaction?: string): SettleOutcome {
    return transaction ? { kind: 'rejected', reason, message, transaction, http: 200 } : { kind: 'rejected', reason, message, http: 200 };
  }

  private retryLater(detail: string): SettleOutcome {
    return { kind: 'unavailable', cause: 'server', detail: `Arc relay: ${detail}`.slice(0, 500) };
  }

  /**
   * Every round starts from the chain: used → settled (with the transaction that used it);
   * expired → only by the chain's own clock; then one transaction, on a nonce no other
   * escrow-wallet transaction holds, watched until it lands or is lost.
   */
  private async send(payload: PaymentPayloadV2, req: PaymentRequirementsV2): Promise<SettleOutcome> {
    const auth = payload.payload.authorization;
    if (req.network !== ARC_NETWORK || !sameAddress(req.asset, ARC_USDC)) return this.rejected('unsupported_network', 'The Arc relay sends USDC on Arc only.');
    if (!sameAddress(auth.from, this.address)) return this.rejected('invalid_payload', 'The Arc relay sends only transfers signed by the escrow wallet.');
    if (!sameAddress(auth.to, req.payTo)) return this.rejected('invalid_exact_evm_payload_recipient_mismatch', 'The authorization pays someone other than payTo.');
    if (BigInt(auth.value) !== BigInt(req.amount)) return this.rejected('invalid_exact_evm_payload_authorization_value_mismatch', 'The authorization moves a different amount.');
    const data = transferWithAuthorizationCalldata(payload);
    const validBefore = BigInt(auth.validBefore);

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // 1. Already used? Then the money moved; report the transaction that moved it.
      const used = await this.ifUsed(auth, 'latest');
      if (used) return used;

      // 2. Expired? Only the chain's clock decides: until a block at or past validBefore
      //    exists, a transaction sent by an earlier attempt can still land, and calling the
      //    leg expired would let the cron sign a second transfer. Read at that very block
      //    (a node behind it errors instead of answering from older state), an unused
      //    authorization can never be used again.
      const head = await this.block('latest');
      if (head.timestamp >= validBefore) {
        let usedAtHead: SettleOutcome | null;
        try {
          usedAtHead = await this.ifUsed(auth, hex(head.number));
        } catch (err) {
          if (err instanceof RpcError) return this.retryLater(`could not read block ${head.number} yet (${err.message}); checking expiry again later`);
          throw err;
        }
        return usedAtHead ?? this.rejected('invalid_exact_evm_payload_authorization_valid_before', 'The authorization expired on Arc unused.');
      }

      // 3. One escrow-wallet transaction in flight at a time: wait for another to land
      //    (it may be this authorization's own, from an earlier attempt).
      const idle = await this.idleNonce();
      if (idle === null) return this.retryLater('an escrow-wallet transaction is still pending; retrying after it lands');
      if (idle.waited) continue; // something landed meanwhile: start again from the chain

      // 4. Simulate: a revert here is the token's verdict, and nothing was sent.
      let gas: bigint;
      try {
        gas = BigInt(await this.rpc.call('eth_estimateGas', [{ from: this.address, to: ARC_USDC, data }]));
      } catch (err) {
        if (!(err instanceof RpcError)) throw err;
        const reason = revertReason(err.message);
        if (reason === 'invalid_exact_evm_nonce_already_used') continue; // used since step 1: the next round reports it
        // Time is the chain's to call (step 2), not the simulation's.
        if (reason === 'invalid_exact_evm_payload_authorization_valid_before' || reason === 'authorization_not_yet_valid') {
          return this.retryLater(`simulation says ${reason}; the chain's clock decides on the next attempt`);
        }
        return this.rejected(reason, `Arc simulation: ${err.message}`.slice(0, 300));
      }

      // 5. Fees and the gas float: the transfer and its gas come out of one USDC balance.
      let tip = 0n;
      try {
        tip = BigInt(await this.rpc.call('eth_maxPriorityFeePerGas', []));
      } catch (err) {
        if (!(err instanceof RpcError)) throw err;
      }
      let maxFee = 2n * head.baseFee + tip;
      if (maxFee < ARC_MIN_MAX_FEE_WEI) maxFee = ARC_MIN_MAX_FEE_WEI;
      const gasLimit = (gas * 5n) / 4n;
      const balance = BigInt(await this.rpc.call('eth_getBalance', [this.address, 'latest']));
      const needed = BigInt(auth.value) * WEI_PER_ATOMIC + gasLimit * maxFee;
      if (balance < needed) {
        return this.rejected('insufficient_funds', `The escrow wallet holds ${balance} wei of USDC on Arc and needs ${needed} (the transfer plus gas). Top it up with a little USDC on Arc.`);
      }

      // 6. Sign and broadcast on the free nonce.
      const signed = signEip1559({
        chainId: ARC_CHAIN_ID, nonce: idle.nonce, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee,
        gas: gasLimit, to: ARC_USDC, value: 0n, data,
      }, this.key);
      try {
        await this.rpc.call('eth_sendRawTransaction', [signed.raw]);
      } catch (err) {
        if (!(err instanceof RpcError)) throw err; // unknown whether a node took it: the retry checks the chain first
        if (/insufficient funds/i.test(err.message)) return this.rejected('insufficient_funds', `Arc broadcast: ${err.message}`.slice(0, 300));
        // Another escrow-wallet transaction took this nonce (a concurrent payout): next round.
        if (/nonce too low|replacement transaction underpriced|nonce/i.test(err.message) && !/already known/i.test(err.message)) continue;
        if (!/already known/i.test(err.message)) return this.retryLater(`broadcast refused: ${err.message}`);
      }

      // 7. Watch it land (Arc finalizes in under a second).
      const watched = await this.watch(signed.hash, idle.nonce);
      if (watched === 'mined') return { kind: 'settled', transaction: signed.hash, network: ARC_NETWORK, payer: this.address };
      if (watched === 'pending') return { kind: 'pending', transaction: signed.hash };
      // Reverted after a clean simulation: retried later (with backoff), never resent in a loop that burns gas.
      if (watched === 'reverted') return this.rejected('transaction_reverted', `Arc transaction ${signed.hash} reverted.`, signed.hash);
      // 'lost': another transaction took its nonce, so it can never land. Start again from the chain.
    }
    return this.retryLater(`no transfer landed after ${MAX_ROUNDS} rounds; retrying later`);
  }

  /** Mined, reverted, lost (its nonce went to another transaction) or still pending at the deadline. */
  private async watch(hash: string, nonce: bigint): Promise<'mined' | 'reverted' | 'lost' | 'pending'> {
    const deadline = this.now() + this.receiptWaitMs;
    for (;;) {
      const receipt = await this.rpc.call<Receipt | null>('eth_getTransactionReceipt', [hash]).catch((err) => {
        if (err instanceof RpcError) return null;
        throw err;
      });
      if (receipt) return receipt.status === '0x1' ? 'mined' : 'reverted';
      // The nonce is used but not by this transaction: it was replaced or dropped.
      if (BigInt(await this.rpc.call('eth_getTransactionCount', [this.address, 'latest'])) > nonce) {
        const late = await this.rpc.call<Receipt | null>('eth_getTransactionReceipt', [hash]).catch(() => null);
        if (late) return late.status === '0x1' ? 'mined' : 'reverted';
        return 'lost';
      }
      if (this.now() >= deadline) return 'pending';
      await this.sleep(POLL_MS);
    }
  }

  /** The escrow wallet's next nonce once nothing of its is pending (waiting up to ARC_IDLE_WAIT_MS), or null. */
  private async idleNonce(): Promise<{ nonce: bigint; waited: boolean } | null> {
    const deadline = this.now() + ARC_IDLE_WAIT_MS;
    let waited = false;
    for (;;) {
      const [latest, pending] = await Promise.all([
        this.rpc.call('eth_getTransactionCount', [this.address, 'latest']),
        this.rpc.call('eth_getTransactionCount', [this.address, 'pending']),
      ]);
      if (BigInt(pending) <= BigInt(latest)) return { nonce: BigInt(latest), waited };
      if (this.now() >= deadline) return null;
      waited = true;
      await this.sleep(POLL_MS);
    }
  }

  private async block(tag: bigint | 'latest'): Promise<BlockRef> {
    const b = await this.rpc.call<Block | null>('eth_getBlockByNumber', [tag === 'latest' ? 'latest' : hex(tag), false]);
    if (!b?.number || !b.timestamp) throw new RpcError(`block ${tag === 'latest' ? 'latest' : tag} is not available`);
    return { number: BigInt(b.number), timestamp: BigInt(b.timestamp), baseFee: BigInt(b.baseFeePerGas ?? '0x0') };
  }

  /** Settled (or the reuse answer) if the authorization is used at `blockTag`; null if it is not. */
  private async ifUsed(auth: PaymentPayloadV2['payload']['authorization'], blockTag: string): Promise<SettleOutcome | null> {
    const out = await this.rpc.call('eth_call', [{ to: ARC_USDC, data: '0x' + AUTHORIZATION_STATE + word(auth.from) + word(auth.nonce) }, blockTag]);
    if (!/^0x0*1$/.test(out)) return null;
    const tx = await this.findAuthorizationTx(auth.from, auth.nonce, BigInt(auth.validAfter), BigInt(auth.validBefore));
    if (tx) return { kind: 'settled', transaction: tx, network: ARC_NETWORK, payer: this.address };
    return this.rejected('invalid_exact_evm_nonce_already_used', 'The authorization was already used on Arc.');
  }

  /**
   * The last block whose timestamp is at or before `ts`, to within a few blocks: an
   * interpolation search over block timestamps (Arc's are close to evenly spaced, so it
   * lands in a probe or two), with a bisection step whenever a probe gains little.
   */
  private async blockAt(ts: bigint, head: BlockRef): Promise<bigint> {
    if (ts >= head.timestamp) return head.number;
    let hi = head;
    // A lower bound: three blocks a second is faster than Arc runs, so this lands before ts.
    let lo = await this.block(head.number - (head.timestamp - ts) * 3n > 0n ? head.number - (head.timestamp - ts) * 3n : 0n);
    for (let i = 0; i < 4 && lo.timestamp > ts && lo.number > 0n; i++) {
      const back = lo.number - (lo.timestamp - ts) * 3n - 1000n;
      lo = await this.block(back > 0n ? back : 0n);
    }
    if (lo.timestamp > ts) return lo.number;
    for (let i = 0; i < 20 && hi.number - lo.number > 8n; i++) {
      const span = hi.number - lo.number;
      let probe = i % 2 === 0 && hi.timestamp > lo.timestamp
        ? lo.number + (span * (ts - lo.timestamp)) / (hi.timestamp - lo.timestamp)
        : lo.number + span / 2n;
      if (probe <= lo.number) probe = lo.number + 1n;
      if (probe >= hi.number) probe = hi.number - 1n;
      const b = await this.block(probe);
      if (b.timestamp <= ts) lo = b; else hi = b;
    }
    return lo.number;
  }

  /**
   * The transaction that used an authorization, from USDC's AuthorizationUsed log. It was
   * mined between validAfter and validBefore, so the search covers the blocks of that
   * window (found by timestamp, however long ago it was), newest first, in
   * ARC_LOG_CHUNK_BLOCKS slices.
   */
  private async findAuthorizationTx(authorizer: string, nonce: string, validAfter: bigint, validBefore: bigint): Promise<string | null> {
    const head = await this.block('latest');
    const fromBlock = await this.blockAt(validAfter, head) - LOG_MARGIN_BLOCKS;
    let to = await this.blockAt(validBefore, head) + LOG_MARGIN_BLOCKS;
    if (to > head.number) to = head.number;
    const from = fromBlock > 0n ? fromBlock : 0n;
    for (let i = 0; i < ARC_LOG_MAX_CHUNKS && to >= from; i++) {
      const start = to - ARC_LOG_CHUNK_BLOCKS + 1n > from ? to - ARC_LOG_CHUNK_BLOCKS + 1n : from;
      const logs = await this.rpc.call<Log[]>('eth_getLogs', [{
        address: ARC_USDC, fromBlock: hex(start), toBlock: hex(to),
        topics: [AUTHORIZATION_USED_TOPIC, '0x' + word(authorizer), '0x' + word(nonce)],
      }]).catch((err) => {
        if (err instanceof RpcError) return [] as Log[];
        throw err;
      });
      const hit = logs.find((l) => typeof l.transactionHash === 'string' && TX_HASH_RE.test(l.transactionHash));
      if (hit) return hit.transactionHash!;
      to = start - 1n;
    }
    return null;
  }
}

// ─── Routing ───

/**
 * Arc's facilitator: a transfer signed by the escrow wallet goes to the relay, anything
 * else (a buyer's deposit) to Circle. Either half may be missing (no Circle key, no
 * escrow key); a call it cannot place answers `unavailable` and settle.ts retries.
 */
export class ArcFacilitator implements Facilitator {
  constructor(readonly circle: Facilitator | null, readonly relay: ArcRelay | null) {}

  private fromEscrow(payload: PaymentPayloadV2): boolean {
    return !!this.relay && sameAddress(payload.payload.authorization.from, this.relay.address);
  }

  async verify(payload: PaymentPayloadV2, requirements: PaymentRequirementsV2): Promise<VerifyOutcome> {
    if (this.fromEscrow(payload)) return this.relay!.verify();
    if (!this.circle) return { kind: 'unavailable', cause: 'auth', detail: 'CIRCLE_API_KEY is not set: Arc deposits are off' };
    return this.circle.verify(payload, requirements);
  }

  async settle(payload: PaymentPayloadV2, requirements: PaymentRequirementsV2): Promise<SettleOutcome> {
    if (this.fromEscrow(payload)) return this.relay!.settle(payload, requirements);
    if (!this.circle) return { kind: 'unavailable', cause: 'auth', detail: 'CIRCLE_API_KEY is not set: Arc deposits are off' };
    return this.circle.settle(payload, requirements);
  }

  async supported(): Promise<unknown> {
    return { circle: this.circle ? await this.circle.supported() : null, relay: this.relay ? await this.relay.supported() : null };
  }
}

/** Sends each payment to the facilitator for its network; everything else to `fallback` (CDP). */
export class NetworkRouter implements Facilitator {
  constructor(readonly fallback: Facilitator, readonly routes: Readonly<Record<string, Facilitator>>) {}

  private pick(requirements: PaymentRequirementsV2): Facilitator {
    return this.routes[requirements.network] ?? this.fallback;
  }

  verify(payload: PaymentPayloadV2, requirements: PaymentRequirementsV2): Promise<VerifyOutcome> {
    return this.pick(requirements).verify(payload, requirements);
  }

  settle(payload: PaymentPayloadV2, requirements: PaymentRequirementsV2): Promise<SettleOutcome> {
    return this.pick(requirements).settle(payload, requirements);
  }

  supported(): Promise<unknown> {
    return this.fallback.supported();
  }
}

export type ArcEnv = { CIRCLE_API_KEY?: string; CIRCLE_FACILITATOR_URL?: string; ESCROW_WALLET_PRIVATE_KEY?: string; ARC_RPC_URL?: string };

/**
 * Arc's facilitator for this env: Circle when CIRCLE_API_KEY is set (with an http(s)
 * CIRCLE_FACILITATOR_URL if given), the relay when the escrow key parses.
 */
export function arcFacilitatorFor(env: ArcEnv): ArcFacilitator {
  let circle: CircleFacilitator | null = null;
  if (env.CIRCLE_API_KEY) {
    const baseUrl = env.CIRCLE_FACILITATOR_URL || DEFAULT_CIRCLE_FACILITATOR_URL;
    try {
      const u = new URL(baseUrl);
      if (u.protocol === 'https:' || u.protocol === 'http:') circle = new CircleFacilitator({ apiKey: env.CIRCLE_API_KEY, baseUrl });
      else console.error('[payments] CIRCLE_FACILITATOR_URL is not an http(s) URL: Arc deposits are off');
    } catch {
      console.error('[payments] CIRCLE_FACILITATOR_URL is not a valid URL: Arc deposits are off');
    }
  }
  let relay: ArcRelay | null = null;
  if (env.ESCROW_WALLET_PRIVATE_KEY) {
    try {
      relay = new ArcRelay({ privateKey: parseHousePrivateKey(env.ESCROW_WALLET_PRIVATE_KEY), rpc: new ArcRpc(rpcEndpoints(env, ARC_NETWORK)) });
    } catch {
      relay = null; // houseWalletFor logs the key problem
    }
  }
  return new ArcFacilitator(circle, relay);
}
