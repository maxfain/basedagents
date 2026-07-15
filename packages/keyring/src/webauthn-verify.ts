/**
 * Daemon-side WebAuthn assertion verification (ES256 / P-256).
 *
 * The local vault daemon re-verifies the owner's passkey assertion before it
 * seals — it never trusts a control-plane decision (CONTROL_PLANE.md §2). This
 * is a focused verifier for the one case the daemon needs: an ES256 assertion
 * (`navigator.credentials.get()`) whose anchored public key is stored raw, so no
 * CBOR/COSE parsing is required. Pure @noble — no WebAuthn library, keeping the
 * on-machine daemon lean.
 */

import { p256 } from '@noble/curves/nist';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, concatBytes } from '@noble/hashes/utils';
import { base64urlDecode } from './control-actions.js';

const UP_FLAG = 0x01; // User Present

export interface OwnerAssertionInput {
  /** Anchored uncompressed P-256 public key (0x04‖x‖y), hex. */
  publicKeyHex: string;
  authenticatorData: string; // base64url
  clientDataJSON: string;    // base64url
  signature: string;         // base64url, ASN.1 DER ECDSA
  /** base64url — the action hash the assertion must have signed. */
  expectedChallenge: string;
  expectedOrigins: string[];
  expectedRPID: string;
}

/**
 * Verify an owner passkey assertion. Throws on ANY mismatch (bad challenge,
 * wrong origin/rpId, absent User-Present, bad signature). Returns void on
 * success. Callers treat a throw as "not owner-authorized".
 */
export function verifyOwnerAssertion(input: OwnerAssertionInput): void {
  // 1. clientDataJSON: type, challenge (WYSIWYS binding), origin.
  const clientDataBytes = base64urlDecode(input.clientDataJSON);
  let clientData: { type?: string; challenge?: string; origin?: string };
  try {
    clientData = JSON.parse(new TextDecoder().decode(clientDataBytes)) as typeof clientData;
  } catch {
    throw new Error('assertion: clientDataJSON is not valid JSON');
  }
  if (clientData.type !== 'webauthn.get') {
    throw new Error(`assertion: unexpected clientData type "${clientData.type ?? ''}"`);
  }
  if (clientData.challenge !== input.expectedChallenge) {
    throw new Error('assertion: signed challenge does not match the expected action hash');
  }
  if (!clientData.origin || !input.expectedOrigins.includes(clientData.origin)) {
    throw new Error(`assertion: origin "${clientData.origin ?? ''}" is not allowed`);
  }

  // 2. authenticatorData: rpIdHash + User-Present.
  const authData = base64urlDecode(input.authenticatorData);
  if (authData.length < 37) throw new Error('assertion: authenticatorData too short');
  const rpIdHash = authData.slice(0, 32);
  const expectedRpIdHash = sha256(new TextEncoder().encode(input.expectedRPID));
  if (!timingSafeEqualBytes(rpIdHash, expectedRpIdHash)) {
    throw new Error('assertion: rpIdHash does not match the expected RP ID');
  }
  const flags = authData[32];
  if ((flags & UP_FLAG) === 0) throw new Error('assertion: User-Present flag not set');

  // 3. ECDSA-P256 over sha256(authData ‖ sha256(clientDataJSON)).
  const clientDataHash = sha256(clientDataBytes);
  const signedMessage = concatBytes(authData, clientDataHash);
  const msgHash = sha256(signedMessage);

  const pubKey = hexToBytes(input.publicKeyHex);
  let sigCompact: Uint8Array;
  try {
    sigCompact = p256.Signature.fromDER(base64urlDecode(input.signature)).toCompactRawBytes();
  } catch {
    throw new Error('assertion: signature is not valid DER');
  }
  // lowS:false — browser/authenticator signatures are not required to be low-S.
  const ok = p256.verify(sigCompact, msgHash, pubKey, { lowS: false });
  if (!ok) throw new Error('assertion: ECDSA signature verification failed');
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
