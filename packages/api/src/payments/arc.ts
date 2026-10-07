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
const ARC_LOG_MAX_CHUNKS = 4;
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

  private async send(payload: PaymentPayloadV2, req: PaymentRequirementsV2): Promise<SettleOutcome> {
    const auth = payload.payload.authorization;
    if (req.network !== ARC_NETWORK || !sameAddress(req.asset, ARC_USDC)) return this.rejected('unsupported_network', 'The Arc relay sends USDC on Arc only.');
    if (!sameAddress(auth.from, this.address)) return this.rejected('invalid_payload', 'The Arc relay sends only transfers signed by the escrow wallet.');
    if (!sameAddress(auth.to, req.payTo)) return this.rejected('invalid_exact_evm_payload_recipient_mismatch', 'The authorization pays someone other than payTo.');
    if (BigInt(auth.value) !== BigInt(req.amount)) return this.rejected('invalid_exact_evm_payload_authorization_value_mismatch', 'The authorization moves a different amount.');

    // 1. Already used? Then the money moved; find the transaction that moved it.
    if (await this.authorizationUsed(auth.from, auth.nonce)) {
      const tx = await this.findAuthorizationTx(auth.from, auth.nonce, Number(auth.validAfter), Number(auth.validBefore));
      if (tx) return { kind: 'settled', transaction: tx, network: ARC_NETWORK, payer: this.address };
      return this.rejected('invalid_exact_evm_nonce_already_used', 'The authorization was already used on Arc.');
    }
    const nowSec = Math.floor(this.now() / 1000);
    if (Number(auth.validBefore) <= nowSec + 10) return this.rejected('invalid_exact_evm_payload_authorization_valid_before', 'The authorization has expired.');

    // 2. One escrow-wallet transaction in flight at a time: a pending one may be an
    //    earlier attempt of this very leg, and a second would only revert and burn gas.
    const [latest, pending] = await Promise.all([
      this.rpc.call('eth_getTransactionCount', [this.address, 'latest']),
      this.rpc.call('eth_getTransactionCount', [this.address, 'pending']),
    ]);
    if (BigInt(pending) > BigInt(latest)) {
      return { kind: 'unavailable', cause: 'server', detail: 'Arc relay: an escrow-wallet transaction is still pending; retrying after it lands' };
    }

    // 3. Simulate: a revert here is the token's verdict, and nothing was sent.
    const data = transferWithAuthorizationCalldata(payload);
    let gas: bigint;
    try {
      gas = BigInt(await this.rpc.call('eth_estimateGas', [{ from: this.address, to: ARC_USDC, data }]));
    } catch (err) {
      if (err instanceof RpcError) return this.rejected(revertReason(err.message), `Arc simulation: ${err.message}`.slice(0, 300));
      throw err;
    }

    // 4. Fees and the gas float: the transfer and its gas come out of one USDC balance.
    const block = await this.rpc.call<Block>('eth_getBlockByNumber', ['latest', false]);
    const baseFee = BigInt(block?.baseFeePerGas ?? '0x0');
    let tip = 0n;
    try {
      tip = BigInt(await this.rpc.call('eth_maxPriorityFeePerGas', []));
    } catch (err) {
      if (!(err instanceof RpcError)) throw err;
    }
    let maxFee = 2n * baseFee + tip;
    if (maxFee < ARC_MIN_MAX_FEE_WEI) maxFee = ARC_MIN_MAX_FEE_WEI;
    const gasLimit = (gas * 5n) / 4n;
    const balance = BigInt(await this.rpc.call('eth_getBalance', [this.address, 'latest']));
    const needed = BigInt(auth.value) * WEI_PER_ATOMIC + gasLimit * maxFee;
    if (balance < needed) {
      return this.rejected('insufficient_funds', `The escrow wallet holds ${balance} wei of USDC on Arc and needs ${needed} (the transfer plus gas). Top it up with a little USDC on Arc.`);
    }

    // 5. Sign and broadcast.
    const signed = signEip1559({
      chainId: ARC_CHAIN_ID, nonce: BigInt(latest), maxPriorityFeePerGas: tip, maxFeePerGas: maxFee,
      gas: gasLimit, to: ARC_USDC, value: 0n, data,
    }, this.key);
    try {
      await this.rpc.call('eth_sendRawTransaction', [signed.raw]);
    } catch (err) {
      if (!(err instanceof RpcError)) throw err; // unknown whether a node took it: the retry checks the chain first
      if (!/already known/i.test(err.message)) {
        if (/insufficient funds/i.test(err.message)) return this.rejected('insufficient_funds', `Arc broadcast: ${err.message}`.slice(0, 300));
        return { kind: 'unavailable', cause: 'server', detail: `Arc broadcast refused: ${err.message}`.slice(0, 500) };
      }
    }

    // 6. Wait for the receipt (Arc finalizes in under a second).
    const deadline = this.now() + this.receiptWaitMs;
    for (;;) {
      const receipt = await this.rpc.call<Receipt | null>('eth_getTransactionReceipt', [signed.hash]).catch((err) => {
        if (err instanceof RpcError) return null;
        throw err;
      });
      if (receipt && receipt.status === '0x1') return { kind: 'settled', transaction: signed.hash, network: ARC_NETWORK, payer: this.address };
      if (receipt) return this.rejected('transaction_reverted', `Arc transaction ${signed.hash} reverted.`, signed.hash);
      if (this.now() >= deadline) return { kind: 'pending', transaction: signed.hash };
      await this.sleep(400);
    }
  }

  private async authorizationUsed(authorizer: string, nonce: string): Promise<boolean> {
    const out = await this.rpc.call('eth_call', [{ to: ARC_USDC, data: '0x' + AUTHORIZATION_STATE + word(authorizer) + word(nonce) }, 'latest']);
    return /^0x0*1$/.test(out);
  }

  /**
   * The transaction that used an authorization, from USDC's AuthorizationUsed log. It was
   * mined between validAfter and validBefore; Arc makes about two blocks a second, and the
   * window is widened for drift. Searched newest first, ARC_LOG_CHUNK_BLOCKS at a time.
   */
  private async findAuthorizationTx(authorizer: string, nonce: string, validAfter: number, validBefore: number): Promise<string | null> {
    const head = await this.rpc.call<Block>('eth_getBlockByNumber', ['latest', false]);
    const headNum = BigInt(head?.number ?? '0x0');
    const headTs = Number(BigInt(head?.timestamp ?? '0x0'));
    const blocksBack = (seconds: number, perSecond: number) => BigInt(Math.max(0, Math.ceil(seconds * perSecond)));
    let to = headNum - blocksBack(headTs - Math.min(validBefore, headTs), 1.5);
    const from = headNum - blocksBack(headTs - validAfter, 2.5) - 100n;
    for (let i = 0; i < ARC_LOG_MAX_CHUNKS && to >= from && to >= 0n; i++) {
      const start = to - ARC_LOG_CHUNK_BLOCKS + 1n > from ? to - ARC_LOG_CHUNK_BLOCKS + 1n : from;
      const logs = await this.rpc.call<Log[]>('eth_getLogs', [{
        address: ARC_USDC, fromBlock: '0x' + (start < 0n ? 0n : start).toString(16), toBlock: '0x' + to.toString(16),
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
