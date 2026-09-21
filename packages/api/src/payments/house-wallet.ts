/**
 * The registry's HOUSE WALLET — the escrow account for task bounties (Tasks P1).
 *
 * Escrow means BasedAgents holds a buyer's USDC between posting and acceptance,
 * so the server needs a key that can move funds OUT of that wallet: an EIP-3009
 * `TransferWithAuthorization` signed by the house key is exactly what the CDP
 * facilitator already broadcasts for buyers. Nothing else changes on the money
 * path — a release or refund is one more x402 payload through `settleTask`,
 * with the house as `from` and a fresh nonce.
 *
 * Workers-safe: @noble/curves secp256k1 + @noble/hashes keccak, no Buffer, no
 * node: imports. The private key never leaves this module: callers get the
 * address and a signer, never the bytes.
 *
 * Fail closed: `houseWalletFor(env)` is null (and `escrowDisabledReason`
 * says why) unless payments are enabled AND `ESCROW_WALLET_PRIVATE_KEY` is a
 * valid 32-byte secp256k1 key. `TASK_ESCROW_ENABLED='0'` pauses NEW deposits
 * only — a funded task must always be releasable/refundable.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import type { Bindings } from '../types/index.js';
import { paymentProviderFor, paymentsDisabledReason, type PaymentsEnv } from './index.js';
import {
  assetFor, isNetwork, PaymentPayloadV2, type PaymentRequirementsV2, MAX_TIMEOUT_SECONDS, type X402Env,
} from './x402.js';

export type EscrowEnv = PaymentsEnv & Pick<Bindings, 'ESCROW_WALLET_PRIVATE_KEY' | 'TASK_ESCROW_ENABLED'> & X402Env;

const PRIVATE_KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;
const utf8 = new TextEncoder();

// ─── Bytes / hex ───

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** A 32-byte ABI word: big-endian uint256 / left-padded address / bytes32. */
function word(value: bigint | Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  if (value instanceof Uint8Array) {
    if (value.length > 32) throw new Error('word: value longer than 32 bytes');
    out.set(value, 32 - value.length);
    return out;
  }
  let v = value;
  if (v < 0n) throw new Error('word: negative value');
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  if (v !== 0n) throw new Error('word: value does not fit in 256 bits');
  return out;
}

// ─── Addresses ───

