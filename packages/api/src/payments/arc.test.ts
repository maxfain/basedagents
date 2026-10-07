/**
 * Arc relay (arc.ts): the escrow wallet broadcasting its own EIP-3009 transfers, against
 * a fake Arc node (test-fixtures.ts) with a mempool, mined-only authorization state,
 * nonces, timestamped blocks and range-checked logs. Covers the transaction it builds;
 * used authorizations (and finding their transaction, even a day later); expiry decided
 * by the chain's clock only; waiting for and racing other escrow-wallet transactions;
 * simulation reverts; the gas float; the receipt wait; RPC failover; and routing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ArcFacilitator, ArcRelay, ArcRpc, NetworkRouter, ARC_IDLE_WAIT_MS, ARC_MIN_MAX_FEE_WEI,
  revertReason, transferWithAuthorizationCalldata,
} from './arc.js';
import type { Facilitator } from './cdp-facilitator.js';
import { hexToBytes } from './evm.js';
import { houseWalletFromPrivateKey } from './house-wallet.js';
import { buildRequirements, PaymentPayloadV2 } from './x402.js';
import { TEST_WALLET_KEYS } from '../test-helpers.js';
import { FakeArcNode, decodeArcTx } from './test-fixtures.js';

const KEY = hexToBytes(TEST_WALLET_KEYS.a);
const HOUSE = houseWalletFromPrivateKey(KEY);
const AGENT = '0x' + '7a'.repeat(20);
const OTHER_AGENT = '0x' + '7b'.repeat(20);
const USDC = '0x3600000000000000000000000000000000000000';
const NOW_MS = Date.parse('2026-10-07T22:00:00Z');
const NOW = Math.floor(NOW_MS / 1000);
const REQ = buildRequirements({ task_id: 'task_arc', bounty_amount: '5000000', bounty_network: 'eip155:5042' }, AGENT);
const GWEI = 1_000_000_000n;
const OTHER_TX = '0x' + 'ee'.repeat(32);

let node: FakeArcNode;
/** A relay on the fake node; `onSleep` runs whenever it waits (to let the chain move on). */
const relay = (opts: { urls?: string[]; down?: string[]; now?: number; onSleep?: () => void } = {}) => {
  let clock = opts.now ?? NOW_MS;
  return new ArcRelay({
    privateKey: KEY, rpc: new ArcRpc(opts.urls ?? ['https://rpc.mainnet.arc.io'], node.fetch(opts.down)),
    now: () => clock, sleep: async (ms) => { clock += ms; opts.onSleep?.(); }, receiptWaitMs: 2_000,
  });
};
const housePayload = (req = REQ) => HOUSE.signTransfer(req, NOW);
const methods = () => node.calls.map((c) => c.method);
const count = (method: string) => node.calls.filter((c) => c.method === method).length;
const hashOf = (raw: string) => decodeArcTx(raw).hash;
/** Another escrow-wallet transaction (a different payout) on `nonce`. */
const otherTx = (nonce: bigint) => ({ hash: OTHER_TX, raw: '0x', nonce, data: '0x' });

beforeEach(() => { node = new FakeArcNode(NOW); });

