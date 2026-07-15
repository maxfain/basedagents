/**
 * Owner identity helpers for the Keyring control plane.
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * The owner's `ow_` identity is DERIVED from the Ed25519 vault (confidentiality)
 * public key, mirroring how an agent's `ag_` identity is derived from its
 * signing key in crypto/index.ts (publicKeyToAgentId). The vault key is the root
 * of confidentiality (CONTROL_PLANE.md §1); the passkey is the root of authority.
 */
import { base58Encode, base58Decode } from '../crypto/index.js';

/** Prefix for owner identities. */
export const OWNER_ID_PREFIX = 'ow_';

/** Ed25519 public keys are 32 bytes. */
const VAULT_PUBKEY_LENGTH = 32;

/**
 * Derive an owner id from the Ed25519 vault public key.
 * Format: ow_<base58(vault_ed25519_pub)>.
 */
export function ownerIdFromVaultPubkey(pubkey: Uint8Array): string {
  if (!(pubkey instanceof Uint8Array) || pubkey.length !== VAULT_PUBKEY_LENGTH) {
    throw new Error(
      `Invalid vault public key: expected ${VAULT_PUBKEY_LENGTH} bytes, got ${
        pubkey instanceof Uint8Array ? pubkey.length : typeof pubkey
      }`
    );
  }
  return `${OWNER_ID_PREFIX}${base58Encode(pubkey)}`;
}

/**
 * Extract and validate the 32-byte Ed25519 vault public key from an owner id.
 * Throws if the prefix is missing or the decoded key is not exactly 32 bytes.
 */
export function vaultPubkeyFromOwnerId(ownerId: string): Uint8Array {
  if (typeof ownerId !== 'string' || !ownerId.startsWith(OWNER_ID_PREFIX)) {
    throw new Error('Invalid owner id: missing ow_ prefix');
  }
  const encoded = ownerId.slice(OWNER_ID_PREFIX.length);
  if (encoded.length === 0) {
    throw new Error('Invalid owner id: empty key');
  }
  // base58Decode throws on invalid characters.
  const decoded = base58Decode(encoded);
  if (decoded.length !== VAULT_PUBKEY_LENGTH) {
    throw new Error(
      `Invalid owner id: expected a ${VAULT_PUBKEY_LENGTH}-byte key, got ${decoded.length}`
    );
  }
  return decoded;
}

/**
 * Whether a string is a well-formed owner id (ow_ + a 32-byte base58 key).
 * Never throws.
 */
export function isOwnerId(s: string): boolean {
  if (typeof s !== 'string' || !s.startsWith(OWNER_ID_PREFIX)) return false;
  try {
    vaultPubkeyFromOwnerId(s);
    return true;
  } catch {
    return false;
  }
}
