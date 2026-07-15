/**
 * Tests for the control-plane WebAuthn verification core.
 *
 * Strategy: we generate a real P-256 (ES256) keypair with Web Crypto, hand-build
 * the exact byte structures a WebAuthn authenticator emits (COSE public key,
 * authenticatorData, clientDataJSON, an ASN.1-DER ECDSA signature, and a fmt
 * 'none' attestationObject), and assert the verifier ACCEPTS valid material and
 * THROWS on every tampering (bad challenge / origin / rpId / signature / absent
 * User-Present flag). CBOR is produced with the same encoder the verifier
 * decodes with, so registration round-trips exactly.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { sha256 } from '../crypto/index.js';
import {
  actionChallenge,
  base64urlEncode,
  base64urlDecode,
  verifyRegistration,
  verifyAssertion,
} from './webauthn.js';

const te = new TextEncoder();
const RP_ID = 'basedagents.ai';
const ORIGIN = 'https://app.basedagents.ai';
const ORIGINS = [ORIGIN, 'http://localhost:5173'];

// ─── byte helpers ───

// CBOR value type the library's encoder accepts.
type CborType = Parameters<typeof isoCBOR.encode>[0];

function concat(...arrs: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

function u32be(n: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/** raw ECDSA r||s (64 bytes) → ASN.1 DER, as WebAuthn authenticators emit. */
function rawToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const encInt = (v: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    let b = v.slice(i);
    if (b[0] & 0x80) b = concat(new Uint8Array([0]), b);
    return concat(new Uint8Array([0x02, b.length]), b);
  };
  const body = concat(encInt(raw.slice(0, 32)), encInt(raw.slice(32, 64)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

// ─── credential factory ───

interface Credential {
  privateKey: CryptoKey;
  cose: Uint8Array; // COSE ES256 public key
  credentialId: string; // base64url
}

async function makeCredential(): Promise<Credential> {
  const kp = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', kp.publicKey);
  const x = base64urlDecode(jwk.x!);
  const y = base64urlDecode(jwk.y!);
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, x],
      [-3, y],
    ]) as CborType,
  );
  const rawId = new Uint8Array(16);
  globalThis.crypto.getRandomValues(rawId);
  return { privateKey: kp.privateKey, cose, credentialId: base64urlEncode(rawId) };
}

async function signDer(privateKey: CryptoKey, message: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const raw = new Uint8Array(
    await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, message),
  );
  return rawToDer(raw);
}

// ─── assertion vector builder ───

interface AssertionInput {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
  cosePublicKey: Uint8Array;
  expectedChallenge: string;
  expectedOrigin: string[];
  expectedRPID: string;
}

async function buildAssertion(
  cred: Credential,
  opts: {
    challenge: string;
    origin?: string;
    rpId?: string;
    flags?: number; // default UP|UV
    counter?: number;
  },
): Promise<AssertionInput> {
  const rpId = opts.rpId ?? RP_ID;
  const origin = opts.origin ?? ORIGIN;
  const flags = opts.flags ?? 0x05; // UP | UV
  const counter = opts.counter ?? 1;

  const rpIdHash = sha256(te.encode(rpId));
  const authData = concat(rpIdHash, new Uint8Array([flags]), u32be(counter));

  const clientDataJSON = JSON.stringify({
    type: 'webauthn.get',
    challenge: opts.challenge,
    origin,
    crossOrigin: false,
  });
  const cdjBytes = te.encode(clientDataJSON);
  const signBase = concat(authData, sha256(cdjBytes));
  const der = await signDer(cred.privateKey, signBase);

  return {
    credentialId: cred.credentialId,
    authenticatorData: base64urlEncode(authData),
    clientDataJSON: base64urlEncode(cdjBytes),
    signature: base64urlEncode(der),
    cosePublicKey: cred.cose,
    expectedChallenge: opts.challenge,
    expectedOrigin: ORIGINS,
    expectedRPID: RP_ID,
  };
}