describe('ArcRelay.settle', () => {
  it('broadcasts the escrow wallet\'s transferWithAuthorization and returns the mined transaction', async () => {
    const payload = housePayload();
    const out = await relay().settle(payload, REQ);
    expect(node.sent).toHaveLength(1);
    expect(out).toEqual({ kind: 'settled', transaction: hashOf(node.sent[0]), network: 'eip155:5042', payer: HOUSE.address });
    // The calldata: transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s).
    const data = transferWithAuthorizationCalldata(payload);
    expect(data.slice(0, 10)).toBe('0xe3ee160e');
    expect(data.slice(10, 74)).toBe(HOUSE.address.slice(2).toLowerCase().padStart(64, '0'));
    expect(data.slice(74, 138)).toBe(AGENT.slice(2).padStart(64, '0'));
    expect(BigInt('0x' + data.slice(138, 202))).toBe(5_000_000n);
    expect([27n, 28n]).toContain(BigInt('0x' + data.slice(394, 458)));
    expect(decodeArcTx(node.sent[0])).toMatchObject({ nonce: 4n, data });
    // The chain first (used? expired? anything in flight?), then a simulation, then one transaction.
    expect(methods().slice(0, 5)).toEqual(['eth_call', 'eth_getBlockByNumber', 'eth_getTransactionCount', 'eth_getTransactionCount', 'eth_estimateGas']);
    expect(node.calls.find((c) => c.method === 'eth_estimateGas')!.params[0]).toEqual({ from: HOUSE.address, to: USDC, data });
    expect(node.latestNonce).toBe(5n);
  });

  it('pays twice the base fee plus the tip, never under Arc\'s 20 gwei floor', async () => {
    await relay().settle(housePayload(), REQ);
    // type 2 ‖ rlp([chainId 0x13b2, nonce 4, tip 0x07d0, maxFee 40 gwei + tip, gas 100000, …])
    expect(node.sent[0].startsWith('0x02f9')).toBe(true);
    expect(node.sent[0]).toContain('8213b204' + '8207d0' + '85' + (40n * GWEI + 2000n).toString(16).padStart(10, '0') + '830186a0');
    node = new FakeArcNode(NOW);
    node.baseFee = 1n;
    node.tip = 0n;
    await relay().settle(housePayload(), REQ);
    expect(node.sent[0]).toContain('85' + ARC_MIN_MAX_FEE_WEI.toString(16).padStart(10, '0'));
  });

  it('an authorization already used is settled by the transaction in its AuthorizationUsed log', async () => {
    const payload = housePayload();
    node.markUsed(HOUSE.address, payload.payload.authorization.nonce, OTHER_TX, node.blockOf(BigInt(NOW + 30)));
    node.advance(60);
    expect(await relay().settle(payload, REQ)).toEqual({ kind: 'settled', transaction: OTHER_TX, network: 'eip155:5042', payer: HOUSE.address });
    expect(node.sent).toEqual([]);
    // Without its log, it is the reuse answer settle.ts resolves.
    node.logs = [];
    expect(await relay().settle(payload, REQ)).toMatchObject({ kind: 'rejected', reason: 'invalid_exact_evm_nonce_already_used' });
    expect(node.sent).toEqual([]);
  });

  it('finds that transaction a day later in a couple of log queries, inside the validity window', async () => {
    const payload = housePayload();
    node.markUsed(HOUSE.address, payload.payload.authorization.nonce, OTHER_TX, node.blockOf(BigInt(NOW + 30)));
    node.advance(86_400);
    expect(await relay().settle(payload, REQ)).toMatchObject({ kind: 'settled', transaction: OTHER_TX });
    const queries = node.calls.filter((c) => c.method === 'eth_getLogs').map((c) => c.params[0] as { fromBlock: string; toBlock: string });
    expect(queries.length).toBeLessThanOrEqual(2);
    // Every query stays within the window's blocks (validAfter .. validBefore, with a margin).
    for (const q of queries) {
      expect(BigInt(q.fromBlock)).toBeGreaterThanOrEqual(node.blockOf(BigInt(NOW - 60)) - 700n);
      expect(BigInt(q.toBlock)).toBeLessThanOrEqual(node.blockOf(BigInt(NOW + 3600)) + 700n);
    }
  });

  it('refuses before sending: foreign signer, wrong network, recipient or amount', async () => {
    const payload = housePayload();
    const other = houseWalletFromPrivateKey(hexToBytes(TEST_WALLET_KEYS.b)).signTransfer(REQ, NOW);
    expect(await relay().settle(other, REQ)).toMatchObject({ kind: 'rejected', reason: 'invalid_payload' });
    const base = buildRequirements({ task_id: 't', bounty_amount: '5000000', bounty_network: 'eip155:8453' }, AGENT);
    expect(await relay().settle(HOUSE.signTransfer(base, NOW), base)).toMatchObject({ kind: 'rejected', reason: 'unsupported_network' });
    expect(await relay().settle(payload, { ...REQ, payTo: '0x' + '99'.repeat(20) })).toMatchObject({ kind: 'rejected', reason: 'invalid_exact_evm_payload_recipient_mismatch' });
    expect(await relay().settle(payload, { ...REQ, amount: '1' })).toMatchObject({ kind: 'rejected', reason: 'invalid_exact_evm_payload_authorization_value_mismatch' });
    expect(node.sent).toEqual([]);
  });

  it('expiry is the chain\'s call: our clock past validBefore changes nothing; the chain past it, unused, does', async () => {
    const payload = housePayload();
    const validBefore = Number(payload.payload.authorization.validBefore);
    // Our clock says expired; the chain doesn't: the transfer goes out and lands.
    expect(await relay({ now: (validBefore + 100) * 1000 }).settle(payload, REQ)).toMatchObject({ kind: 'settled' });
    // The chain past validBefore with an unused authorization: definitively expired, nothing sent.
    node = new FakeArcNode(NOW);
    node.advance(3_700);
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'rejected', reason: 'invalid_exact_evm_payload_authorization_valid_before' });
    expect(node.sent).toEqual([]);
  });

  it('a transfer already sent is never called expired while it can still land, and is settled once it does', async () => {
    node.autoMine = false;
    const payload = housePayload();
    const first = await relay().settle(payload, REQ);
    expect(first).toEqual({ kind: 'pending', transaction: hashOf(node.sent[0]) });
    // Retried 10 s before validBefore by the chain's clock, 5 s before it by ours, with
    // the transfer still in the mempool: waiting, not expired (expired would re-sign and pay twice).
    node.advance(3_590);
    const second = await relay({ now: (NOW + 3_595) * 1000 }).settle(payload, REQ);
    expect(second).toMatchObject({ kind: 'unavailable', detail: expect.stringMatching(/still pending/) });
    // It lands before validBefore: the next attempt reports that very transaction.
    node.mine();
    expect(await relay().settle(payload, REQ)).toEqual({ kind: 'settled', transaction: hashOf(node.sent[0]), network: 'eip155:5042', payer: HOUSE.address });
    expect(node.sent).toHaveLength(1);
  });

  it('a transfer dropped and past validBefore is expired, read at that block; a lagging node can\'t say so', async () => {
    node.autoMine = false;
    const payload = housePayload();
    expect(await relay().settle(payload, REQ)).toMatchObject({ kind: 'pending' });
    node.drop(hashOf(node.sent[0]));
    node.advance(3_700);
    node.lagPinned = true;
    expect(await relay().settle(payload, REQ)).toMatchObject({ kind: 'unavailable', detail: expect.stringMatching(/could not read block/) });
    node.lagPinned = false;
    expect(await relay().settle(payload, REQ)).toMatchObject({ kind: 'rejected', reason: 'invalid_exact_evm_payload_authorization_valid_before' });
    expect(node.sent).toHaveLength(1);
  });

  it('waits for another escrow-wallet transaction to land, then sends on the next nonce', async () => {
    node.inject(otherTx(4n));
    expect(await relay({ onSleep: () => node.mine() }).settle(housePayload(), REQ)).toMatchObject({ kind: 'settled' });
    expect(decodeArcTx(node.sent[0]).nonce).toBe(5n);
    // One that never lands: the relay gives the slot back after ARC_IDLE_WAIT_MS, having sent nothing.
    node = new FakeArcNode(NOW);
    node.inject(otherTx(4n));
    const r = relay();
    expect(await r.settle(housePayload(), REQ)).toMatchObject({ kind: 'unavailable', detail: expect.stringMatching(/still pending/) });
    expect(node.sent).toEqual([]);
    expect(count('eth_getTransactionCount')).toBeGreaterThanOrEqual(2 * Math.floor(ARC_IDLE_WAIT_MS / 400));
  });

  it('loses a nonce race to a concurrent payout and sends on the next nonce in the same call', async () => {
    let raced = false;
    node.beforeSend = (tx) => {
      if (!raced) { raced = true; node.inject(otherTx(tx.nonce)); }
    };
    expect(await relay({ onSleep: () => node.mine() }).settle(housePayload(), REQ)).toMatchObject({ kind: 'settled' });
    expect(count('eth_sendRawTransaction')).toBe(2);
    expect(node.sent).toHaveLength(1);
    expect(decodeArcTx(node.sent[0]).nonce).toBe(5n);
    expect(node.latestNonce).toBe(6n);
  });

  it('two payouts at once (two Workers, one escrow wallet) both land, on consecutive nonces', async () => {
    const other = buildRequirements({ task_id: 'task_arc2', bounty_amount: '1000000', bounty_network: 'eip155:5042' }, OTHER_AGENT);
    const [a, b] = await Promise.all([relay().settle(housePayload(), REQ), relay().settle(housePayload(other), other)]);
    expect(a).toMatchObject({ kind: 'settled' });
    expect(b).toMatchObject({ kind: 'settled' });
    expect(node.sent.map((raw) => decodeArcTx(raw).nonce).sort()).toEqual([4n, 5n]);
    expect(node.latestNonce).toBe(6n);
    // They raced for nonce 4: the node refused one, which went out again on 5 in the same call.
    expect(count('eth_sendRawTransaction')).toBe(3);
  });

  it('a transfer whose nonce went to another transaction is sent again', async () => {
    let swapped = false;
    node.onReceiptPoll = (hash) => {
      if (swapped) return;
      swapped = true;
      const ours = node.mempool.find((t) => t.hash === hash)!;
      node.drop(hash);
      node.inject(otherTx(ours.nonce));
      node.mine();
    };
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'settled' });
    expect(node.sent.map((raw) => decodeArcTx(raw).nonce)).toEqual([4n, 5n]);
  });

  it('a transfer that lands while its receipt and log can\'t be read stays open: pending, never the reuse answer', async () => {
    // First attempt (settle.ts believes nothing was ever sent): the transfer lands, but every
    // receipt read fails, so it looks lost once the nonce moves on; the log can't be read either.
    node.failReceipts = true;
    node.failLogs = true;
    const payload = housePayload();
    const out = await relay().settle(payload, REQ);
    // "Already used" here is our own landing: answering it as a reuse would let settle.ts re-sign.
    // Which transaction landed can't be read, so no hash is claimed (the recorded one stays).
    expect(out).toEqual({ kind: 'pending' });
    expect(node.sent).toHaveLength(1);
    // Before any send in a call, the reuse answer stands (settle.ts weighs it against its own record).
    node.failReceipts = false;
    expect(await relay().settle(payload, REQ)).toMatchObject({ kind: 'rejected', reason: 'invalid_exact_evm_nonce_already_used' });
    node.failLogs = false;
    expect(await relay().settle(payload, REQ)).toMatchObject({ kind: 'settled', transaction: hashOf(node.sent[0]) });
  });

  it('an earlier attempt\'s transfer landing as a retry broadcasts: pending without the refused retry\'s hash', async () => {
    node.autoMine = false;
    const payload = housePayload();
    expect(await relay().settle(payload, REQ)).toMatchObject({ kind: 'pending', transaction: hashOf(node.sent[0]) });
    // Our node loses the first transfer, but it lands from elsewhere just as the retry
    // broadcasts (with other fees, so another hash), which the node refuses: nonce too low.
    const first = node.mempool[0];
    node.drop(first.hash);
    node.tip = 3000n;
    node.failLogs = true;
    let landed = false;
    node.beforeSend = (tx) => {
      if (landed || tx.hash === first.hash) return;
      landed = true;
      node.inject(first);
      node.mine();
    };
    const retry = await relay().settle(payload, REQ);
    // Settled by the first transfer, but its log can't be read: pending, and no hash of the
    // refused retry, so the first transfer's recorded hash isn't replaced.
    expect(retry).toEqual({ kind: 'pending' });
    expect(count('eth_sendRawTransaction')).toBe(2);
    expect(node.sent).toHaveLength(1);
    node.failLogs = false;
    expect(await relay().settle(payload, REQ)).toMatchObject({ kind: 'settled', transaction: first.hash });
  });

  it('after a send in this call, a simulation verdict that would allow re-signing waits for the next attempt', async () => {
    let swapped = false;
    node.onReceiptPoll = (hash) => {
      if (swapped) return;
      swapped = true;
      const ours = node.mempool.find((t) => t.hash === hash)!;
      node.drop(hash);
      node.inject(otherTx(ours.nonce));
      node.mine();
      node.estimateError = 'execution reverted: Blacklistable: account is blacklisted';
    };
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'unavailable', detail: expect.stringMatching(/after a send in this call/) });
    // A fresh attempt (settle.ts now knows a broadcast happened) gets the verdict itself.
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'rejected', reason: 'invalid_exact_evm_payload_authorization_to_address_kyt' });
  });

  it('a simulation revert is the token\'s verdict, classified; a time-related one waits for the chain', async () => {
    node.estimateError = 'execution reverted: FiatTokenV2: invalid signature';
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'rejected', reason: 'invalid_exact_evm_payload_signature' });
    node.estimateError = 'execution reverted: ERC20: transfer amount exceeds balance';
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'rejected', reason: 'insufficient_funds' });
    node.estimateError = 'execution reverted: FiatTokenV2: authorization is expired';
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'unavailable', detail: expect.stringMatching(/chain's clock/) });
    expect(node.sent).toEqual([]);
    expect(revertReason('execution reverted: Blacklistable: account is blacklisted')).toBe('invalid_exact_evm_payload_authorization_to_address_kyt');
    expect(revertReason('execution reverted: FiatTokenV2: authorization is used or canceled')).toBe('invalid_exact_evm_nonce_already_used');
    expect(revertReason('execution reverted: something else')).toBe('transaction_reverted');
  });

  it('refuses when the wallet cannot cover the transfer plus gas (the gas float)', async () => {
    // 5 USDC in native units, and gas on top: just short.
    node.balance = 5n * 10n ** 18n;
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'rejected', reason: 'insufficient_funds', message: expect.stringMatching(/Top it up/) });
    expect(node.sent).toEqual([]);
  });

  it('broadcast answers: already known is ours; insufficient funds; anything else is retried later', async () => {
    node.sendError = 'already known';
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'pending', transaction: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    node.sendError = 'insufficient funds for gas * price + value: have 0 want 1';
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'rejected', reason: 'insufficient_funds' });
    node.sendError = 'txpool is full';
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'unavailable', detail: expect.stringMatching(/txpool is full/) });
    node.sendError = 'nonce too low';
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'unavailable', detail: expect.stringMatching(/rounds/) });
  });

  it('pending past the receipt wait; a revert after a clean simulation is retried later, not resent', async () => {
    node.autoMine = false;
    const out = await relay().settle(housePayload(), REQ);
    expect(out).toEqual({ kind: 'pending', transaction: hashOf(node.sent[0]) });
    node = new FakeArcNode(NOW);
    node.mineAfterPolls = 2;
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'settled' });
    node = new FakeArcNode(NOW);
    node.revertOnMine = true;
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'rejected', reason: 'transaction_reverted', transaction: hashOf(node.sent[0]) });
    expect(node.sent).toHaveLength(1);
  });

  it('moves to the next RPC endpoint when one is down, and is unavailable when all are', async () => {
    const urls = ['https://a.example', 'https://b.example'];
    expect(await relay({ urls, down: ['https://a.example'] }).settle(housePayload(), REQ)).toMatchObject({ kind: 'settled' });
    expect(await relay({ urls, down: urls }).settle(housePayload(), REQ)).toMatchObject({ kind: 'unavailable', cause: 'network' });
  });

  it('never verifies: deposits go to Circle', async () => {
    expect(await relay().verify()).toMatchObject({ kind: 'unavailable' });
  });
});

