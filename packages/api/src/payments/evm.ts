/**
 * EVM primitives shared by the house wallet (house-wallet.ts) and the Arc relay
 * (arc.ts): hex/bytes, EIP-55 addresses, the house key parser, RLP and EIP-1559
 * transaction signing.
 *
 * A leaf module: it imports nothing from payments/index.ts or house-wallet.ts,
 * so the payment provider factory can build the Arc relay without an import
 * cycle. Workers-safe: @noble only, no Buffer, no node: imports.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

const PRIVATE_KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;
const utf8 = new TextEncoder();

// ─── Bytes / hex ───

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Big-endian bytes of a non-negative integer with no leading zeros (0 → empty), as RLP wants. */
export function bigintToBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new Error('bigintToBytes: negative value');
  if (value === 0n) return new Uint8Array(0);
  let hex = value.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return hexToBytes(hex);
}

// ─── Addresses and keys ───

/** EIP-55 checksummed address of a 20-byte account. */
export function toChecksumAddress(addr20: Uint8Array | string): `0x${string}` {
  const lower = (typeof addr20 === 'string' ? addr20.replace(/^0x/, '') : bytesToHex(addr20)).toLowerCase();
  if (lower.length !== 40) throw new Error('address must be 20 bytes');
  const hash = bytesToHex(keccak_256(utf8.encode(lower)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out as `0x${string}`;
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The EVM address of a secp256k1 private key (keccak of the uncompressed public key, last 20 bytes). */
export function addressFromPrivateKey(privateKey: Uint8Array): `0x${string}` {
  const pub = secp256k1.getPublicKey(privateKey, false); // 0x04 ‖ x ‖ y
  return toChecksumAddress(keccak_256(pub.slice(1)).slice(12));
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

// ─── RLP (Ethereum yellow paper, appendix B) ───

export type RlpItem = Uint8Array | RlpItem[];

function rlpLength(len: number, offset: number): Uint8Array {
  if (len < 56) return new Uint8Array([offset + len]);
  const lenBytes = bigintToBytes(BigInt(len));
  return concat(new Uint8Array([offset + 55 + lenBytes.length]), lenBytes);
}

export function rlpEncode(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) return item;
    return concat(rlpLength(item.length, 0x80), item);
  }
  const body = concat(...item.map(rlpEncode));
  return concat(rlpLength(body.length, 0xc0), body);
}

// ─── EIP-1559 (type 2) transactions ───

export interface Eip1559Tx {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gas: bigint;
  to: string;
  value: bigint;
  /** 0x-prefixed calldata. */
  data: string;
}

/**
 * Sign a type-2 transaction with an empty access list. Returns the raw
 * transaction for `eth_sendRawTransaction` and its hash (keccak of the raw bytes).
 */
export function signEip1559(tx: Eip1559Tx, privateKey: Uint8Array): { raw: `0x${string}`; hash: `0x${string}` } {
  if (!/^0x[0-9a-fA-F]{40}$/.test(tx.to)) throw new Error('signEip1559: `to` is not an address');
  if (!/^0x([0-9a-fA-F]{2})*$/.test(tx.data)) throw new Error('signEip1559: `data` is not hex');
  const fields: RlpItem[] = [
    bigintToBytes(tx.chainId), bigintToBytes(tx.nonce), bigintToBytes(tx.maxPriorityFeePerGas), bigintToBytes(tx.maxFeePerGas),
    bigintToBytes(tx.gas), hexToBytes(tx.to), bigintToBytes(tx.value), hexToBytes(tx.data), [],
  ];
  const digest = keccak_256(concat(new Uint8Array([0x02]), rlpEncode(fields)));
  const sig = secp256k1.sign(digest, privateKey, { lowS: true });
  const signed = concat(new Uint8Array([0x02]), rlpEncode([
    ...fields, bigintToBytes(BigInt(sig.recovery)), bigintToBytes(sig.r), bigintToBytes(sig.s),
  ]));
  return { raw: `0x${bytesToHex(signed)}`, hash: `0x${bytesToHex(keccak_256(signed))}` };
}
