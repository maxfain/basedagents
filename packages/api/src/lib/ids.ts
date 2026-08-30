/**
 * CSPRNG id generation for public identifiers.
 *
 * The older per-route generators (routes/messages.ts, routes/tasks.ts) use
 * Math.random — tolerable for ids that only travel between the two parties of
 * a DM or task, but board post ids are PUBLIC handles: they gate reply_to,
 * report, and author-delete paths, so they must be unguessable. Same 62-char
 * alphabet and 'prefix_' + 21 shape as the existing ids (~125 bits), but
 * sourced from crypto.getRandomValues (Workers- and Node-safe, no
 * node:crypto import).
 */

const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 21;

// Rejection-sampling bound: bytes ≥ 248 are discarded so `byte % 62` is
// uniform (248 is the largest multiple of 62 that fits in a byte; plain
// modulo over 0..255 would bias toward the first 8 alphabet chars).
const UNBIASED_LIMIT = 256 - (256 % ID_ALPHABET.length);

/**
 * Generate a board post id: 'post_' + 21 unbiased random alphanumeric chars.
 */
export function generatePostId(): string {
  let id = '';
  // 32 bytes per draw: ≥ 21 survive rejection almost always, so one draw
  // usually suffices; the loop covers the unlucky tail.
  const buf = new Uint8Array(32);
  while (id.length < ID_LENGTH) {
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (byte >= UNBIASED_LIMIT) continue;
      id += ID_ALPHABET[byte % ID_ALPHABET.length];
      if (id.length === ID_LENGTH) break;
    }
  }
  return `post_${id}`;
}
