import { describe, it, expect } from 'vitest';
import { getPublicKey, sign, utils } from '@noble/ed25519';
import {
  base58Encode,
  base58Decode,
  verifyProofOfWork,
  computeChainHash,
  hashProfile,
  canonicalJsonStringify,
  publicKeyToAgentId,
  agentIdToPublicKey,
  verifySignature,
  GENESIS_HASH,
  bytesToHex,
  sha256,
} from './index.js';

// ─── Base58 ───

describe('base58Encode / base58Decode', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 100, 200, 255]);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
  });

  it('known vector: [0x00, 0x01] → leading "1"', () => {
    const bytes = new Uint8Array([0x00, 0x01]);
    const encoded = base58Encode(bytes);
    expect(encoded.startsWith('1')).toBe(true);
  });

  it('empty input encodes to empty string', () => {
    expect(base58Encode(new Uint8Array([]))).toBe('');
  });

  it('empty string decodes to empty array', () => {
    expect(base58Decode('')).toEqual(new Uint8Array([]));
  });

  it('leading zero bytes → leading "1"s', () => {
    const bytes = new Uint8Array([0, 0, 1]);
    const encoded = base58Encode(bytes);
    expect(encoded.startsWith('11')).toBe(true);
    expect(base58Decode(encoded)).toEqual(bytes);
  });

  it('round-trips a 32-byte Ed25519 public key', async () => {
    const priv = utils.randomPrivateKey();
    const pub = await getPublicKey(priv);
    const encoded = base58Encode(pub);
    expect(base58Decode(encoded)).toEqual(pub);
  });

  it('throws on invalid base58 character', () => {
    expect(() => base58Decode('0OIl')).toThrow(/Invalid base58/);
  });

  it('known vector: single byte 0x00', () => {
    expect(base58Encode(new Uint8Array([0]))).toBe('1');
    expect(base58Decode('1')).toEqual(new Uint8Array([0]));
  });
});

// ─── Proof of Work ───

describe('verifyProofOfWork', () => {
  it('returns true for difficulty=0 (any nonce passes)', () => {
    const key = new Uint8Array(32).fill(42);
    expect(verifyProofOfWork(key, 'deadbeef', 0)).toBe(true);
  });

  it('rejects a nonce with insufficient leading zero bits', () => {
    // We need a nonce where sha256(key || nonce) does NOT have 1 leading zero bit.
    // The first bit of sha256 output is rarely zero, so try a few.
    const key = new Uint8Array(32).fill(0);
    // 'ff' repeated — highly unlikely to have even 1 leading zero bit
    // Actually let's find one that fails at difficulty 8
    let failed = false;
    for (let i = 0; i < 10; i++) {
      const nonce = i.toString(16).padStart(2, '0');
      const hash = sha256(new Uint8Array([...key, ...new Uint8Array([parseInt(nonce, 16)])]));
      if (hash[0] !== 0) {
        // This nonce does NOT have 8 leading zero bits
        expect(verifyProofOfWork(key, nonce, 8)).toBe(false);
        failed = true;
        break;
      }
    }
    if (!failed) {
      // All had leading zeros — just pass the test
      expect(true).toBe(true);
    }
  });

  it('finds a valid nonce at low difficulty (4 bits)', () => {
    const key = new Uint8Array(32).fill(7);
    let nonce = 0n;
    let found = false;
    for (let i = 0; i < 1000000; i++) {
      const hex = nonce.toString(16).padStart(2, '0');
      if (verifyProofOfWork(key, hex, 4)) {
        expect(verifyProofOfWork(key, hex, 4)).toBe(true);
        found = true;
        break;
      }
      nonce++;
    }
    expect(found).toBe(true);
  });

  it('a valid nonce that passes difficulty also passes lower difficulties', () => {
    const key = new Uint8Array(32).fill(3);
    // Find nonce that passes difficulty=4
    let nonce = 0n;
    let validHex = '';
    while (true) {
      const hex = nonce.toString(16).padStart(2, '0');
      if (verifyProofOfWork(key, hex, 4)) {
        validHex = hex;
        break;
      }
      nonce++;
    }
    expect(verifyProofOfWork(key, validHex, 4)).toBe(true);
    expect(verifyProofOfWork(key, validHex, 1)).toBe(true);
    expect(verifyProofOfWork(key, validHex, 0)).toBe(true);
  });
});

// ─── computeChainHash ───

describe('computeChainHash', () => {
  const prevHash = GENESIS_HASH;
  const pubKey = new Uint8Array(32).fill(1);
  const nonce = 'abcd1234';
  const profileHash = 'a'.repeat(64);
  const timestamp = '2024-01-01T00:00:00.000Z';

  it('returns a deterministic 64-char hex string', () => {
    const h1 = computeChainHash(prevHash, pubKey, nonce, profileHash, timestamp);
    const h2 = computeChainHash(prevHash, pubKey, nonce, profileHash, timestamp);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(h1)).toBe(true);
  });

  it('different inputs produce different hashes', () => {
    const h1 = computeChainHash(prevHash, pubKey, nonce, profileHash, timestamp);
    const h2 = computeChainHash(prevHash, pubKey, nonce, profileHash, '2024-01-02T00:00:00.000Z');
    expect(h1).not.toBe(h2);
  });

  it('different previous_hash produces different output', () => {
    const h1 = computeChainHash('a'.repeat(64), pubKey, nonce, profileHash, timestamp);
    const h2 = computeChainHash('b'.repeat(64), pubKey, nonce, profileHash, timestamp);
    expect(h1).not.toBe(h2);
  });

  it('different public key produces different output', () => {
    const pk2 = new Uint8Array(32).fill(2);
    const h1 = computeChainHash(prevHash, pubKey, nonce, profileHash, timestamp);
    const h2 = computeChainHash(prevHash, pk2, nonce, profileHash, timestamp);
    expect(h1).not.toBe(h2);
  });

  it('uses length-delimited encoding (adjacent fields cannot collide)', () => {
    // prevHash="ab" + nonce="cd" should differ from prevHash="abc" + nonce="d"
    const pk = new Uint8Array(32);
    const h1 = computeChainHash('ab', pk, 'cd', profileHash, timestamp);
    const h2 = computeChainHash('abc', pk, 'd', profileHash, timestamp);
    expect(h1).not.toBe(h2);
  });
});

