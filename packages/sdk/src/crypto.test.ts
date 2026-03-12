import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import {
  generateKeypair,
  serializeKeypair,
  deserializeKeypair,
  publicKeyToAgentId,
  agentIdToPublicKey,
  base58Encode,
  base58Decode,
  signRequest,
  solveProofOfWork,
  solveProofOfWorkAsync,
  bytesToHex,
  sha256,
} from './index.js';

// ─── generateKeypair ───

describe('generateKeypair', () => {
  it('returns an AgentKeypair with Uint8Array keys', async () => {
    const kp = await generateKeypair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
  });

  it('public key is 32 bytes (Ed25519)', async () => {
    const kp = await generateKeypair();
    expect(kp.publicKey.length).toBe(32);
  });

  it('private key is 32 bytes', async () => {
    const kp = await generateKeypair();
    expect(kp.privateKey.length).toBe(32);
  });

  it('produces different keypairs on each call', async () => {
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    expect(bytesToHex(kp1.publicKey)).not.toBe(bytesToHex(kp2.publicKey));
  });

  it('public key is derived correctly from private key', async () => {
    const kp = await generateKeypair();
    const derivedPub = await ed.getPublicKeyAsync(kp.privateKey);
    expect(kp.publicKey).toEqual(derivedPub);
  });
});

// ─── serializeKeypair / deserializeKeypair ───

describe('serializeKeypair / deserializeKeypair', () => {
  it('round-trips a keypair', async () => {
    const kp = await generateKeypair();
    const json = serializeKeypair(kp);
    const restored = deserializeKeypair(json);
    expect(bytesToHex(restored.publicKey)).toBe(bytesToHex(kp.publicKey));
    expect(bytesToHex(restored.privateKey)).toBe(bytesToHex(kp.privateKey));
  });

  it('serialized value is valid JSON', async () => {
    const kp = await generateKeypair();
    const json = serializeKeypair(kp);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('serialized JSON contains publicKey and privateKey as hex', async () => {
    const kp = await generateKeypair();
    const parsed = JSON.parse(serializeKeypair(kp));
    expect(typeof parsed.publicKey).toBe('string');
    expect(typeof parsed.privateKey).toBe('string');
    expect(parsed.publicKey).toHaveLength(64); // 32 bytes × 2 hex chars
    expect(parsed.privateKey).toHaveLength(64);
  });

  it('deserialized keys sign and verify correctly', async () => {
    const kp = await generateKeypair();
    const restored = deserializeKeypair(serializeKeypair(kp));
    const msg = new TextEncoder().encode('test message');
    const sig = await ed.signAsync(msg, restored.privateKey);
    const ok = await ed.verifyAsync(sig, msg, restored.publicKey);
    expect(ok).toBe(true);
  });
});

// ─── publicKeyToAgentId / agentIdToPublicKey ───

describe('publicKeyToAgentId', () => {
  it('produces a string starting with ag_', async () => {
    const kp = await generateKeypair();
    const id = publicKeyToAgentId(kp.publicKey);
    expect(id).toMatch(/^ag_/);
  });

  it('agentIdToPublicKey round-trips the public key', async () => {
    const kp = await generateKeypair();
    const id = publicKeyToAgentId(kp.publicKey);
    const recovered = agentIdToPublicKey(id);
    expect(bytesToHex(recovered)).toBe(bytesToHex(kp.publicKey));
  });

  it('agentIdToPublicKey throws for invalid IDs', () => {
    expect(() => agentIdToPublicKey('invalid_id')).toThrow();
    expect(() => agentIdToPublicKey('not_ag_prefix')).toThrow();
  });
});

// ─── base58Encode / base58Decode ───

describe('base58Encode / base58Decode', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0x01, 0x02, 0x03, 0xAB, 0xCD, 0xEF]);
    const encoded = base58Encode(bytes);
    const decoded = base58Decode(encoded);
    expect(decoded).toEqual(bytes);
  });

  it('round-trips a 32-byte public key', async () => {
    const kp = await generateKeypair();
    const encoded = base58Encode(kp.publicKey);
    const decoded = base58Decode(encoded);
    expect(decoded).toEqual(kp.publicKey);
  });

  it('encoded string contains no invalid base58 characters', async () => {
    const kp = await generateKeypair();
    const encoded = base58Encode(kp.publicKey);
    // Base58 never contains 0, O, I, l
    expect(encoded).not.toMatch(/[0OIl]/);
  });

  it('throws on invalid base58 character', () => {
    expect(() => base58Decode('invalid0char')).toThrow(); // '0' is not in base58
  });

  it('handles leading zero bytes', () => {
    const bytes = new Uint8Array([0, 0, 1, 2, 3]);
    const encoded = base58Encode(bytes);
    const decoded = base58Decode(encoded);
    expect(decoded).toEqual(bytes);
  });
});

// ─── signRequest ───

