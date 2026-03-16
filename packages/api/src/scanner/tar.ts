/**
 * Minimal POSIX tar parser for Cloudflare Workers.
 * Works with ReadableStream<Uint8Array> — no fs, no Node.js.
 *
 * Format: each entry = 512-byte header + ceil(size/512)*512 bytes of data.
 * Two consecutive zero-filled 512-byte blocks signal end of archive.
 */

export interface TarEntry {
  name: string;
  size: number;
  type: 'file' | 'directory' | 'other';
  content: Uint8Array;
}

const BLOCK = 512;

/** Read a null-terminated ASCII string from a Uint8Array slice. */
function readString(buf: Uint8Array, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && buf[end] !== 0) end++;
  return new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(offset, end));
}

/** Parse an octal string to a number. */
function parseOctal(buf: Uint8Array, offset: number, length: number): number {
  const s = readString(buf, offset, length).trim();
  if (!s) return 0;
  return parseInt(s, 8) || 0;
}

/** Check if a 512-byte block is all zeros (end-of-archive marker). */
function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < BLOCK; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

/**
 * Accumulate a ReadableStream into a single Uint8Array.
 * Throws if data exceeds maxBytes.
 */
async function readAll(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw new Error(`TARBALL_TOO_LARGE:${maxBytes}`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  // Concatenate
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Parse a tar archive from a ReadableStream.
 * Yields TarEntry objects one at a time (lazy generator).
 *
 * @param stream - Decompressed (plain tar) ReadableStream
 * @param maxBytes - Max total bytes to read before throwing
 */
export async function* parseTar(
  stream: ReadableStream<Uint8Array>,
  maxBytes = 50 * 1024 * 1024,
): AsyncGenerator<TarEntry> {
  const buf = await readAll(stream, maxBytes);

  let pos = 0;
  let zeroBlocks = 0;

  while (pos + BLOCK <= buf.length) {
    const header = buf.slice(pos, pos + BLOCK);
    pos += BLOCK;

    if (isZeroBlock(header)) {
      zeroBlocks++;
      if (zeroBlocks >= 2) break; // end of archive
      continue;
    }
    zeroBlocks = 0;

    // Header fields (POSIX ustar)
    const name      = readString(header, 0,   100);
    const size      = parseOctal(header, 124,  12);
    const typeFlag  = String.fromCharCode(header[156]);

    // ustar prefix (offset 345, length 155) for long names
    const prefix = readString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;

    // HIGH-2: Sanitize path traversal
    const sanitized = fullName.replace(/\.\.\//g, '').replace(/^\/+/, '');
    if (sanitized.includes('..') || sanitized.startsWith('/')) continue; // skip dangerous entry

    // Classify type
    let type: TarEntry['type'];
    if (typeFlag === '0' || typeFlag === '\0') type = 'file';
    else if (typeFlag === '5') type = 'directory';
    else type = 'other';

    // Read data blocks (ceil(size/512)*512 bytes)
    const dataBlocks = Math.ceil(size / BLOCK) * BLOCK;
    const content = buf.slice(pos, pos + size);
    pos += dataBlocks;

    if (pos > buf.length + BLOCK) break; // corrupt archive guard

    yield {
      name: sanitized,
      size,
      type,
      content,
    };
  }
}