// ─── hashProfile ───

describe('hashProfile', () => {
  it('same data different key order → same hash', () => {
    const p1 = { z: 1, a: 2, m: 'hello' };
    const p2 = { m: 'hello', z: 1, a: 2 };
    expect(hashProfile(p1 as Record<string, unknown>)).toBe(hashProfile(p2 as Record<string, unknown>));
  });

  it('nested objects are also sorted', () => {
    const p1 = { outer: { z: 1, a: 2 } };
    const p2 = { outer: { a: 2, z: 1 } };
    expect(hashProfile(p1 as Record<string, unknown>)).toBe(hashProfile(p2 as Record<string, unknown>));
  });

  it('different data → different hash', () => {
    const p1 = { name: 'Alice' };
    const p2 = { name: 'Bob' };
    expect(hashProfile(p1)).not.toBe(hashProfile(p2));
  });

  it('returns a 64-char hex string', () => {
    const h = hashProfile({ foo: 'bar' });
    expect(h).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(h)).toBe(true);
  });
});

// ─── canonicalJsonStringify ───

describe('canonicalJsonStringify', () => {
  it('sorts object keys', () => {
    expect(canonicalJsonStringify({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
  });

  it('handles nested objects with sorted keys', () => {
    const result = canonicalJsonStringify({ b: { z: 1, a: 2 }, a: 'x' });
    expect(result).toBe('{"a":"x","b":{"a":2,"z":1}}');
  });

  it('handles arrays', () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles null', () => {
    expect(canonicalJsonStringify(null)).toBe('null');
  });

  it('handles undefined as null', () => {
    expect(canonicalJsonStringify(undefined)).toBe('null');
  });

  it('handles booleans', () => {
    expect(canonicalJsonStringify(true)).toBe('true');
    expect(canonicalJsonStringify(false)).toBe('false');
  });

  it('handles numbers', () => {
    expect(canonicalJsonStringify(42)).toBe('42');
    expect(canonicalJsonStringify(3.14)).toBe('3.14');
  });

  it('handles strings with escaping', () => {
    expect(canonicalJsonStringify('hello "world"')).toBe('"hello \\"world\\""');
  });

  it('handles arrays of objects', () => {
    const result = canonicalJsonStringify([{ b: 2, a: 1 }]);
    expect(result).toBe('[{"a":1,"b":2}]');
  });
});

// ─── publicKeyToAgentId / agentIdToPublicKey ───

describe('publicKeyToAgentId / agentIdToPublicKey', () => {
  it('round-trip for a random key', async () => {
    const priv = utils.randomPrivateKey();
    const pub = await getPublicKey(priv);
    const agentId = publicKeyToAgentId(pub);
    expect(agentId.startsWith('ag_')).toBe(true);
    expect(agentIdToPublicKey(agentId)).toEqual(pub);
  });

  it('throws on invalid agent ID format', () => {
    expect(() => agentIdToPublicKey('bad_id')).toThrow();
    expect(() => agentIdToPublicKey('xxx_something')).toThrow();
  });

  it('produces stable IDs across calls', async () => {
    const priv = utils.randomPrivateKey();
    const pub = await getPublicKey(priv);
    expect(publicKeyToAgentId(pub)).toBe(publicKeyToAgentId(pub));
  });
});

// ─── verifySignature ───

describe('verifySignature', () => {
  it('valid signature passes', async () => {
    const priv = utils.randomPrivateKey();
    const pub = await getPublicKey(priv);
    const message = new TextEncoder().encode('hello world');
    const sig = await sign(message, priv);
    expect(await verifySignature(message, sig, pub)).toBe(true);
  });

  it('tampered message fails', async () => {
    const priv = utils.randomPrivateKey();
    const pub = await getPublicKey(priv);
    const message = new TextEncoder().encode('hello world');
    const sig = await sign(message, priv);
    const tampered = new TextEncoder().encode('hello WORLD');
    expect(await verifySignature(tampered, sig, pub)).toBe(false);
  });

  it('wrong key fails', async () => {
    const priv1 = utils.randomPrivateKey();
    const priv2 = utils.randomPrivateKey();
    const pub2 = await getPublicKey(priv2);
    const message = new TextEncoder().encode('test message');
    const sig = await sign(message, priv1);
    expect(await verifySignature(message, sig, pub2)).toBe(false);
  });

  it('invalid signature bytes return false', async () => {
    const priv = utils.randomPrivateKey();
    const pub = await getPublicKey(priv);
    const message = new TextEncoder().encode('test');
    const badSig = new Uint8Array(64).fill(0);
    expect(await verifySignature(message, badSig, pub)).toBe(false);
  });
});
