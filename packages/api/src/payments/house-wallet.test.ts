/**
 * The house wallet: address derivation, EIP-712 TransferWithAuthorization
 * signing (byte-compatible with what a buyer's browser wallet produces), the
 * x402 payload shape, and the fail-closed env switch.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  addressFromPrivateKey, parseHousePrivateKey, houseWalletFromPrivateKey, recoverAuthorizationSigner,
  toChecksumAddress, transferWithAuthorizationDigest, domainSeparator, escrowDisabledReason, houseWalletFor,
  setHouseWalletForTests, HouseKeyFormatError, type EscrowEnv,
} from './house-wallet.js';
import { buildRequirements, localPrechecks, PaymentPayloadV2, decodePaymentHeader, encodeB64Json } from './x402.js';
import { setPaymentProviderForTests } from './index.js';
import { fakeFacilitator } from './test-fixtures.js';

/** Hardhat/Anvil account #0 — a public test key with a well-known address. */
const HARDHAT_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const HARDHAT_0_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const PAYEE = '0x' + '1'.repeat(40);
const NOW_SEC = 1_800_000_000;

const requirements = buildRequirements({ task_id: 'task_x', bounty_amount: '5000000', bounty_network: 'eip155:8453' }, PAYEE);

describe('payments/house-wallet.ts', () => {
  afterEach(() => {
    setHouseWalletForTests(undefined);
    setPaymentProviderForTests(undefined);
  });

  it('derives the well-known address of a well-known key (EIP-55 checksummed)', () => {
    expect(addressFromPrivateKey(parseHousePrivateKey(HARDHAT_0))).toBe(HARDHAT_0_ADDR);
    expect(addressFromPrivateKey(parseHousePrivateKey(HARDHAT_0.slice(2)))).toBe(HARDHAT_0_ADDR);
    expect(toChecksumAddress(HARDHAT_0_ADDR.toLowerCase())).toBe(HARDHAT_0_ADDR);
  });

  it('rejects malformed, zero and out-of-range keys', () => {
    for (const bad of ['', 'abc', '0x' + '0'.repeat(64), 'f'.repeat(64), '0x' + 'g'.repeat(64), '-----BEGIN']) {
      expect(() => parseHousePrivateKey(bad)).toThrow(HouseKeyFormatError);
    }
  });

  it('EIP-712 domain separator matches the hand-encoded EIP712Domain struct', () => {
    // Recompute independently: keccak(typehash ‖ keccak(name) ‖ keccak(version) ‖ chainId ‖ address).
    const enc = new TextEncoder();
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    const w = (h: string) => h.padStart(64, '0');
    const typehash = hex(keccak_256(enc.encode('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')));
    const pre = typehash + hex(keccak_256(enc.encode('USD Coin'))) + hex(keccak_256(enc.encode('2'))) + w((8453).toString(16)) + w(requirements.asset.slice(2).toLowerCase());
    const bytes = new Uint8Array(pre.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    expect(hex(domainSeparator(requirements))).toBe(hex(keccak_256(bytes)));
  });

  it('signs a TransferWithAuthorization the house address recovers from, as a valid x402 v2 payload', () => {
    const wallet = houseWalletFromPrivateKey(parseHousePrivateKey(HARDHAT_0));
    expect(wallet.address).toBe(HARDHAT_0_ADDR);
    const payload = wallet.signTransfer(requirements, NOW_SEC);

    expect(PaymentPayloadV2.parse(payload)).toEqual(payload);
    expect(payload.accepted).toEqual(requirements);
    const auth = payload.payload.authorization;
    expect(auth.from).toBe(HARDHAT_0_ADDR);
    expect(auth.to).toBe(PAYEE);
    expect(auth.value).toBe('5000000');
    expect(auth.validAfter).toBe(String(NOW_SEC - 60));
    expect(auth.validBefore).toBe(String(NOW_SEC + 3600));
    expect(auth.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(payload.payload.signature).toMatch(/^0x[0-9a-f]{130}$/);
    // v is 27/28 (what eth_signTypedData_v4 emits and what USDC's ecrecover expects).
    expect(['1b', '1c']).toContain(payload.payload.signature.slice(-2));

    expect(recoverAuthorizationSigner(payload)).toBe(HARDHAT_0_ADDR);
    // The server's own binding checks accept it exactly like a buyer's payload.
    expect(localPrechecks(payload, requirements, NOW_SEC)).toEqual({ ok: true });
    // And it round-trips through the PAYMENT-SIGNATURE codec settle.ts uses.
    expect(decodePaymentHeader(encodeB64Json(payload))).toEqual(payload);
  });

  it('a tampered authorization no longer recovers to the house', () => {
    const wallet = houseWalletFromPrivateKey(parseHousePrivateKey(HARDHAT_0));
    const payload = wallet.signTransfer(requirements, NOW_SEC);
    const tampered = { ...payload, payload: { ...payload.payload, authorization: { ...payload.payload.authorization, value: '5000001' } } };
    expect(recoverAuthorizationSigner(tampered)).not.toBe(HARDHAT_0_ADDR);
  });

  it('two signatures never share a nonce; an explicit nonce is honoured', () => {
    const wallet = houseWalletFromPrivateKey(parseHousePrivateKey(HARDHAT_0));
    const a = wallet.signTransfer(requirements, NOW_SEC);
    const b = wallet.signTransfer(requirements, NOW_SEC);
    expect(a.payload.authorization.nonce).not.toBe(b.payload.authorization.nonce);
    const fixed = '0x' + 'ab'.repeat(32);
    expect(wallet.signTransfer(requirements, NOW_SEC, fixed).payload.authorization.nonce).toBe(fixed);
  });

  it('digest changes with every field of the authorization and the domain', () => {
    const auth = { from: HARDHAT_0_ADDR, to: PAYEE, value: '1', validAfter: '0', validBefore: '10', nonce: '0x' + '00'.repeat(32) };
    const base = transferWithAuthorizationDigest(requirements, auth);
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    for (const patch of [{ to: HARDHAT_0_ADDR }, { value: '2' }, { validAfter: '1' }, { validBefore: '11' }, { nonce: '0x' + '01'.repeat(32) }]) {
      expect(hex(transferWithAuthorizationDigest(requirements, { ...auth, ...patch }))).not.toBe(hex(base));
    }
    expect(hex(transferWithAuthorizationDigest({ ...requirements, network: 'eip155:84532', asset: requirements.asset }, auth))).not.toBe(hex(base));
  });

  describe('env switch (fail closed)', () => {
    // The fake facilitator stands in for the CDP secrets (paymentProviderFor honours the override).
    const paymentsOn: EscrowEnv = { PAYMENT_ENCRYPTION_KEY: 'a'.repeat(64), ESCROW_WALLET_PRIVATE_KEY: HARDHAT_0 };

    it('needs payments enabled first', () => {
      setPaymentProviderForTests(null);
      expect(escrowDisabledReason(paymentsOn)).toMatch(/^payments disabled/);
      expect(houseWalletFor(paymentsOn)).toBeNull();
    });

    it('needs a valid house key', () => {
      setPaymentProviderForTests(fakeFacilitator());
      expect(escrowDisabledReason({ ...paymentsOn, ESCROW_WALLET_PRIVATE_KEY: undefined })).toBe('ESCROW_WALLET_PRIVATE_KEY is not set');
      expect(escrowDisabledReason({ ...paymentsOn, ESCROW_WALLET_PRIVATE_KEY: 'nope' })).toMatch(/64 hex/);
      expect(houseWalletFor({ ...paymentsOn, ESCROW_WALLET_PRIVATE_KEY: 'nope' })).toBeNull();
    });

    it('enabled: the wallet is derived and memoised; the pause switch stops new deposits only', () => {
      setPaymentProviderForTests(fakeFacilitator());
      const env = { ...paymentsOn };
      expect(escrowDisabledReason(env)).toBeNull();
      const w = houseWalletFor(env);
      expect(w?.address).toBe(HARDHAT_0_ADDR);
      expect(houseWalletFor(env)).toBe(w);
      const paused = { ...env, TASK_ESCROW_ENABLED: '0' };
      expect(escrowDisabledReason(paused)).toMatch(/paused/);
      expect(houseWalletFor(paused)?.address).toBe(HARDHAT_0_ADDR);
    });

    it('test override: null disables, a wallet is returned verbatim', () => {
      setPaymentProviderForTests(fakeFacilitator());
      setHouseWalletForTests(null);
      expect(houseWalletFor(paymentsOn)).toBeNull();
      expect(escrowDisabledReason(paymentsOn)).toMatch(/payments disabled|house wallet disabled/);
      const w = houseWalletFromPrivateKey(parseHousePrivateKey(HARDHAT_0));
      setHouseWalletForTests(w);
      expect(houseWalletFor(paymentsOn)).toBe(w);
    });
  });
});
