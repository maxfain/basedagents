/**
 * Browser-compatible Ed25519 signing utilities.
 * Uses @noble/ed25519 and @noble/hashes — no Node.js crypto required.
 */
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex as nobleBytesToHex } from '@noble/hashes/utils';

// @noble/ed25519 v2 requires a synchronous SHA-512 implementation.
// In browsers we use Web Crypto; in environments without it we fall back to a sync shim.
// The library auto-detects the environment, but we explicitly set it for safety.
import { etc } from '@noble/ed25519';
// Provide synchronous SHA-512 using @noble/hashes so the library works in all environments.
import { sha512 } from '@noble/hashes/sha512';
etc.sha512Sync = (...msgs) => {
  const h = sha512.create();
  for (const m of msgs) h.update(m);
  return h.digest();
};

/**
 * Sign a message with an Ed25519 private key.
 * @param privateKeyHex  64-char hex string (32 bytes)
 * @param message        Raw bytes to sign
 * @returns 64-byte signature
 */
export async function signMessage(privateKeyHex: string, message: Uint8Array): Promise<Uint8Array> {
  const privateKey = hexToBytes(privateKeyHex);
  return ed.signAsync(message, privateKey);
}

/**
 * Compute SHA-256 of a UTF-8 string and return the hex digest.
 */
export async function sha256Hex(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data);
  return nobleBytesToHex(sha256(bytes));
}

/**
 * Decode a hex string to a Uint8Array.
 */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Encode a Uint8Array to a standard base64 string.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
