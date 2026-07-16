/**
 * Browser WebAuthn plumbing for the owner console.
 *
 * The control plane speaks base64url everywhere (packages/api/src/control/
 * webauthn.ts): challenges, credential ids, attestation/assertion blobs. The
 * browser WebAuthn API speaks ArrayBuffer. This module is the exact bridge, so
 * the console produces byte-identical inputs to what the server verifies. The
 * pure encoders are unit-tested; the ceremony wrappers only run in a browser.
 */

/** Decode an unpadded (or padded) base64url string to bytes. */
export function base64urlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Encode bytes to unpadded base64url (the form the control plane expects). */
export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url → a standalone ArrayBuffer for the WebAuthn API. */
function toBuffer(value: string): ArrayBuffer {
  return base64urlToBytes(value).buffer as ArrayBuffer;
}

/** True when this browser can do passkeys at all. */
export function passkeysSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    !!navigator.credentials
  );
}

// ─── Registration (navigator.credentials.create) ───

export interface RegistrationOptions {
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
  excludeCredentials?: Array<{ type: 'public-key'; id: string; transports?: string[] }>;
  timeout?: number;
}

export interface RegistrationResult {
  attestationObject: string;
  clientDataJSON: string;
  transports?: string[];
}

export async function createPasskey(options: RegistrationOptions): Promise<RegistrationResult> {
  const publicKey: PublicKeyCredentialCreationOptions = {
    rp: options.rp,
    user: {
      id: toBuffer(options.user.id),
      name: options.user.name,
      displayName: options.user.displayName,
    },
    challenge: toBuffer(options.challenge),
    pubKeyCredParams: options.pubKeyCredParams,
    authenticatorSelection: options.authenticatorSelection,
    attestation: options.attestation,
    excludeCredentials: options.excludeCredentials?.map((c) => ({
      type: 'public-key' as const,
      id: toBuffer(c.id),
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
    timeout: options.timeout,
  };
  const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!credential) throw new Error('Passkey creation was cancelled.');
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    attestationObject: bytesToBase64url(new Uint8Array(response.attestationObject)),
    clientDataJSON: bytesToBase64url(new Uint8Array(response.clientDataJSON)),
    transports: typeof response.getTransports === 'function' ? response.getTransports() : undefined,
  };
}

// ─── Assertion (navigator.credentials.get) — login and actions ───

export interface AssertionOptions {
  challenge: string;
  rpId: string;
  allowCredentials?: Array<{ type: 'public-key'; id: string; transports?: string[] }>;
  userVerification?: UserVerificationRequirement;
  timeout?: number;
}

export interface AssertionResult {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

export async function getAssertion(options: AssertionOptions): Promise<AssertionResult> {
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: toBuffer(options.challenge),
    rpId: options.rpId,
    allowCredentials: options.allowCredentials?.map((c) => ({
      type: 'public-key' as const,
      id: toBuffer(c.id),
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
    userVerification: options.userVerification ?? 'preferred',
    timeout: options.timeout,
  };
  const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!credential) throw new Error('Passkey assertion was cancelled.');
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    // credential.id is already the unpadded base64url the server stored.
    credentialId: credential.id,
    authenticatorData: bytesToBase64url(new Uint8Array(response.authenticatorData)),
    clientDataJSON: bytesToBase64url(new Uint8Array(response.clientDataJSON)),
    signature: bytesToBase64url(new Uint8Array(response.signature)),
  };
}