// ─── registration vector builder (fmt 'none') ───

interface RegistrationInput {
  attestationObject: string;
  clientDataJSON: string;
  expectedChallenge: string;
  expectedOrigin: string[];
  expectedRPID: string;
}

function buildRegistration(
  cred: Credential,
  opts: { challenge: string; origin?: string; rpId?: string; flags?: number },
): RegistrationInput {
  const rpId = opts.rpId ?? RP_ID;
  const origin = opts.origin ?? ORIGIN;
  const flags = opts.flags ?? 0x5d; // UP | UV | BE | BS | AT (attested cred data present)

  const rpIdHash = sha256(te.encode(rpId));
  const aaguid = new Uint8Array(16); // all-zero AAGUID
  const credIdBytes = base64urlDecode(cred.credentialId);
  const credIdLen = new Uint8Array([(credIdBytes.length >> 8) & 0xff, credIdBytes.length & 0xff]);
  const attestedCredData = concat(aaguid, credIdLen, credIdBytes, cred.cose);
  const authData = concat(rpIdHash, new Uint8Array([flags]), u32be(0), attestedCredData);

  const attestationObject = isoCBOR.encode(
    new Map<string, CborType>([
      ['fmt', 'none'],
      ['attStmt', new Map<string, CborType>()],
      ['authData', authData],
    ]) as CborType,
  );

  const clientDataJSON = JSON.stringify({
    type: 'webauthn.create',
    challenge: opts.challenge,
    origin,
    crossOrigin: false,
  });

  return {
    attestationObject: base64urlEncode(attestationObject),
    clientDataJSON: base64urlEncode(te.encode(clientDataJSON)),
    expectedChallenge: opts.challenge,
    expectedOrigin: ORIGINS,
    expectedRPID: RP_ID,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('actionChallenge', () => {
  const action = JSON.stringify({
    type: 'approve_grant',
    grantee_pubkey: 'ag_abc123',
    credential_id: 'cred_xyz',
    ts: 1_752_500_000,
  });

  it('is deterministic', () => {
    expect(actionChallenge(action)).toBe(actionChallenge(action));
  });

  it('equals base64url(sha256(canonicalAction))', () => {
    const expected = base64urlEncode(sha256(new TextEncoder().encode(action)));
    expect(actionChallenge(action)).toBe(expected);
  });

  it('is unpadded base64url (challenge/action_hash binding)', () => {
    const c = actionChallenge(action);
    expect(c).not.toContain('=');
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    // sha256 is 32 bytes → 43 unpadded base64url chars
    expect(c).toHaveLength(43);
  });

  it('changes when the action changes (pins the exact action)', () => {
    const other = JSON.stringify({
      type: 'approve_grant',
      grantee_pubkey: 'ag_DIFFERENT',
      credential_id: 'cred_xyz',
      ts: 1_752_500_000,
    });
    expect(actionChallenge(other)).not.toBe(actionChallenge(action));
  });
});

describe('base64url helpers', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 42]);
    expect(base64urlDecode(base64urlEncode(bytes))).toEqual(bytes);
  });

  it('produces url-safe, unpadded output', () => {
    const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xfe]);
    const s = base64urlEncode(bytes);
    expect(s).not.toMatch(/[+/=]/);
  });
});

