/**
 * Arc relay (arc.ts): the escrow wallet broadcasting its own EIP-3009 transfers,
 * against a fake Arc node that keeps the token's authorization state, a mempool and
 * receipts. Covers the transaction it builds, every early answer (already used,
 * expired, in flight, simulation revert, gas float), the receipt wait, RPC
 * failover, and the routing between Circle and the relay.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  ArcFacilitator, ArcRelay, ArcRpc, NetworkRouter, AUTHORIZATION_USED_TOPIC, ARC_MIN_MAX_FEE_WEI,
  revertReason, transferWithAuthorizationCalldata,
} from './arc.js';
import type { Facilitator } from './cdp-facilitator.js';
import { bytesToHex, hexToBytes } from './evm.js';
import { houseWalletFromPrivateKey } from './house-wallet.js';
import { buildRequirements, PaymentPayloadV2 } from './x402.js';
import { TEST_WALLET_KEYS } from '../test-helpers.js';
import { FakeArcNode } from './test-fixtures.js';

const KEY = hexToBytes(TEST_WALLET_KEYS.a);
const HOUSE = houseWalletFromPrivateKey(KEY);
const AGENT = '0x' + '7a'.repeat(20);
const USDC = '0x3600000000000000000000000000000000000000';
const NOW_MS = Date.parse('2026-10-07T22:00:00Z');
const NOW = Math.floor(NOW_MS / 1000);
const REQ = buildRequirements({ task_id: 'task_arc', bounty_amount: '5000000', bounty_network: 'eip155:5042' }, AGENT);
const GWEI = 1_000_000_000n;

let node: FakeArcNode;
const relay = (opts: { urls?: string[]; down?: string[]; now?: number } = {}) => {
  let clock = opts.now ?? NOW_MS;
  return new ArcRelay({
    privateKey: KEY, rpc: new ArcRpc(opts.urls ?? ['https://rpc.mainnet.arc.io'], node.fetch(opts.down)),
    now: () => clock, sleep: async (ms) => { clock += ms; }, receiptWaitMs: 2_000,
  });
};
const housePayload = () => HOUSE.signTransfer(REQ, NOW);
const methods = () => node.calls.map((c) => c.method);

beforeEach(() => { node = new FakeArcNode(NOW); });

describe('ArcRelay.settle', () => {
  it('broadcasts the escrow wallet\'s transferWithAuthorization and returns the mined transaction', async () => {
    const payload = housePayload();
    const out = await relay().settle(payload, REQ);
    expect(node.sent).toHaveLength(1);
    const hash = '0x' + bytesToHex(keccak_256(hexToBytes(node.sent[0])));
    expect(out).toEqual({ kind: 'settled', transaction: hash, network: 'eip155:5042', payer: HOUSE.address });
    // The calldata: transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s).
    const data = transferWithAuthorizationCalldata(payload);
    expect(data.slice(0, 10)).toBe('0xe3ee160e');
    expect(data.slice(10, 74)).toBe(HOUSE.address.slice(2).toLowerCase().padStart(64, '0'));
    expect(data.slice(74, 138)).toBe(AGENT.slice(2).padStart(64, '0'));
    expect(BigInt('0x' + data.slice(138, 202))).toBe(5_000_000n);
    expect([27n, 28n]).toContain(BigInt('0x' + data.slice(394, 458)));
    expect(node.sent[0]).toContain(data.slice(2));
    // Checked the chain first, then one transaction: the nonce the chain gave, simulated first.
    expect(methods().slice(0, 4)).toEqual(['eth_call', 'eth_getTransactionCount', 'eth_getTransactionCount', 'eth_estimateGas']);
    const est = node.calls.find((c) => c.method === 'eth_estimateGas')!.params[0];
    expect(est).toEqual({ from: HOUSE.address, to: USDC, data });
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
    const nonce = payload.payload.authorization.nonce;
    const TX = '0x' + 'ee'.repeat(32);
    node.used.set(`0x${HOUSE.address.slice(2)}:${nonce}`.toLowerCase(), TX);
    node.logs.push({ topics: [AUTHORIZATION_USED_TOPIC, '0x' + HOUSE.address.slice(2).toLowerCase().padStart(64, '0'), nonce], transactionHash: TX, blockNumber: '0x1' });
    expect(await relay().settle(payload, REQ)).toEqual({ kind: 'settled', transaction: TX, network: 'eip155:5042', payer: HOUSE.address });
    expect(node.sent).toEqual([]);
    // Without the log (outside the searched window), it is the reuse answer settle.ts resolves.
    node.logs = [];
    expect(await relay().settle(payload, REQ)).toMatchObject({ kind: 'rejected', reason: 'invalid_exact_evm_nonce_already_used' });
    expect(node.sent).toEqual([]);
  });

  it('refuses before sending: expired, foreign signer, wrong network or recipient', async () => {
    const payload = housePayload();
    expect(await relay({ now: (Number(payload.payload.authorization.validBefore) - 5) * 1000 }).settle(payload, REQ))
      .toMatchObject({ kind: 'rejected', reason: 'invalid_exact_evm_payload_authorization_valid_before' });
    const other = houseWalletFromPrivateKey(hexToBytes(TEST_WALLET_KEYS.b)).signTransfer(REQ, NOW);
    expect(await relay().settle(other, REQ)).toMatchObject({ kind: 'rejected', reason: 'invalid_payload' });
    const base = buildRequirements({ task_id: 't', bounty_amount: '5000000', bounty_network: 'eip155:8453' }, AGENT);
    expect(await relay().settle(HOUSE.signTransfer(base, NOW), base)).toMatchObject({ kind: 'rejected', reason: 'unsupported_network' });
    expect(await relay().settle(payload, { ...REQ, payTo: '0x' + '99'.repeat(20) })).toMatchObject({ kind: 'rejected', reason: 'invalid_exact_evm_payload_recipient_mismatch' });
    expect(await relay().settle(payload, { ...REQ, amount: '1' })).toMatchObject({ kind: 'rejected', reason: 'invalid_exact_evm_payload_authorization_value_mismatch' });
    expect(node.sent).toEqual([]);
  });

  it('waits while an escrow-wallet transaction is in flight', async () => {
    node.pendingNonce = 5n;
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'unavailable', cause: 'server', detail: expect.stringMatching(/still pending/) });
    expect(node.sent).toEqual([]);
  });

  it('a simulation revert is the token\'s verdict, classified; nothing is sent', async () => {
    node.estimateError = 'execution reverted: FiatTokenV2: invalid signature';
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'rejected', reason: 'invalid_exact_evm_payload_signature' });
    node.estimateError = 'execution reverted: ERC20: transfer amount exceeds balance';
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'rejected', reason: 'insufficient_funds' });
    expect(node.sent).toEqual([]);
    expect(revertReason('execution reverted: Blacklistable: account is blacklisted')).toBe('invalid_exact_evm_payload_authorization_to_address_kyt');
    expect(revertReason('execution reverted: FiatTokenV2: authorization is expired')).toBe('invalid_exact_evm_payload_authorization_valid_before');
    expect(revertReason('execution reverted: something else')).toBe('transaction_reverted');
  });

  it('refuses when the wallet cannot cover the transfer plus gas (the gas float)', async () => {
    // 5 USDC in native units, and gas on top: just short.
    node.balance = 5n * 10n ** 18n;
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'rejected', reason: 'insufficient_funds', message: expect.stringMatching(/Top it up/) });
    expect(node.sent).toEqual([]);
  });

  it('broadcast answers: already known is ours; anything else is retried', async () => {
    node.sendError = 'already known';
    // The node already holds it: the receipt wait goes on (and finds nothing mined here).
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'pending' });
    node = new FakeArcNode(NOW);
    node.sendError = 'nonce too low';
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'unavailable', cause: 'server', detail: expect.stringMatching(/nonce too low/) });
  });

  it('pending past the receipt wait; a reverted receipt is a retryable rejection', async () => {
    node.minedAfterPolls = Number.POSITIVE_INFINITY;
    const out = await relay().settle(housePayload(), REQ);
    expect(out).toEqual({ kind: 'pending', transaction: '0x' + bytesToHex(keccak_256(hexToBytes(node.sent[0]))) });
    node = new FakeArcNode(NOW);
    node.minedAfterPolls = 2;
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'settled' });
    node = new FakeArcNode(NOW);
    node.receiptStatus = '0x0';
    expect(await relay().settle(housePayload(), REQ)).toMatchObject({ kind: 'rejected', reason: 'transaction_reverted', transaction: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
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