describe('ArcFacilitator / NetworkRouter', () => {
  const tagged = (name: string): Facilitator & { seen: string[] } => {
    const seen: string[] = [];
    return {
      seen,
      verify: async () => { seen.push(`${name}.verify`); return { kind: 'valid' }; },
      settle: async () => { seen.push(`${name}.settle`); return { kind: 'settled', transaction: '0x' + '00'.repeat(32) }; },
      supported: async () => ({ name }),
    };
  };

  it('sends the escrow wallet\'s transfers to the relay and buyers\' deposits to Circle', async () => {
    const circle = tagged('circle');
    const arc = new ArcFacilitator(circle, relay());
    await arc.settle(housePayload(), REQ);
    expect(node.sent).toHaveLength(1);
    const buyer = PaymentPayloadV2.parse({ ...housePayload(), payload: { ...housePayload().payload, authorization: { ...housePayload().payload.authorization, from: '0x' + '22'.repeat(20) } } });
    await arc.verify(buyer, REQ);
    await arc.settle(buyer, REQ);
    expect(circle.seen).toEqual(['circle.verify', 'circle.settle']);
    // No Circle key: a deposit can't be placed, and says why.
    expect(await new ArcFacilitator(null, relay()).settle(buyer, REQ)).toMatchObject({ kind: 'unavailable', cause: 'auth', detail: expect.stringMatching(/CIRCLE_API_KEY/) });
  });

  it('routes by network, everything else to the fallback (CDP)', async () => {
    const cdp = tagged('cdp');
    const arc = tagged('arc');
    const router = new NetworkRouter(cdp, { 'eip155:5042': arc });
    const base = buildRequirements({ task_id: 't', bounty_amount: '1', bounty_network: 'eip155:8453' }, AGENT);
    await router.settle(housePayload(), REQ);
    await router.verify(housePayload(), base);
    expect(arc.seen).toEqual(['arc.settle']);
    expect(cdp.seen).toEqual(['cdp.verify']);
    expect(await router.supported()).toEqual({ name: 'cdp' });
  });
});
