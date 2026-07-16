/**
 * Browser-side sealing for connect cards (onboarding redesign Move 3).
 *
 * The pasted provider token is sealed HERE, in the browser, to the owner's
 * vault Ed25519 key — the control plane only ever receives ciphertext. This
 * imports the daemon's OWN sealed-box implementation
 * (`@basedagents/keyring/crypto`, pure @noble, isomorphic), so byte parity
 * with the daemon's `openSealedBox` is true by construction, and proven by
 * the cross-package test next to this file.
 */
import { sealToPublicKey } from '@basedagents/keyring/crypto';
import { base58Decode } from '@basedagents/keyring/util';

/**
 * Seal a plaintext to the signed-in owner's vault key. The owner id IS the
 * key: ow_<base58(vault Ed25519 pub)>.
 */
export function sealForOwner(ownerId: string, plaintext: string): string {
  if (!ownerId.startsWith('ow_')) throw new Error('not an account id');
  const vaultPub = base58Decode(ownerId.slice(3));
  return sealToPublicKey(vaultPub, new TextEncoder().encode(plaintext));
}
