/**
 * Browser wallet signing for task bounties (x402 v2, sign-at-accept).
 *
 * A human accepts a delivered bounty by signing an EIP-3009
 * `TransferWithAuthorization` in their own wallet — the exact amount and
 * recipient shown by the wallet UI. BasedAgents never holds the key or the
 * funds; the signed authorization goes to the API as the PAYMENT-SIGNATURE
 * header, and the facilitator settles it wallet-to-wallet on Base.
 *
 * No web3 library: we speak EIP-1193 (`window.ethereum`) directly and build the
 * EIP-712 payload by hand, so the console bundles nothing extra. The pure
 * helpers (chainIdFor / buildAuthorization / buildTypedData / encodePaymentHeader)
 * are exported for unit tests; only `signBountyPayment` touches the wallet.
 */
import type { PaymentRequirementsV2 } from '../api/types.js';

/** CAIP-2 network id → EVM chain id (the two Base chains the registry settles on). */
const NETWORK_CHAIN_IDS: Record<string, number> = {
  'eip155:8453': 8453, // Base mainnet
  'eip155:84532': 84532, // Base Sepolia
};

export function chainIdFor(network: string): number {
  const id = NETWORK_CHAIN_IDS[network];
  if (id === undefined) throw new Error(`This bounty settles on ${network}, which this wallet flow does not support.`);
  return id;
}

/** The signed EIP-3009 authorization (matches the API's ExactEvmAuthorization). */
export interface Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/** A random bytes32 nonce, `0x` + 64 hex — one authorization, used once. */
export function randomNonceHex(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Build the authorization the wallet signs. `validAfter` is now minus a minute
 * of clock slack; `validBefore` is now + 3600s (inside the API's accepted
 * [now+120, now+4200] window). Amount and recipient come straight from the
 * server's requirements — never from anything the browser chose.
 */
export function buildAuthorization(
  requirements: PaymentRequirementsV2,
  from: string,
  nowSec: number,
): Authorization {
  return {
    from,
    to: requirements.payTo,
    value: requirements.amount,
    validAfter: String(nowSec - 60),
    validBefore: String(nowSec + 3600),
    nonce: randomNonceHex(),
  };
}

/** The EIP-712 typed data for `eth_signTypedData_v4` (USDC TransferWithAuthorization). */
export function buildTypedData(requirements: PaymentRequirementsV2, auth: Authorization) {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization' as const,
    domain: {
      name: requirements.extra.name,
      version: requirements.extra.version,
      chainId: chainIdFor(requirements.network),
      verifyingContract: requirements.asset,
    },
    message: auth,
  };
}

/**
 * The PAYMENT-SIGNATURE header value: `base64(JSON.stringify(PaymentPayloadV2))`.
 * Every field is ASCII (hex + digits), so `btoa` is safe here.
 */
export function encodePaymentHeader(
  requirements: PaymentRequirementsV2,
  authorization: Authorization,
  signature: string,
): string {
  const payload = {
    x402Version: 2 as const,
    accepted: requirements,
    payload: { signature, authorization },
  };
  return btoa(JSON.stringify(payload));
}

// ─── EIP-1193 (browser wallet) ───

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function getEthereum(): Eip1193Provider | null {
  const eth = (globalThis as { ethereum?: Eip1193Provider }).ethereum;
  return eth ?? null;
}

/** True when a browser wallet (EIP-1193 provider) is present. */
export function walletAvailable(): boolean {
  return getEthereum() !== null;
}

const SIGNATURE_RE = /^0x[0-9a-fA-F]{130,}$/;

/** A wallet-flow failure with a message safe to show the user. */
export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletError';
  }
}

/** Map a raw provider error to friendly copy (4001 = the user declined). */
function walletMessage(err: unknown, fallback: string): string {
  const code = (err as { code?: number })?.code;
  if (code === 4001) return 'You declined the signature in your wallet.';
  const m = (err as { message?: string })?.message;
  return m ? `${fallback} (${m})` : fallback;
}

/**
 * Connect the browser wallet, make sure it is on the bounty's chain, and sign
 * the EIP-3009 transfer. Returns the PAYMENT-SIGNATURE header to send with the
 * accept, plus the address that signed (the payer). Throws `WalletError` with
 * user-safe copy on any failure.
 */
export async function signBountyPayment(
  requirements: PaymentRequirementsV2,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<{ header: string; from: string }> {
  const eth = getEthereum();
  if (!eth) throw new WalletError('No browser wallet found. Install one (e.g. MetaMask or Coinbase Wallet) to pay a bounty.');

  const wantChain = chainIdFor(requirements.network);
  const wantChainHex = '0x' + wantChain.toString(16);

  let accounts: string[];
  try {
    accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
  } catch (err) {
    throw new WalletError(walletMessage(err, 'Could not connect your wallet.'));
  }
  const from = accounts?.[0];
  if (!from) throw new WalletError('Your wallet returned no account. Unlock it and try again.');

  // Make sure the wallet is on Base — settling on the wrong chain would fail.
  try {
    const current = (await eth.request({ method: 'eth_chainId' })) as string;
    if (typeof current === 'string' && parseInt(current, 16) !== wantChain) {
      try {
        await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: wantChainHex }] });
      } catch (switchErr) {
        throw new WalletError(walletMessage(switchErr, `Switch your wallet to Base (chain ${wantChain}) and try again.`));
      }
    }
  } catch (err) {
    if (err instanceof WalletError) throw err;
    // A provider that cannot report its chain: proceed and let the signature stand or fall on its own.
  }

  const auth = buildAuthorization(requirements, from, nowSec);
  const typedData = buildTypedData(requirements, auth);

  let signature: string;
  try {
    signature = (await eth.request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify(typedData)] })) as string;
  } catch (err) {
    throw new WalletError(walletMessage(err, 'Could not sign the payment.'));
  }
  if (!SIGNATURE_RE.test(signature)) throw new WalletError('Your wallet returned an unexpected signature. Try again.');

  return { header: encodePaymentHeader(requirements, auth, signature), from };
}
