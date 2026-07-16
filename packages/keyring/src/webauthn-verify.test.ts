import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { verifyOwnerAssertion } from './webauthn-verify.js';
import { base64urlEncode } from './control-actions.js';

const RP_ID = 'basedagents.ai';
const ORIGIN = 'https://app.basedagents.ai';
const subtle = globalThis.crypto.subtle;

/** Convert a WebCrypto raw (r‖s) ECDSA signature to ASN.1 DER. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const enc = (b: Uint8Array): number[] => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = Array.from(b.slice(i));
    if (v[0] & 0x80) v.unshift(0);
    return [0x02, v.length, ...v];
  };
  const body = [...enc(raw.slice(0, 32)), ...enc(raw.slice(32, 64))];
  return new Uint8Array([0x30, body.length, ...body]);
}

interface Authenticator {
  publicKeyHex: string;
  sign(challenge: string, opts?: { rpId?: string; origin?: string; up?: boolean; counter?: number }): Promise<{
    authenticatorData: string; clientDataJSON: string; signature: string;
  }>;
}

async function makeAuthenticator(): Promise<Authenticator> {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey)); // 0x04‖x‖y
  return {
    publicKeyHex: bytesToHex(raw),
    async sign(challenge, opts = {}) {
      const rpId = opts.rpId ?? RP_ID;
      const origin = opts.origin ?? ORIGIN;
      const flags = opts.up === false ? 0x00 : 0x05; // UP|UV
      const counter = opts.counter ?? 0;
      const authData = new Uint8Array([
        ...sha256(new TextEncoder().encode(rpId)), flags,
        (counter >>> 24) & 0xff, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff,
      ]);
      const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
      const message = new Uint8Array([...authData, ...sha256(clientDataJSON)]);
      const rawSig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, message));
      return {
        authenticatorData: base64urlEncode(authData),
        clientDataJSON: base64urlEncode(clientDataJSON),
        signature: base64urlEncode(rawToDer(rawSig)),
      };
    },
  };
}

describe('verifyOwnerAssertion (ES256, daemon-side)', () => {
  const challenge = base64urlEncode(sha256(new TextEncoder().encode('some-action')));

  it('accepts a valid assertion', async () => {
    const auth = await makeAuthenticator();
    const a = await auth.sign(challenge);
    expect(() =>
      verifyOwnerAssertion({
        publicKeyHex: auth.publicKeyHex, ...a,
        expectedChallenge: challenge, expectedOrigins: [ORIGIN], expectedRPID: RP_ID,
      }),
    ).not.toThrow();
  });

  it('rejects a wrong challenge (WYSIWYS)', async () => {
    const auth = await makeAuthenticator();
    const a = await auth.sign(challenge);
    const other = base64urlEncode(sha256(new TextEncoder().encode('other-action')));
    expect(() => verifyOwnerAssertion({ publicKeyHex: auth.publicKeyHex, ...a, expectedChallenge: other, expectedOrigins: [ORIGIN], expectedRPID: RP_ID }))
      .toThrow(/does not match the expected action hash/);
  });

  it('rejects a wrong origin', async () => {
    const auth = await makeAuthenticator();
    const a = await auth.sign(challenge, { origin: 'https://evil.example' });
    expect(() => verifyOwnerAssertion({ publicKeyHex: auth.publicKeyHex, ...a, expectedChallenge: challenge, expectedOrigins: [ORIGIN], expectedRPID: RP_ID }))
      .toThrow(/origin/);
  });

  it('rejects a wrong RP ID', async () => {
    const auth = await makeAuthenticator();
    const a = await auth.sign(challenge, { rpId: 'evil.example' });
    expect(() => verifyOwnerAssertion({ publicKeyHex: auth.publicKeyHex, ...a, expectedChallenge: challenge, expectedOrigins: [ORIGIN], expectedRPID: RP_ID }))
      .toThrow(/rpIdHash/);
  });

  it('rejects an absent User-Present flag', async () => {
    const auth = await makeAuthenticator();
    const a = await auth.sign(challenge, { up: false });
    expect(() => verifyOwnerAssertion({ publicKeyHex: auth.publicKeyHex, ...a, expectedChallenge: challenge, expectedOrigins: [ORIGIN], expectedRPID: RP_ID }))
      .toThrow(/User-Present/);
  });

  it('rejects a tampered signature', async () => {
    const auth = await makeAuthenticator();
    const a = await auth.sign(challenge);
    const bad = { ...a, signature: a.signature.slice(0, -4) + (a.signature.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA') };
    expect(() => verifyOwnerAssertion({ publicKeyHex: auth.publicKeyHex, ...bad, expectedChallenge: challenge, expectedOrigins: [ORIGIN], expectedRPID: RP_ID }))
      .toThrow();
  });

  it('rejects a different key', async () => {
    const auth = await makeAuthenticator();
    const other = await makeAuthenticator();
    const a = await auth.sign(challenge);
    expect(() => verifyOwnerAssertion({ publicKeyHex: other.publicKeyHex, ...a, expectedChallenge: challenge, expectedOrigins: [ORIGIN], expectedRPID: RP_ID }))
      .toThrow(/signature verification failed/);
  });
});
