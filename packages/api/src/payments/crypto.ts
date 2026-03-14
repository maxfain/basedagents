/**
 * Payment signature encryption/decryption using AES-256-GCM (Web Crypto API).
 * Works on Cloudflare Workers — no Node.js built-ins.
 *
 * The encryption key is stored as a hex-encoded 32-byte secret in PAYMENT_ENCRYPTION_KEY.
 * Each encryption produces a random 12-byte IV prepended to the ciphertext.
 *
 * Format: base64(iv[12] + ciphertext + tag[16])
 */

/**
 * Import a hex-encoded 256-bit key for AES-GCM.
 */
async function importKey(hexKey: string): Promise<CryptoKey> {
  const keyBytes = new Uint8Array(hexKey.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
  if (keyBytes.length !== 32) {
    throw new Error('PAYMENT_ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  }
  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt a payment signature string using AES-256-GCM.
 * Returns a base64 string: iv (12 bytes) + ciphertext + GCM tag (16 bytes).
 */
export async function encryptPaymentSignature(
  plaintext: string,
  hexKey: string
): Promise<string> {
  const key = await importKey(hexKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );

  // Prepend IV to ciphertext
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  // Base64 encode
  let binary = '';
  for (const b of combined) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

/**
 * Decrypt a payment signature encrypted with encryptPaymentSignature.
 */
export async function decryptPaymentSignature(
  encrypted: string,
  hexKey: string
): Promise<string> {
  const key = await importKey(hexKey);

  // Base64 decode
  const binaryStr = atob(encrypted);
  const combined = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    combined[i] = binaryStr.charCodeAt(i);
  }

  // Extract IV (first 12 bytes) and ciphertext (rest)
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(decrypted);
}
