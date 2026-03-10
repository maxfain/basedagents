/**
 * Cryptographic utilities for the Agent Registry.
 *
 * - Ed25519 signature verification
 * - Proof-of-Work validation
 * - Hash chain computation
 *
 * Business logic will be implemented by the backend agent.
 * This file provides the type-safe stubs.
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

export { sha256, bytesToHex };

/**
 * Verify that a proof-of-work nonce satisfies the difficulty requirement.
 * sha256(public_key || nonce) must have at least `difficulty` leading zero bits.
 */
export function verifyProofOfWork(
  _publicKey: Uint8Array,
  _nonce: string,
  _difficulty: number
): boolean {
  // TODO: Implement — backend agent
  throw new Error('Not implemented');
}

/**
 * Verify an Ed25519 signature.
 */
export async function verifySignature(
  _message: Uint8Array,
  _signature: Uint8Array,
  _publicKey: Uint8Array
): Promise<boolean> {
  // TODO: Implement — backend agent
  throw new Error('Not implemented');
}

/**
 * Compute a hash chain entry.
 * entry_hash = sha256(previous_hash || public_key || nonce || profile_hash || timestamp)
 */
export function computeChainHash(
  _previousHash: string,
  _publicKey: Uint8Array,
  _nonce: string,
  _profileHash: string,
  _timestamp: string
): string {
  // TODO: Implement — backend agent
  throw new Error('Not implemented');
}

/**
 * Hash a profile object for chain inclusion.
 */
export function hashProfile(_profile: Record<string, unknown>): string {
  const json = JSON.stringify(_profile, Object.keys(_profile).sort());
  return bytesToHex(sha256(new TextEncoder().encode(json)));
}

/**
 * The genesis hash (all zeros) for the first chain entry.
 */
export const GENESIS_HASH = '0'.repeat(64);
