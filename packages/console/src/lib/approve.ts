/**
 * The full approve ceremony, shared by the novice home and the Approvals page.
 *
 * The ladder's top rung lives here: if the signed-in account has no passkey
 * yet, the FIRST approval mints one (ensurePasskey), then the ceremony runs
 * exactly as before — server-armed challenge, client-side WYSIWYS check
 * (CONTROL_PLANE.md §2: the passkey must sign the hash of exactly the action
 * shown; never an opaque challenge), fresh assertion, submit.
 */
import { control } from '../api/control.js';
import type { OwnerMe } from '../api/types.js';
import { actionChallenge } from './action.js';
import { getAssertion } from './webauthn.js';
import { ensurePasskey } from './firstApproval.js';

/**
 * Approve one request. Returns whether this call minted the account's first
 * passkey — the caller should refresh the session when it did.
 */
export async function approveRequest(owner: OwnerMe, requestId: string): Promise<{ minted: boolean }> {
  const minted = await ensurePasskey(owner);
  const begin = await control.approveBegin(requestId);
  if (actionChallenge(begin.action_canonical) !== begin.challenge) {
    throw new Error('Refusing to sign — the server challenge does not match the action shown. Do not approve.');
  }
  const assertion = await getAssertion({
    challenge: begin.challenge,
    rpId: begin.rpId,
    allowCredentials: begin.allowCredentials,
    timeout: begin.timeout,
  });
  await control.approve(requestId, begin.nonce, assertion);
  return { minted };
}
