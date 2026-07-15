/**
 * WebAuthn verification core for the Keyring control plane.
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * Implements the passkey crypto that CONTROL_PLANE.md §2/§3/§7 rely on:
 *   - §3 "signatures to act": every mutating action needs a fresh WebAuthn
 *     assertion whose challenge is `sha256(canonical_action)` (see
 *     {@link actionChallenge}).
 *   - §2: the assertion pins the exact action (incl. the grantee pubkey) so the
 *     daemon can re-verify what it is about to seal.
 *   - §7: assertions verify rpIdHash, origin (allow-list), type, the
 *     server-issued single-use challenge, and the User Present flag.
 *
 * This module is PURE CRYPTO. It never reads or writes the database. In
 * particular it does NOT enforce signature-counter monotonicity or
 * challenge single-use — those are atomic conditional writes at the DB layer
 * (CONTROL_PLANE.md §4). It only *returns* the new counter so the caller can
 * enforce monotonicity atomically. Any verification mismatch THROWS; callers
 * map the throw to HTTP 401.
 *
 * Runtime: Web-Crypto only (globalThis.crypto). Runs on Cloudflare Workers and
 * Node 20+. @simplewebauthn/server v13 obtains its Crypto instance from
 * `globalThis.crypto` exclusively (no node:crypto import), so it bundles for
 * Workers.
 */

import {
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import {
  decodeAttestationObject,
  parseAuthenticatorData,
  isoBase64URL,
} from '@simplewebauthn/server/helpers';
import { sha256 } from '../crypto/index.js';

// ─── base64url helpers (Web-Crypto / Uint8Array based, no Buffer) ───

const textEncoder = new TextEncoder();

/** Encode bytes to unpadded base64url. */
export function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode an unpadded (or padded) base64url string to bytes. */
export function base64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  const base64 =
    value.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ─── Action challenge (CONTROL_PLANE.md §2/§3) ───

/**
 * Compute the WebAuthn challenge that binds an assertion to an exact action.
 *
 * `canonicalAction` is a canonical JSON string of the action (for a grant it
 * MUST include the grantee pubkey, the credential id, and the constraints — not
 * just a request id; CONTROL_PLANE.md §2 step 2).
 *
 * The returned value is base64url(sha256(canonicalAction)) and is used as BOTH
 * the WebAuthn challenge and `webauthn_challenges.action_hash`. Deterministic:
 * the same canonical action always yields the same challenge.
 */
export function actionChallenge(canonicalAction: string): string {
  return base64urlEncode(sha256(textEncoder.encode(canonicalAction)));
}

// ─── Registration ───

export interface VerifiedRegistration {
  /** base64url WebAuthn credential id. */
  credentialId: string;
  /** COSE public key bytes — store as-is in owner_webauthn_credentials.public_key. */
  cosePublicKey: Uint8Array;
  /** Initial signature counter reported by the authenticator. */
  counter: number;
  /** Authenticator Attestation GUID, if reported. */
  aaguid?: string;
  /** Whether the (multi-device) credential is backed up. */
  backedUp: boolean;
  /** Authenticator transports, if reported. */
  transports?: string[];
}

export async function verifyRegistration(input: {
  attestationObject: string; // base64url from navigator.credentials.create()
  clientDataJSON: string; // base64url
  expectedChallenge: string; // base64url the server issued
  expectedOrigin: string[]; // allow-list
  expectedRPID: string; // registrable domain, e.g. 'basedagents.ai'
}): Promise<VerifiedRegistration> {
  // The browser sends the credential id at the top level of the response; our
  // input carries only the attestation, so derive it from the attestation's
  // attestedCredentialData. This also rejects a malformed attestation (or one
  // with no attested credential data) early with a clear error.
  let credentialId: string;
  try {
    const decoded = decodeAttestationObject(base64urlDecode(input.attestationObject));
    const authData = decoded.get('authData');
    const parsed = parseAuthenticatorData(authData);
    if (!parsed.credentialID) {
      throw new Error('attestation contained no attested credential data');
    }
    credentialId = isoBase64URL.fromBuffer(parsed.credentialID);
  } catch (err) {
    throw new Error(
      `WebAuthn registration verification failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const response: RegistrationResponseJSON = {
    id: credentialId,
    rawId: credentialId,
    response: {
      attestationObject: input.attestationObject,
      clientDataJSON: input.clientDataJSON,
    },
    clientExtensionResults: {},
    type: 'public-key',
  };

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRPID,
      // §7 requires the User Present flag (enforced by the library). We do not
      // require User Verification here so authenticators that only assert
      // presence are accepted; UP is always enforced regardless.
      requireUserPresence: true,
      requireUserVerification: false,
    });
  } catch (err) {
    throw new Error(
      `WebAuthn registration verification failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('WebAuthn registration verification failed');
  }

  const info = verification.registrationInfo;
  return {
    credentialId: info.credential.id,
    cosePublicKey: info.credential.publicKey,
    counter: info.credential.counter,
    aaguid: info.aaguid || undefined,
    backedUp: info.credentialBackedUp,
    transports: info.credential.transports,
  };
}

// ─── Assertion (authentication / action) ───

export interface VerifiedAssertion {
  /** Counter reported by this assertion — caller enforces monotonicity at the DB layer. */
  newCounter: number;
  /** User Present flag from the authenticator data (always true on success). */
  userPresent: boolean;
}

export async function verifyAssertion(input: {
  credentialId: string; // base64url
  authenticatorData: string; // base64url from navigator.credentials.get()
  clientDataJSON: string; // base64url
  signature: string; // base64url
  cosePublicKey: Uint8Array; // as stored at registration
  expectedChallenge: string; // base64url (for an action: actionChallenge(canonicalAction))
  expectedOrigin: string[];
  expectedRPID: string;
}): Promise<VerifiedAssertion> {
  const response: AuthenticationResponseJSON = {
    id: input.credentialId,
    rawId: input.credentialId,
    response: {
      authenticatorData: input.authenticatorData,
      clientDataJSON: input.clientDataJSON,
      signature: input.signature,
    },
    clientExtensionResults: {},
    type: 'public-key',
  };

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRPID,
      credential: {
        id: input.credentialId,
        // Copy into an ArrayBuffer-backed view for the library's typed-array API.
        publicKey: new Uint8Array(input.cosePublicKey),
        // Pass 0 so the library does not reject on its own counter check; the
        // control plane enforces monotonicity against the STORED counter with
        // an atomic conditional UPDATE (CONTROL_PLANE.md §4).
        counter: 0,
      },
      // §7: enforce User Present (always) but not User Verification (see above).
      requireUserVerification: false,
    });
  } catch (err) {
    throw new Error(
      `WebAuthn assertion verification failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!verification.verified) {
    throw new Error('WebAuthn assertion verification failed');
  }

  // The library throws if the UP flag is absent, so on success it is set. Read
  // it back from the authenticator data to report the true value.
  const authData = base64urlDecode(input.authenticatorData);
  const userPresent = authData.length > 32 && (authData[32] & 0x01) === 0x01;

  return {
    newCounter: verification.authenticationInfo.newCounter,
    userPresent,
  };
}