/** EIP-55 checksummed address of a 20-byte account. */
export function toChecksumAddress(addr20: Uint8Array | string): `0x${string}` {
  const lower = (typeof addr20 === 'string' ? addr20.replace(/^0x/, '') : bytesToHex(addr20)).toLowerCase();
  if (lower.length !== 40) throw new Error('address must be 20 bytes');
  const hash = bytesToHex(keccak_256(utf8.encode(lower)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out as `0x${string}`;
}

/** The EVM address of a secp256k1 private key (keccak of the uncompressed public key, last 20 bytes). */
export function addressFromPrivateKey(privateKey: Uint8Array): `0x${string}` {
  const pub = secp256k1.getPublicKey(privateKey, false); // 0x04 ‖ x ‖ y
  return toChecksumAddress(keccak_256(pub.slice(1)).slice(12));
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// ─── EIP-712 TransferWithAuthorization (USDC / EIP-3009) ───

const DOMAIN_TYPEHASH = keccak_256(utf8.encode('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
const TRANSFER_TYPEHASH = keccak_256(utf8.encode(
  'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)',
));

export interface TransferAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/** The EIP-712 domain separator of the USDC contract the requirements name. */
export function domainSeparator(requirements: Pick<PaymentRequirementsV2, 'network' | 'asset' | 'extra'>): Uint8Array {
  if (!isNetwork(requirements.network)) throw new Error(`unsupported network ${requirements.network}`);
  const chainId = BigInt(requirements.network.split(':')[1]);
  return keccak_256(concat(
    DOMAIN_TYPEHASH,
    keccak_256(utf8.encode(requirements.extra.name)),
    keccak_256(utf8.encode(requirements.extra.version)),
    word(chainId),
    word(hexToBytes(requirements.asset)),
  ));
}

/** keccak256("\x19\x01" ‖ domainSeparator ‖ structHash) — what the wallet signs (`eth_signTypedData_v4`). */
export function transferWithAuthorizationDigest(
  requirements: Pick<PaymentRequirementsV2, 'network' | 'asset' | 'extra'>,
  auth: TransferAuthorization,
): Uint8Array {
  const structHash = keccak_256(concat(
    TRANSFER_TYPEHASH,
    word(hexToBytes(auth.from)),
    word(hexToBytes(auth.to)),
    word(BigInt(auth.value)),
    word(BigInt(auth.validAfter)),
    word(BigInt(auth.validBefore)),
    word(hexToBytes(auth.nonce)),
  ));
  return keccak_256(concat(new Uint8Array([0x19, 0x01]), domainSeparator(requirements), structHash));
}

/** A random bytes32 nonce, `0x` + 64 hex — one authorization, used once. */
export function randomNonceHex(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return '0x' + bytesToHex(b);
}

/** `validAfter` slack (clock skew) and lifetime of a house-signed authorization. */
export const HOUSE_VALID_AFTER_SLACK = 60;
export const HOUSE_AUTHORIZATION_TTL = MAX_TIMEOUT_SECONDS;

// ─── The wallet ───

export interface HouseWallet {
  /** EIP-55 checksummed address — the escrow account buyers deposit to. */
  readonly address: `0x${string}`;
  /**
   * Sign an EIP-3009 transfer of `requirements.amount` from the house wallet
   * to `requirements.payTo`, as an x402 v2 payment payload — byte-compatible
   * with what a buyer's wallet produces, so `settleTask` cannot tell the two
   * apart. `validBefore = nowSec + 3600`.
   */
  signTransfer(requirements: PaymentRequirementsV2, nowSec: number, nonce?: string): PaymentPayloadV2;
}

export class HouseKeyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HouseKeyFormatError';
  }
}

/** Parse a 64-hex (optionally 0x-prefixed) secp256k1 private key; rejects zero / out-of-range keys. */
export function parseHousePrivateKey(raw: string): Uint8Array {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new HouseKeyFormatError('ESCROW_WALLET_PRIVATE_KEY is empty');
  const trimmed = raw.trim();
  if (!PRIVATE_KEY_RE.test(trimmed)) throw new HouseKeyFormatError('ESCROW_WALLET_PRIVATE_KEY must be 64 hex characters (32 bytes), optionally 0x-prefixed');
  const bytes = hexToBytes(trimmed);
  if (!secp256k1.utils.isValidPrivateKey(bytes)) throw new HouseKeyFormatError('ESCROW_WALLET_PRIVATE_KEY is not a valid secp256k1 private key');
  return bytes;
}

/** Build a signer around a private key. The key is captured in a closure and never exposed. */
export function houseWalletFromPrivateKey(privateKey: Uint8Array): HouseWallet {
  const address = addressFromPrivateKey(privateKey);
  return {
    address,
    signTransfer(requirements, nowSec, nonce = randomNonceHex()) {
      const auth: TransferAuthorization = {
        from: address,
        to: requirements.payTo,
        value: requirements.amount,
        validAfter: String(Math.max(0, nowSec - HOUSE_VALID_AFTER_SLACK)),
        validBefore: String(nowSec + HOUSE_AUTHORIZATION_TTL),
        nonce,
      };
      const digest = transferWithAuthorizationDigest(requirements, auth);
      const sig = secp256k1.sign(digest, privateKey, { lowS: true });
      const v = 27 + sig.recovery;
      const signature = '0x' + bytesToHex(sig.toCompactRawBytes()) + v.toString(16).padStart(2, '0');
      return PaymentPayloadV2.parse({ x402Version: 2, accepted: requirements, payload: { signature, authorization: auth } });
    },
  };
}

/** Recover the signer of an x402 payload's authorization (used by tests and the enable-checklist script). */
export function recoverAuthorizationSigner(payload: PaymentPayloadV2): `0x${string}` {
  const sigHex = payload.payload.signature.slice(2);
  const rs = hexToBytes(sigHex.slice(0, 128));
  let v = parseInt(sigHex.slice(128, 130), 16);
  if (v >= 27) v -= 27;
  const digest = transferWithAuthorizationDigest(payload.accepted, payload.payload.authorization);
  const pub = secp256k1.Signature.fromCompact(rs).addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(false);
  return toChecksumAddress(keccak_256(pub.slice(1)).slice(12));
}

// ─── Env → wallet (fail closed, memoised per isolate) ───

/** `undefined` = derive from env; `null` = forced disabled; otherwise the injected wallet. */
let testOverride: HouseWallet | null | undefined = undefined;
let memo: { raw: string; wallet: HouseWallet } | null = null;
/** The last house-key problem logged by this isolate: one line per distinct reason. */
let lastLoggedReason: string | null = null;

/**
 * Why NEW escrow deposits are unavailable on this deploy, or null when
 * escrow is fully enabled. Payments must be on (the facilitator moves every
 * leg), the house key must parse, and the pause switch must not be '0'.
 */
export function escrowDisabledReason(env: EscrowEnv | undefined | null): string | null {
  // paymentProviderFor honours the test override; the reason text is for operators.
  if (!paymentProviderFor(env)) return `payments disabled: ${paymentsDisabledReason(env) ?? 'provider disabled for tests'}`;
  const key = houseKeyReason(env);
  if (key) return key;
  if (env?.TASK_ESCROW_ENABLED === '0') return "TASK_ESCROW_ENABLED is '0' (new deposits paused)";
  return null;
}

function houseKeyReason(env: EscrowEnv | undefined | null): string | null {
  if (testOverride === null) return 'house wallet disabled for tests';
  if (testOverride) return null;
  if (!env?.ESCROW_WALLET_PRIVATE_KEY) return 'ESCROW_WALLET_PRIVATE_KEY is not set';
  try {
    parseHousePrivateKey(env.ESCROW_WALLET_PRIVATE_KEY);
  } catch (err) {
    return (err as Error).message;
  }
  return null;
}

/** True when a NEW escrow task can be posted right now. */
export function escrowAvailable(env: EscrowEnv | undefined | null): boolean {
  return escrowDisabledReason(env) === null;
}

/**
 * The house wallet for signing releases and refunds — or null when the key
 * is absent/invalid or payments are off. Deliberately ignores the
 * TASK_ESCROW_ENABLED pause: funds already held must always be able to leave.
 */
export function houseWalletFor(env: EscrowEnv | undefined | null): HouseWallet | null {
  if (testOverride !== undefined) return testOverride;
  if (!paymentProviderFor(env)) return null;
  const raw = env?.ESCROW_WALLET_PRIVATE_KEY;
  if (!raw) return null;
  if (memo && memo.raw === raw) return memo.wallet;
  let key: Uint8Array;
  try {
    key = parseHousePrivateKey(raw);
  } catch (err) {
    const reason = (err as Error).message;
    if (reason !== lastLoggedReason) {
      lastLoggedReason = reason;
      console.error(`[escrow] house wallet disabled: ${reason}`);
    }
    return null;
  }
  const wallet = houseWalletFromPrivateKey(key);
  memo = { raw, wallet };
  return wallet;
}

/**
 * Test hook. `undefined` restores env-derived behaviour; `null` forces
 * "no house wallet"; a wallet object is returned verbatim.
 */
export function setHouseWalletForTests(w: HouseWallet | null | undefined): void {
  testOverride = w;
  memo = null;
  lastLoggedReason = null;
}

/** The asset + EIP-712 domain a house-signed leg uses on `network` (same source as buyer requirements). */
export function houseAssetFor(network: string, env?: X402Env | null) {
  if (!isNetwork(network)) throw new Error(`unsupported network ${network}`);
  return assetFor(network, env);
}
