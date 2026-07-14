/**
 * Shared utilities — canonical JSON, base58, hex, IDs.
 *
 * Deliberately duplicated from packages/sdk (same convention as packages/mcp):
 * keyring is independently publishable and must not depend on the SDK package.
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';

export { bytesToHex, randomBytes };

// ─── Canonical JSON ───

/**
 * Canonical JSON serialization — recursively sorts object keys, compact separators.
 * Ensures deterministic output for signature payloads across implementations.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJsonStringify).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys.map(k => JSON.stringify(k) + ':' + canonicalJsonStringify((value as Record<string, unknown>)[k]));
    return '{' + pairs.join(',') + '}';
  }
  return JSON.stringify(value);
}

// ─── Base58 ───

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  for (const b of bytes) { if (b !== 0) break; zeros++; }
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  const chars: string[] = [];
  while (num > 0n) {
    chars.unshift(BASE58_ALPHABET[Number(num % 58n)]);
    num = num / 58n;
  }
  for (let i = 0; i < zeros; i++) chars.unshift('1');
  return chars.join('');
}

export function base58Decode(str: string): Uint8Array {
  let zeros = 0;
  for (const c of str) { if (c !== '1') break; zeros++; }
  let num = 0n;
  for (const c of str) {
    const idx = BASE58_ALPHABET.indexOf(c);
    if (idx === -1) throw new Error(`Invalid base58 character: ${c}`);
    num = num * 58n + BigInt(idx);
  }
  const hex = num === 0n ? '' : num.toString(16);
  const padded = hex.length % 2 ? '0' + hex : hex;
  const result = new Uint8Array(zeros + padded.length / 2);
  for (let i = 0; i < padded.length; i += 2) {
    result[zeros + i / 2] = parseInt(padded.substring(i, i + 2), 16);
  }
  return result;
}

// ─── Hex / Base64 ───

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

// ─── Hashing ───

export function sha256Hex(data: string | Uint8Array): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return bytesToHex(sha256(bytes));
}

// ─── Agent IDs ───

/** Derive an agent ID from a public key. Format: ag_<base58(pubkey)> */
export function publicKeyToAgentId(publicKey: Uint8Array): string {
  return `ag_${base58Encode(publicKey)}`;
}

/** Extract the public key from an agent ID. */
export function agentIdToPublicKey(agentId: string): Uint8Array {
  if (!agentId.startsWith('ag_')) throw new Error('Invalid agent ID — must start with ag_');
  const pub = base58Decode(agentId.slice(3));
  if (pub.length !== 32) throw new Error('Invalid agent ID — public key must be 32 bytes');
  return pub;
}

// ─── IDs & time ───

/** Random, URL-safe object ID: <prefix>_<base58(16 random bytes)> */
export function randomId(prefix: string): string {
  return `${prefix}_${base58Encode(randomBytes(16))}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