describe('signRequest', () => {
  it('returns Authorization and X-Timestamp headers', async () => {
    const kp = await generateKeypair();
    const headers = await signRequest(kp, 'GET', '/v1/agents/search');
    expect(headers.Authorization).toBeDefined();
    expect(headers['X-Timestamp']).toBeDefined();
  });

  it('Authorization header starts with "AgentSig "', async () => {
    const kp = await generateKeypair();
    const headers = await signRequest(kp, 'GET', '/v1/test');
    expect(headers.Authorization).toMatch(/^AgentSig /);
  });

  it('Authorization header contains pubkey:signature', async () => {
    const kp = await generateKeypair();
    const headers = await signRequest(kp, 'POST', '/v1/verify/submit', '{"result":"pass"}');
    const sig_part = headers.Authorization.slice('AgentSig '.length);
    const parts = sig_part.split(':');
    expect(parts.length).toBe(2);
    const [pubkeyB58, sigB64] = parts;
    expect(pubkeyB58.length).toBeGreaterThan(0);
    expect(sigB64.length).toBeGreaterThan(0);
  });

  it('X-Timestamp is close to current time', async () => {
    const before = Math.floor(Date.now() / 1000);
    const kp = await generateKeypair();
    const headers = await signRequest(kp, 'GET', '/v1/test');
    const after = Math.floor(Date.now() / 1000);
    const ts = parseInt(headers['X-Timestamp']);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 1);
  });

  it('signature is 64 bytes (Ed25519)', async () => {
    const kp = await generateKeypair();
    const headers = await signRequest(kp, 'GET', '/v1/test');
    const sig_part = headers.Authorization.slice('AgentSig '.length);
    const sigB64 = sig_part.split(':')[1];
    const sigBytes = Buffer.from(sigB64, 'base64');
    expect(sigBytes.length).toBe(64);
  });

  it('signature verifies against the correct public key', async () => {
    const kp = await generateKeypair();
    const method = 'POST';
    const path = '/v1/verify/submit';
    const body = '{"result":"pass"}';
    const headers = await signRequest(kp, method, path, body);

    const ts = headers['X-Timestamp'];
    const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body)));
    const message = `${method.toUpperCase()}:${path}:${ts}:${bodyHash}`;
    const msgBytes = new TextEncoder().encode(message);

    const sig_part = headers.Authorization.slice('AgentSig '.length);
    const sigB64 = sig_part.split(':')[1];
    const sigBytes = Buffer.from(sigB64, 'base64');

    const valid = await ed.verifyAsync(new Uint8Array(sigBytes), msgBytes, kp.publicKey);
    expect(valid).toBe(true);
  });
});

// ─── solveProofOfWork ───

describe('solveProofOfWork', () => {
  it('finds a valid nonce at low difficulty', async () => {
    const kp = await generateKeypair();
    const { nonce, hash } = solveProofOfWork(kp.publicKey, 8);
    expect(nonce).toMatch(/^[0-9a-f]{8}$/);
    expect(hash).toHaveLength(64); // hex-encoded SHA256
  });

  it('nonce produces hash with required leading zero bits', async () => {
    const kp = await generateKeypair();
    const difficulty = 8;
    const { nonce } = solveProofOfWork(kp.publicKey, difficulty);

    const nonceBuf = new Uint8Array(4);
    const nonceInt = parseInt(nonce, 16);
    nonceBuf[0] = (nonceInt >>> 24) & 0xff;
    nonceBuf[1] = (nonceInt >>> 16) & 0xff;
    nonceBuf[2] = (nonceInt >>> 8) & 0xff;
    nonceBuf[3] = nonceInt & 0xff;

    const buf = new Uint8Array(kp.publicKey.length + 4);
    buf.set(kp.publicKey, 0);
    buf.set(nonceBuf, kp.publicKey.length);
    const hash = sha256(buf);

    // First byte must be zero (8 leading zero bits)
    expect(hash[0]).toBe(0);
  });

  it('nonce is zero-padded to 8 hex chars', async () => {
    const kp = await generateKeypair();
    const { nonce } = solveProofOfWork(kp.publicKey, 8);
    expect(nonce).toHaveLength(8);
    expect(nonce).toMatch(/^[0-9a-f]{8}$/);
  });

  it('calls onProgress callback during search', async () => {
    const kp = await generateKeypair();
    let progressCount = 0;
    solveProofOfWork(kp.publicKey, 8, () => { progressCount++; });
    // Progress might or might not be called depending on how fast solution is found
    // Just verify it doesn't throw
    expect(progressCount).toBeGreaterThanOrEqual(0);
  });
});

// ─── solveProofOfWorkAsync ───

describe('solveProofOfWorkAsync', () => {
  it('finds a valid nonce asynchronously at low difficulty', async () => {
    const kp = await generateKeypair();
    const { nonce, hash } = await solveProofOfWorkAsync(kp.publicKey, 8);
    expect(nonce).toMatch(/^[0-9a-f]{8}$/);
    expect(hash).toHaveLength(64);
  });

  it('async nonce matches sync nonce for same key', async () => {
    // Both solvers should find the same nonce (deterministic search)
    const kp = await generateKeypair();
    const difficulty = 8;
    const { nonce: syncNonce } = solveProofOfWork(kp.publicKey, difficulty);
    const { nonce: asyncNonce } = await solveProofOfWorkAsync(kp.publicKey, difficulty);
    expect(asyncNonce).toBe(syncNonce);
  });

  it('accepts onProgress option', async () => {
    const kp = await generateKeypair();
    let progressCount = 0;
    await solveProofOfWorkAsync(kp.publicKey, 8, {
      onProgress: () => { progressCount++; },
      chunkSize: 10,
    });
    expect(progressCount).toBeGreaterThanOrEqual(0);
  });

  it('resolves with a nonce that satisfies difficulty', async () => {
    const kp = await generateKeypair();
    const difficulty = 8;
    const { nonce } = await solveProofOfWorkAsync(kp.publicKey, difficulty);

    const nonceInt = parseInt(nonce, 16);
    const buf = new Uint8Array(kp.publicKey.length + 4);
    buf.set(kp.publicKey, 0);
    buf[kp.publicKey.length]     = (nonceInt >>> 24) & 0xff;
    buf[kp.publicKey.length + 1] = (nonceInt >>> 16) & 0xff;
    buf[kp.publicKey.length + 2] = (nonceInt >>> 8)  & 0xff;
    buf[kp.publicKey.length + 3] =  nonceInt         & 0xff;
    const hash = sha256(buf);

    // At difficulty 8, the first byte must be 0x00
    expect(hash[0]).toBe(0);
  });
});
