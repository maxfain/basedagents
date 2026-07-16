/**
 * First-approval passkey minting (the ladder's top rung).
 *
 * "Sessions to look, signatures to act" is unchanged — only the passkey's
 * birthday moved: it is created at the user's FIRST approval, the moment they
 * try to act, which is exactly when a novice understands why they're being
 * asked. Call this before any action ceremony; it is a no-op once a passkey
 * exists. The vault public key needed for registration is derived from the
 * signed-in account id itself — nothing to type, nothing to get wrong.
 */
import { control } from '../api/control.js';
import { createPasskey } from './webauthn.js';
import { funnelPing } from './funnel.js';
import type { OwnerMe } from '../api/types.js';

export async function ensurePasskey(owner: OwnerMe): Promise<boolean> {
  if (owner.has_passkey) return false;
  const vaultPublicKey = owner.owner_id.slice(3); // ow_<base58 vault pub>
  const begin = await control.registerBegin(vaultPublicKey, owner.email ?? undefined);
  const reg = await createPasskey(begin.options);
  await control.registerFinish(vaultPublicKey, reg);
  funnelPing('passkey_created');
  return true; // minted just now
}
