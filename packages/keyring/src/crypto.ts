/**
 * Keyring crypto — sealed boxes over BasedAgents Ed25519 identities.
 *
 * Core invariant (KEYRING_SPEC §3): secrets are encrypted client-side to the
 * owner's key and to the public keys of granted identities. The store only
 * ever holds ciphertext.
 *
 * Sealed-box construction (versioned, v1):
 *   recipient X25519 pub  = edwardsToMontgomeryPub(ed25519 pub)
 *   ephemeral keypair     = fresh X25519 pair per encryption
 *   shared                = x25519(ephemeral priv, recipient X25519 pub)
 *   key                   = HKDF-SHA256(shared, salt = ephPub ‖ recipPub, info = "basedagents-keyring/v1/sealed-box", 32)
 *   box                   = 0x01 ‖ ephPub(32) ‖ nonce(24) ‖ XChaCha20-Poly1305(key, nonce, plaintext)
 */

import * as ed from '@noble/ed25519';
import { x25519, edwardsToMontgomeryPub, edwardsToMontgomeryPriv } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';
import { bytesToBase64, base64ToBytes } from './util.js';

const SEALED_BOX_VERSION = 0x01;
const HKDF_INFO = 'basedagents-keyring/v1/sealed-box';
const EPH_PUB_LENGTH = 32;
const NONCE_LENGTH = 24;
const TAG_LENGTH = 16;

export interface AgentKeypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** Generate a new Ed25519 keypair (same identity scheme as the registry). */
export async function generateKeypair(): Promise<AgentKeypair> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { publicKey, privateKey };
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

function deriveKey(shared: Uint8Array, ephPub: Uint8Array, recipPub: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, concatBytes(ephPub, recipPub), HKDF_INFO, 32);
}

/**
 * Seal a plaintext to a recipient's Ed25519 public key.
 * Anyone can seal; only the holder of the matching private key can open.
 * Returns base64 (the storage encoding used in the vault file).
 */
export function sealToPublicKey(recipientEdPublicKey: Uint8Array, plaintext: Uint8Array): string {
  if (recipientEdPublicKey.length !== 32) throw new Error('Recipient public key must be 32 bytes');
  const recipX = edwardsToMontgomeryPub(recipientEdPublicKey);
  const ephPriv = x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(ephPriv);
  const shared = x25519.getSharedSecret(ephPriv, recipX);
  const key = deriveKey(shared, ephPub, recipX);
  const nonce = randomBytes(NONCE_LENGTH);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(plaintext);
  return bytesToBase64(concatBytes(Uint8Array.of(SEALED_BOX_VERSION), ephPub, nonce, ciphertext));
}

/**
 * Open a sealed box with the recipient's Ed25519 private key.
 * Throws on version mismatch, truncation, or authentication failure.
 */
export function openSealedBox(recipientEdPrivateKey: Uint8Array, sealedB64: string): Uint8Array {
  const box = base64ToBytes(sealedB64);
  const minLength = 1 + EPH_PUB_LENGTH + NONCE_LENGTH + TAG_LENGTH;
  if (box.length < minLength) throw new Error('Sealed box too short');
  if (box[0] !== SEALED_BOX_VERSION) throw new Error(`Unsupported sealed box version: ${box[0]}`);
  const ephPub = box.slice(1, 1 + EPH_PUB_LENGTH);
  const nonce = box.slice(1 + EPH_PUB_LENGTH, 1 + EPH_PUB_LENGTH + NONCE_LENGTH);
  const ciphertext = box.slice(1 + EPH_PUB_LENGTH + NONCE_LENGTH);

  const xPriv = edwardsToMontgomeryPriv(recipientEdPrivateKey);
  const xPub = x25519.getPublicKey(xPriv);
  const shared = x25519.getSharedSecret(xPriv, ephPub);
  const key = deriveKey(shared, ephPub, xPub);
  return xchacha20poly1305(key, nonce).decrypt(ciphertext);
}

// ─── Signing ───

/** Sign a canonical payload string with an Ed25519 private key. Returns base64. */
export async function signPayload(privateKey: Uint8Array, payload: string): Promise<string> {
  const sig = await ed.signAsync(new TextEncoder().encode(payload), privateKey);
  return bytesToBase64(sig);
}

/** Verify a base64 Ed25519 signature over a canonical payload string. */
export async function verifyPayload(publicKey: Uint8Array, payload: string, signatureB64: string): Promise<boolean> {
  try {
    const sig = base64ToBytes(signatureB64);
    return await ed.verifyAsync(sig, new TextEncoder().encode(payload), publicKey);
  } catch {
    return false;
  }
}
