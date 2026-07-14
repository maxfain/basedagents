import { describe, it, expect } from 'vitest';
import {
  generateKeypair,
  sealToPublicKey,
  openSealedBox,
  signPayload,
  verifyPayload,
} from './crypto.js';
import { base64ToBytes, bytesToBase64 } from './util.js';

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

// ─── Sealed boxes ───

describe('sealToPublicKey / openSealedBox', () => {
  it('round-trips a plaintext sealed to a public key', async () => {
    const kp = await generateKeypair();
    const sealed = sealToPublicKey(kp.publicKey, encode('hunter2'));
    const opened = openSealedBox(kp.privateKey, sealed);
    expect(decode(opened)).toBe('hunter2');
  });

  it('produces base64 output with the v1 version byte', async () => {
    const kp = await generateKeypair();
    const sealed = sealToPublicKey(kp.publicKey, encode('x'));
    const box = base64ToBytes(sealed);
    expect(box[0]).toBe(0x01);
    // version(1) + ephPub(32) + nonce(24) + ciphertext(1) + tag(16)
    expect(box.length).toBe(1 + 32 + 24 + 1 + 16);
  });

  it('seals the same plaintext to different ciphertexts (fresh ephemeral key + nonce)', async () => {
    const kp = await generateKeypair();
    const a = sealToPublicKey(kp.publicKey, encode('same secret'));
    const b = sealToPublicKey(kp.publicKey, encode('same secret'));
    expect(a).not.toBe(b);
  });

  it('cannot be opened with a different keypair', async () => {
    const recipient = await generateKeypair();
    const other = await generateKeypair();
    const sealed = sealToPublicKey(recipient.publicKey, encode('for recipient only'));
    expect(() => openSealedBox(other.privateKey, sealed)).toThrow();
    // The intended recipient still can.
    expect(decode(openSealedBox(recipient.privateKey, sealed))).toBe('for recipient only');
  });

  it('throws if any single byte of the box is tampered with', async () => {
    const kp = await generateKeypair();
    const sealed = sealToPublicKey(kp.publicKey, encode('attack at dawn'));
    const original = base64ToBytes(sealed);
    for (let i = 0; i < original.length; i++) {
      const tampered = Uint8Array.from(original);
      tampered[i] ^= 0x01;
      expect(
        () => openSealedBox(kp.privateKey, bytesToBase64(tampered)),
        `flipping byte ${i} must not decrypt`
      ).toThrow();
    }
  });

  it('rejects an unsupported version byte', async () => {
    const kp = await generateKeypair();
    const box = base64ToBytes(sealToPublicKey(kp.publicKey, encode('v1 only')));
    for (const version of [0x00, 0x02, 0xff]) {
      const mutated = Uint8Array.from(box);
      mutated[0] = version;
      expect(() => openSealedBox(kp.privateKey, bytesToBase64(mutated)))
        .toThrow(/Unsupported sealed box version/);
    }
  });

  it('rejects a truncated box', async () => {
    const kp = await generateKeypair();
    const box = base64ToBytes(sealToPublicKey(kp.publicKey, encode('truncate me')));
    const minLength = 1 + 32 + 24 + 16;
    // Below the structural minimum → explicit length error.
    expect(() => openSealedBox(kp.privateKey, bytesToBase64(box.slice(0, minLength - 1))))
      .toThrow(/too short/);
    expect(() => openSealedBox(kp.privateKey, '')).toThrow(/too short/);
    // Structurally long enough but missing tail bytes → authentication failure.
    expect(() => openSealedBox(kp.privateKey, bytesToBase64(box.slice(0, box.length - 1)))).toThrow();
  });

  it('round-trips an empty plaintext', async () => {
    const kp = await generateKeypair();
    const sealed = sealToPublicKey(kp.publicKey, new Uint8Array(0));
    const opened = openSealedBox(kp.privateKey, sealed);
    expect(opened.length).toBe(0);
  });

  it('round-trips a large (100KB) plaintext', async () => {
    const kp = await generateKeypair();
    const big = new Uint8Array(100 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const sealed = sealToPublicKey(kp.publicKey, big);
    const opened = openSealedBox(kp.privateKey, sealed);
    expect(opened.length).toBe(big.length);
    expect(Buffer.from(opened).equals(Buffer.from(big))).toBe(true);
  });

  it('round-trips a unicode secret', async () => {
    const kp = await generateKeypair();
    const secret = '🔐 clé secrète — 秘密のキー — пароль ≠ ∅';
    const sealed = sealToPublicKey(kp.publicKey, encode(secret));
    expect(decode(openSealedBox(kp.privateKey, sealed))).toBe(secret);
  });

  it('rejects a recipient public key that is not 32 bytes', () => {
    expect(() => sealToPublicKey(new Uint8Array(31), encode('x')))
      .toThrow(/must be 32 bytes/);
  });
});

// ─── Signing ───

describe('signPayload / verifyPayload', () => {
  it('round-trips: a signature verifies with the signer public key', async () => {
    const kp = await generateKeypair();
    const payload = '{"action":"lease","nonce":"nonce_1"}';
    const sig = await signPayload(kp.privateKey, payload);
    expect(await verifyPayload(kp.publicKey, payload, sig)).toBe(true);
  });

  it('fails with a different public key', async () => {
    const kp = await generateKeypair();
    const other = await generateKeypair();
    const payload = 'payload bytes';
    const sig = await signPayload(kp.privateKey, payload);
    expect(await verifyPayload(other.publicKey, payload, sig)).toBe(false);
  });

  it('fails when the payload is tampered with', async () => {
    const kp = await generateKeypair();
    const sig = await signPayload(kp.privateKey, '{"amount":1}');
    expect(await verifyPayload(kp.publicKey, '{"amount":2}', sig)).toBe(false);
  });

  it('returns false (does not throw) for a garbage base64 signature', async () => {
    const kp = await generateKeypair();
    expect(await verifyPayload(kp.publicKey, 'payload', '!!!not base64 at all!!!')).toBe(false);
    expect(await verifyPayload(kp.publicKey, 'payload', '')).toBe(false);
    // Valid base64 but not a 64-byte Ed25519 signature.
    expect(await verifyPayload(kp.publicKey, 'payload', bytesToBase64(new Uint8Array(10)))).toBe(false);
  });

  it('signature is base64 of 64 bytes (Ed25519)', async () => {
    const kp = await generateKeypair();
    const sig = await signPayload(kp.privateKey, 'x');
    expect(base64ToBytes(sig).length).toBe(64);
  });
});
