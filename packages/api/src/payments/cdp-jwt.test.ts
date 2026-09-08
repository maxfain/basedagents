/**
 * CDP EdDSA JWT (spec §11 "JWT"): exact header/claims, signature verifies with
 * the public half, exp-iat=120, nbf=iat, uris binding; 63-byte / mismatched /
 * PEM secrets throw CdpKeyFormatError.
 */
import { describe, it, expect } from 'vitest';
import { getPublicKey, utils, verifyAsync, etc } from '@noble/ed25519';
import { cdpJwt, parseEd25519Secret, CdpKeyFormatError, CDP_JWT_TTL_SECONDS } from './cdp-jwt.js';
import { base64ToBytes, bytesToBase64, base64urlEncode } from './x402.js';

const utf8 = new TextEncoder();
const dec = new TextDecoder();

function makeSecret(): { secret: string; seed: Uint8Array; pub: Uint8Array } {
  const seed = utils.randomPrivateKey();
  const pub = getPublicKey(seed);
  return { secret: bytesToBase64(etc.concatBytes(seed, pub)), seed, pub };
}

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(dec.decode(base64ToBytes(part)));
}

describe('parseEd25519Secret', () => {
  it('returns seed and public key for a 64-byte base64 secret (either alphabet)', () => {
    const { secret, seed, pub } = makeSecret();
    const parsed = parseEd25519Secret(secret);
    expect(Array.from(parsed.seed)).toEqual(Array.from(seed));
    expect(Array.from(parsed.pub)).toEqual(Array.from(pub));
    const urlSafe = base64urlEncode(etc.concatBytes(seed, pub));
    expect(Array.from(parseEd25519Secret(` ${urlSafe}\n`).pub)).toEqual(Array.from(pub));
  });

  it('throws CdpKeyFormatError on 63/65-byte, mismatched-public, PEM, junk and empty secrets', () => {
    const { seed, pub } = makeSecret();
    const sixtyThree = bytesToBase64(etc.concatBytes(seed, pub).slice(0, 63));
    expect(() => parseEd25519Secret(sixtyThree)).toThrow(CdpKeyFormatError);
    expect(() => parseEd25519Secret(sixtyThree)).toThrow(/64 bytes.*got 63/);
    const sixtyFive = bytesToBase64(etc.concatBytes(seed, pub, new Uint8Array([1])));
    expect(() => parseEd25519Secret(sixtyFive)).toThrow(/got 65/);

    const otherPub = getPublicKey(utils.randomPrivateKey());
    const mismatched = bytesToBase64(etc.concatBytes(seed, otherPub));
    expect(() => parseEd25519Secret(mismatched)).toThrow(CdpKeyFormatError);
    expect(() => parseEd25519Secret(mismatched)).toThrow(/public half does not match/);

    const pem = '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIA==\n-----END EC PRIVATE KEY-----\n';
    expect(() => parseEd25519Secret(pem)).toThrow(CdpKeyFormatError);
    expect(() => parseEd25519Secret(pem)).toThrow(/PEM/);

    expect(() => parseEd25519Secret('not base64 !!')).toThrow(/not valid base64/);
    expect(() => parseEd25519Secret('')).toThrow(/empty/);
    expect(() => parseEd25519Secret(undefined as never)).toThrow(CdpKeyFormatError);
  });
});

describe('cdpJwt', () => {
  const NOW = 1_800_000_000;

  it('emits the exact CDP header and claims and a signature that verifies with the public half', async () => {
    const { secret, pub } = makeSecret();
    const jwt = await cdpJwt({
      keyId: 'org/abc/apiKeys/123',
      secret,
      method: 'POST',
      host: 'api.cdp.coinbase.com',
      path: '/platform/v2/x402/verify',
      nowSec: NOW,
    });
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(p).toMatch(/^[A-Za-z0-9_-]+$/);

    const header = decodePart(parts[0]);
    expect(header).toEqual({
      alg: 'EdDSA',
      kid: 'org/abc/apiKeys/123',
      typ: 'JWT',
      nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    const claims = decodePart(parts[1]);
    expect(claims).toEqual({
      sub: 'org/abc/apiKeys/123',
      iss: 'cdp',
      iat: NOW,
      nbf: NOW,
      exp: NOW + CDP_JWT_TTL_SECONDS,
      uris: ['POST api.cdp.coinbase.com/platform/v2/x402/verify'],
    });
    expect((claims.exp as number) - (claims.iat as number)).toBe(120);

    const signingInput = utf8.encode(`${parts[0]}.${parts[1]}`);
    expect(await verifyAsync(base64ToBytes(parts[2]), signingInput, pub)).toBe(true);

    // tampering with the claims breaks the signature
    const tampered = { ...claims, sub: 'someone-else' };
    const tamperedInput = utf8.encode(`${parts[0]}.${base64urlEncode(utf8.encode(JSON.stringify(tampered)))}`);
    expect(await verifyAsync(base64ToBytes(parts[2]), tamperedInput, pub)).toBe(false);
    // and a different key does not verify it
    const { pub: otherPub } = makeSecret();
    expect(await verifyAsync(base64ToBytes(parts[2]), signingInput, otherPub)).toBe(false);
  });

  it('binds method+host+path into uris and uses a fresh nonce per token', async () => {
    const { secret } = makeSecret();
    const a = await cdpJwt({ keyId: 'k', secret, method: 'GET', host: 'staging.example.com:8443', path: '/x402/supported', nowSec: NOW });
    const b = await cdpJwt({ keyId: 'k', secret, method: 'GET', host: 'staging.example.com:8443', path: '/x402/supported', nowSec: NOW });
    expect(decodePart(a.split('.')[1]).uris).toEqual(['GET staging.example.com:8443/x402/supported']);
    expect(decodePart(a.split('.')[0]).nonce).not.toBe(decodePart(b.split('.')[0]).nonce);
    expect(a).not.toBe(b);
  });

  it('defaults iat to now (whole seconds)', async () => {
    const { secret } = makeSecret();
    const before = Math.floor(Date.now() / 1000);
    const jwt = await cdpJwt({ keyId: 'k', secret, method: 'POST', host: 'h', path: '/p' });
    const after = Math.floor(Date.now() / 1000);
    const claims = decodePart(jwt.split('.')[1]);
    expect(Number.isInteger(claims.iat)).toBe(true);
    expect(claims.iat as number).toBeGreaterThanOrEqual(before);
    expect(claims.iat as number).toBeLessThanOrEqual(after);
    expect(claims.nbf).toBe(claims.iat);
    expect(claims.exp).toBe((claims.iat as number) + 120);
  });

  it('rejects a malformed secret or empty key id', async () => {
    await expect(cdpJwt({ keyId: 'k', secret: 'AAAA', method: 'POST', host: 'h', path: '/p' })).rejects.toThrow(CdpKeyFormatError);
    const { secret } = makeSecret();
    await expect(cdpJwt({ keyId: '', secret, method: 'POST', host: 'h', path: '/p' })).rejects.toThrow(CdpKeyFormatError);
  });
});