describe('verifyAssertion', () => {
  let cred: Credential;
  const challenge = actionChallenge(JSON.stringify({ type: 'kill_switch', agent: 'ag_x' }));

  beforeAll(async () => {
    cred = await makeCredential();
  });

  it('accepts a valid assertion and returns User Present', async () => {
    const input = await buildAssertion(cred, { challenge });
    const res = await verifyAssertion(input);
    expect(res.userPresent).toBe(true);
  });

  it('returns the assertion counter unchanged (caller enforces monotonicity)', async () => {
    const input = await buildAssertion(cred, { challenge, counter: 42 });
    const res = await verifyAssertion(input);
    expect(res.newCounter).toBe(42);
  });

  it('throws on a wrong expected challenge', async () => {
    const input = await buildAssertion(cred, { challenge });
    await expect(
      verifyAssertion({ ...input, expectedChallenge: actionChallenge('a different action') }),
    ).rejects.toThrow();
  });

  it('throws on a wrong origin', async () => {
    const input = await buildAssertion(cred, { challenge, origin: 'https://evil.example.com' });
    await expect(verifyAssertion(input)).rejects.toThrow();
  });

  it('throws on a wrong RP ID (rpIdHash mismatch)', async () => {
    const input = await buildAssertion(cred, { challenge, rpId: 'evil.ai' });
    await expect(verifyAssertion(input)).rejects.toThrow();
  });

  it('throws on a tampered signature', async () => {
    const input = await buildAssertion(cred, { challenge });
    const sig = base64urlDecode(input.signature);
    sig[sig.length - 1] ^= 0x01; // flip LSB of s — valid DER, wrong signature
    await expect(
      verifyAssertion({ ...input, signature: base64urlEncode(sig) }),
    ).rejects.toThrow();
  });

  it('throws when the User-Present flag is absent', async () => {
    const input = await buildAssertion(cred, { challenge, flags: 0x04 }); // UV set, UP clear
    await expect(verifyAssertion(input)).rejects.toThrow();
  });

  it('throws when verifying with the wrong public key', async () => {
    const input = await buildAssertion(cred, { challenge });
    const other = await makeCredential();
    await expect(
      verifyAssertion({ ...input, cosePublicKey: other.cose }),
    ).rejects.toThrow();
  });
});

describe('verifyRegistration', () => {
  let cred: Credential;
  const challenge = actionChallenge('register-owner-passkey');

  beforeAll(async () => {
    cred = await makeCredential();
  });

  it('accepts a valid fmt=none registration and extracts the COSE key', async () => {
    const input = buildRegistration(cred, { challenge });
    const res = await verifyRegistration(input);
    expect(res.credentialId).toBe(cred.credentialId);
    expect(res.cosePublicKey).toEqual(cred.cose);
    expect(res.counter).toBe(0);
    expect(res.backedUp).toBe(true);
    expect(res.aaguid).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('reports backedUp=false when the BS flag is clear', async () => {
    // UP | UV | AT, no BE/BS
    const input = buildRegistration(cred, { challenge, flags: 0x45 });
    const res = await verifyRegistration(input);
    expect(res.backedUp).toBe(false);
  });

  it('throws on a wrong expected challenge', async () => {
    const input = buildRegistration(cred, { challenge });
    await expect(
      verifyRegistration({ ...input, expectedChallenge: actionChallenge('nope') }),
    ).rejects.toThrow();
  });

  it('throws on a wrong origin', async () => {
    const input = buildRegistration(cred, { challenge, origin: 'https://evil.example.com' });
    await expect(verifyRegistration(input)).rejects.toThrow();
  });

  it('throws on a wrong RP ID', async () => {
    const input = buildRegistration(cred, { challenge, rpId: 'evil.ai' });
    await expect(verifyRegistration(input)).rejects.toThrow();
  });

  it('round-trips: the extracted COSE key verifies a later assertion', async () => {
    const reg = await verifyRegistration(buildRegistration(cred, { challenge }));
    const actionChal = actionChallenge(JSON.stringify({ type: 'approve_grant', to: 'ag_z' }));
    const assertion = await buildAssertion(cred, { challenge: actionChal, counter: 5 });
    // use the stored key from registration, not the in-memory one
    const res = await verifyAssertion({ ...assertion, cosePublicKey: reg.cosePublicKey });
    expect(res.newCounter).toBe(5);
    expect(res.userPresent).toBe(true);
  });
});
