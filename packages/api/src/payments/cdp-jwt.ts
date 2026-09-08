/**
 * CDP API bearer JWT — EdDSA (Ed25519) only, hand-rolled on @noble/ed25519 (D9).
 *
 * Mirrors what `@coinbase/cdp-sdk`'s `generateJwt` emits for an Edwards key
 * (see scratchpad x402/cdpsdk-auth-jwt.ts): header
 * `{alg:'EdDSA', kid, typ:'JWT', nonce}` and claims
 * `{sub, iss:'cdp', iat, nbf:iat, exp:iat+120, uris:['<METHOD> <host><path>']}`.
 * The SDK needs jose/Buffer/process, none of which are Workers-clean; this is
 * ~60 lines and pinned by cdp-jwt.test.ts (signature verifies with the public half).
 *
 * Secrets: CDP hands out Ed25519 keys as base64 of 64 bytes = seed(32) ‖ pub(32).
 * EC PEM keys (ES256) are NOT supported — `parseEd25519Secret` throws
 * `CdpKeyFormatError` and the factory fails closed with one log line.
 */

import { etc, getPublicKey, signAsync } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { base64ToBytes, base64urlEncode } from './x402.js';

// @noble/ed25519's sync API (`getPublicKey`) needs a synchronous SHA-512; the
// async API uses WebCrypto's `subtle.digest`. Wire the sync hash from
// @noble/hashes (already a dependency) once per isolate so key validation can
// stay synchronous. vitest.setup.ts does the same for tests; keep whichever
// was set first.
if (!etc.sha512Sync) {
  etc.sha512Sync = (...m: Uint8Array[]) => sha512(etc.concatBytes(...m));
}

/** CDP token lifetime in seconds (what the official SDK uses). */
export const CDP_JWT_TTL_SECONDS = 120;

export class CdpKeyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CdpKeyFormatError';
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Parse a CDP Ed25519 secret (base64, 64 bytes: seed ‖ public key).
 * The embedded public key must equal `getPublicKey(seed)`; a mismatch means
 * the secret was corrupted or is not an Ed25519 key at all.
 */
export function parseEd25519Secret(b64: string): { seed: Uint8Array; pub: Uint8Array } {
  if (typeof b64 !== 'string' || b64.trim().length === 0) {
    throw new CdpKeyFormatError('CDP_API_KEY_SECRET is empty');
  }
  const trimmed = b64.trim();
  if (trimmed.startsWith('-----BEGIN')) {
    throw new CdpKeyFormatError(
      'CDP_API_KEY_SECRET is a PEM (EC) key; only base64 Ed25519 keys are supported — create an Ed25519 API key in the CDP portal',
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(trimmed);
  } catch {
    throw new CdpKeyFormatError('CDP_API_KEY_SECRET is not valid base64');
  }
  if (bytes.length !== 64) {
    throw new CdpKeyFormatError(
      `CDP_API_KEY_SECRET must decode to 64 bytes (Ed25519 seed + public key); got ${bytes.length}`,
    );
  }
  const seed = bytes.slice(0, 32);
  const pub = bytes.slice(32, 64);
  const derived = getPublicKey(seed);
  if (!bytesEqual(derived, pub)) {
    throw new CdpKeyFormatError('CDP_API_KEY_SECRET public half does not match its seed; not an Ed25519 key');
  }
  return { seed, pub };
}

export interface CdpJwtOptions {
  keyId: string;
  /** base64 64-byte Ed25519 secret (seed ‖ pub). */
  secret: string;
  method: 'POST' | 'GET';
  /** e.g. `api.cdp.coinbase.com` (host, incl. port if non-default). */
  host: string;
  /** e.g. `/platform/v2/x402/verify`. */
  path: string;
  /** Unix seconds; defaults to now. Injected by tests. */
  nowSec?: number;
}

const utf8 = new TextEncoder();

function randomNonceHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return etc.bytesToHex(bytes);
}

/**
 * Mint a compact JWS for one CDP request:
 * `base64url(header).base64url(claims).base64url(Ed25519(signingInput))`.
 */
export async function cdpJwt(opts: CdpJwtOptions): Promise<string> {
  if (!opts.keyId) throw new CdpKeyFormatError('CDP_API_KEY_ID is empty');
  const { seed } = parseEd25519Secret(opts.secret);
  const iat = Math.floor(opts.nowSec ?? Date.now() / 1000);
  const header = { alg: 'EdDSA', kid: opts.keyId, typ: 'JWT', nonce: randomNonceHex() };
  const claims = {
    sub: opts.keyId,
    iss: 'cdp',
    iat,
    nbf: iat,
    exp: iat + CDP_JWT_TTL_SECONDS,
    uris: [`${opts.method} ${opts.host}${opts.path}`],
  };
  const signingInput =
    base64urlEncode(utf8.encode(JSON.stringify(header))) +
    '.' +
    base64urlEncode(utf8.encode(JSON.stringify(claims)));
  const signature = await signAsync(utf8.encode(signingInput), seed);
  return `${signingInput}.${base64urlEncode(signature)}`;
}
