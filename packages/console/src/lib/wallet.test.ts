import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  chainIdFor,
  randomNonceHex,
  buildAuthorization,
  buildTypedData,
  encodePaymentHeader,
  walletAvailable,
  signBountyPayment,
  WalletError,
} from './wallet.js';
import type { PaymentRequirementsV2 } from '../api/types.js';

const REQ: PaymentRequirementsV2 = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '100000',
  payTo: '0x' + '1'.repeat(40),
  maxTimeoutSeconds: 3600,
  extra: { name: 'USD Coin', version: '2' },
};
const NOW = 1_800_000_000;
const SIG = '0x' + 'ab'.repeat(65);
const FROM = '0x' + '2'.repeat(40);

function decodeHeader(header: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as Record<string, unknown>;
}

afterEach(() => {
  delete (globalThis as { ethereum?: unknown }).ethereum;
  vi.restoreAllMocks();
});

describe('chainIdFor', () => {
  it('maps the two Base networks and rejects the rest', () => {
    expect(chainIdFor('eip155:8453')).toBe(8453);
    expect(chainIdFor('eip155:84532')).toBe(84532);
    expect(() => chainIdFor('eip155:1')).toThrow(/does not support/);
  });
});

describe('randomNonceHex', () => {
  it('is a 32-byte 0x hex string and unique per call', () => {
    const a = randomNonceHex();
    const b = randomNonceHex();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('buildAuthorization', () => {
  it('takes amount + recipient from the requirements and sets a valid window', () => {
    const auth = buildAuthorization(REQ, FROM, NOW);
    expect(auth.from).toBe(FROM);
    expect(auth.to).toBe(REQ.payTo);
    expect(auth.value).toBe(REQ.amount);
    expect(Number(auth.validAfter)).toBe(NOW - 60);
    expect(Number(auth.validBefore)).toBe(NOW + 3600);
    expect(auth.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    // validBefore must sit inside the API's accepted [now+120, now+4200] window.
    expect(Number(auth.validBefore)).toBeGreaterThanOrEqual(NOW + 120);
    expect(Number(auth.validBefore)).toBeLessThanOrEqual(NOW + 4200);
  });
});

describe('buildTypedData', () => {
  it('binds the USDC contract domain and TransferWithAuthorization message', () => {
    const auth = buildAuthorization(REQ, FROM, NOW);
    const td = buildTypedData(REQ, auth);
    expect(td.primaryType).toBe('TransferWithAuthorization');
    expect(td.domain).toEqual({
      name: 'USD Coin', version: '2', chainId: 8453,
      verifyingContract: REQ.asset,
    });
    expect(td.message).toBe(auth);
    expect(td.types.TransferWithAuthorization.map((f) => f.name))
      .toEqual(['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']);
  });
});

describe('encodePaymentHeader', () => {
  it('base64-encodes a well-formed x402 v2 payload', () => {
    const auth = buildAuthorization(REQ, FROM, NOW);
    const decoded = decodeHeader(encodePaymentHeader(REQ, auth, SIG));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted).toEqual(REQ);
    expect(decoded.payload).toEqual({ signature: SIG, authorization: auth });
  });
});

describe('walletAvailable', () => {
  it('reflects the presence of an injected provider', () => {
    expect(walletAvailable()).toBe(false);
    (globalThis as { ethereum?: unknown }).ethereum = { request: vi.fn() };
    expect(walletAvailable()).toBe(true);
  });
});

describe('signBountyPayment', () => {
  function installProvider(handlers: Record<string, (params?: unknown[]) => unknown>) {
    const request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      const h = handlers[method];
      if (!h) throw new Error(`unexpected method ${method}`);
      return h(params);
    });
    (globalThis as { ethereum?: unknown }).ethereum = { request };
    return request;
  }

  it('connects, signs, and returns the header + payer when already on Base', async () => {
    const request = installProvider({
      eth_requestAccounts: () => [FROM],
      eth_chainId: () => '0x2105', // 8453
      eth_signTypedData_v4: () => SIG,
    });
    const { header, from } = await signBountyPayment(REQ, NOW);
    expect(from).toBe(FROM);
    const decoded = decodeHeader(header);
    expect(decoded.x402Version).toBe(2);
    expect((decoded.payload as { signature: string }).signature).toBe(SIG);
    // eth_signTypedData_v4 was asked to sign for the connected account.
    const signCall = request.mock.calls.find((c) => c[0].method === 'eth_signTypedData_v4');
    expect(signCall?.[0].params?.[0]).toBe(FROM);
  });

  it('asks the wallet to switch to Base when it is on another chain', async () => {
    const request = installProvider({
      eth_requestAccounts: () => [FROM],
      eth_chainId: () => '0x1', // Ethereum mainnet
      wallet_switchEthereumChain: () => null,
      eth_signTypedData_v4: () => SIG,
    });
    await signBountyPayment(REQ, NOW);
    const switchCall = request.mock.calls.find((c) => c[0].method === 'wallet_switchEthereumChain');
    expect(switchCall?.[0].params?.[0]).toEqual({ chainId: '0x2105' });
  });

  it('surfaces a friendly message when the user declines the signature', async () => {
    installProvider({
      eth_requestAccounts: () => [FROM],
      eth_chainId: () => '0x2105',
      eth_signTypedData_v4: () => { throw { code: 4001, message: 'User rejected' }; },
    });
    await expect(signBountyPayment(REQ, NOW)).rejects.toBeInstanceOf(WalletError);
    await expect(signBountyPayment(REQ, NOW)).rejects.toThrow(/declined the signature/);
  });

  it('throws WalletError when no wallet is present', async () => {
    await expect(signBountyPayment(REQ, NOW)).rejects.toThrow(/No browser wallet/);
  });
});
