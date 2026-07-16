import { sha256 } from '@noble/hashes/sha256';
import { bytesToBase64url } from './webauthn.js';

/**
 * The action hash a passkey signs: base64url(sha256(utf8(canonical))).
 *
 * This MUST match the control plane's actionChallenge and the daemon's
 * (packages/keyring/src/control-actions.ts) byte for byte — they are the two
 * sides of the same contract (CONTROL_PLANE.md §2.1). The console recomputes it
 * from the server-returned `action_canonical` and refuses to sign unless it
 * equals the server-returned `challenge`: client-side WYSIWYS, so a compromised
 * control plane cannot make the human sign a challenge that does not match the
 * action shown on screen.
 */
export function actionChallenge(canonical: string): string {
  return bytesToBase64url(sha256(new TextEncoder().encode(canonical)));
}
