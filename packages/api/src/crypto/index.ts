/**
 * Cryptographic utilities for the Agent Registry.
 *
 * - Ed25519 signature verification
 * - Proof-of-Work validation
 * - Hash chain computation
 * - Base58 encoding/decoding
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { verifyAsync } from '@noble/ed25519';

export { sha256, bytesToHex, hexToBytes };

// ─── Base58 (Bitcoin alphabet) ───

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Encode bytes to base58 string.
 */
export function base58Encode(bytes: Uint8Array): string {
  // Count leading zeros
  let zeros = 0;
  for (const b of bytes) {
    if (b !== 0) break;
    zeros++;
  }

  // Convert to big integer
  let num = 0n;
  for (const b of bytes) {
    num = num * 256n + BigInt(b);
  }

  // Convert to base58
  const chars: string[] = [];
  while (num > 0n) {
    const rem = Number(num % 58n);
    num = num / 58n;
    chars.unshift(BASE58_ALPHABET[rem]);
  }

  // Add leading '1's for leading zero bytes
  for (let i = 0; i < zeros; i++) {
    chars.unshift('1');
  }

  return chars.join('');
}

/**
 * Decode base58 string to bytes.
 */
export function base58Decode(str: string): Uint8Array {
  // Count leading '1's
  let zeros = 0;
  for (const c of str) {
    if (c !== '1') break;
    zeros++;
  }

  // Convert from base58
  let num = 0n;
  for (const c of str) {
    const idx = BASE58_ALPHABET.indexOf(c);
    if (idx === -1) throw new Error(`Invalid base58 character: ${c}`);
    num = num * 58n + BigInt(idx);
  }

  // Convert to bytes
  const hex = num === 0n ? '' : num.toString(16).padStart(2, '0');
  // Ensure even length
  const paddedHex = hex.length % 2 ? '0' + hex : hex;
  const byteArray = new Uint8Array(zeros + paddedHex.length / 2);

  // Fill leading zeros
  for (let i = 0; i < zeros; i++) {
    byteArray[i] = 0;
  }

  // Fill remaining bytes
  for (let i = 0; i < paddedHex.length; i += 2) {
    byteArray[zeros + i / 2] = parseInt(paddedHex.substring(i, i + 2), 16);
  }

  return byteArray;
}

// ─── Proof of Work ───

/** Default PoW difficulty (number of leading zero bits required) */
export const DEFAULT_DIFFICULTY = 20;

/**
 * Count leading zero bits in a byte array.
 */
function countLeadingZeroBits(hash: Uint8Array): number {
  let count = 0;
  for (const byte of hash) {
    if (byte === 0) {
      count += 8;
    } else {
      // Count leading zeros in this byte
      for (let bit = 7; bit >= 0; bit--) {
        if ((byte >> bit) & 1) return count;
        count++;
      }
    }
  }
  return count;
}

/**
 * Verify that a proof-of-work nonce satisfies the difficulty requirement.
 * sha256(public_key || nonce) must have at least `difficulty` leading zero bits.
 */
export function verifyProofOfWork(
  publicKey: Uint8Array,
  nonce: string,
  difficulty: number
): boolean {
  const nonceBytes = hexToBytes(nonce);
  const data = new Uint8Array(publicKey.length + nonceBytes.length);
  data.set(publicKey);
  data.set(nonceBytes, publicKey.length);
  const hash = sha256(data);
  return countLeadingZeroBits(hash) >= difficulty;
}

// ─── Ed25519 Signature Verification ───

/**
 * Verify an Ed25519 signature.
 */
export async function verifySignature(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array
): Promise<boolean> {
  try {
    return await verifyAsync(signature, message, publicKey);
  } catch {
    return false;
  }
}

// ─── Hash Chain ───

/**
 * The genesis hash (all zeros) for the first chain entry.
 */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Compute a hash chain entry.
 * entry_hash = sha256(previous_hash || public_key || nonce || profile_hash || timestamp)
 */
export function computeChainHash(
  previousHash: string,
  publicKey: Uint8Array,
  nonce: string,
  profileHash: string,
  timestamp: string
): string {
  const encoder = new TextEncoder();
  // Concatenate all components as their string representations
  const parts = [
    encoder.encode(previousHash),
    publicKey,
    encoder.encode(nonce),
    encoder.encode(profileHash),
    encoder.encode(timestamp),
  ];
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const data = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  return bytesToHex(sha256(data));
}

/**
 * Hash a profile object for chain inclusion.
 * Uses canonical JSON (sorted keys) for deterministic hashing.
 */
export function hashProfile(profile: Record<string, unknown>): string {
  const json = JSON.stringify(profile, Object.keys(profile).sort());
  return bytesToHex(sha256(new TextEncoder().encode(json)));
}

/**
 * Generate an agent ID from a public key.
 * Format: ag_<base58(public_key)>
 */
export function publicKeyToAgentId(publicKey: Uint8Array): string {
  return `ag_${base58Encode(publicKey)}`;
}

/**
 * Extract the base58-encoded public key from an agent ID.
 */
export function agentIdToPublicKey(agentId: string): Uint8Array {
  if (!agentId.startsWith('ag_')) {
    throw new Error('Invalid agent ID format');
  }
  return base58Decode(agentId.slice(3));
}
