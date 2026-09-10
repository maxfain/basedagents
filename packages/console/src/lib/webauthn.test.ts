import { describe, it, expect } from 'vitest';
import { base64urlToBytes, bytesToBase64url } from './webauthn.js';
import { actionChallenge, sha256hex, canonicalJsonStringify } from './action.js';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe('base64url bridge (must match the control-plane encoding)', () => {
  it('encodes bytes to unpadded, url-safe base64url', () => {
    // [0,1,2,3] → base64 "AAECAw==" → base64url "AAECAw"
    expect(bytesToBase64url(new Uint8Array([0, 1, 2, 3]))).toBe('AAECAw');
    const enc = bytesToBase64url(new Uint8Array([251, 255, 190, 0]));
    expect(enc).not.toMatch(/[+/=]/); // url-safe, unpadded
  });

  it('decodes unpadded base64url the server sends (padding is optional)', () => {
    expect(Array.from(base64urlToBytes('AAECAw'))).toEqual([0, 1, 2, 3]);
    // url-safe alphabet: '-' and '_' map to '+' and '/'
    expect(Array.from(base64urlToBytes('-_8'))).toEqual([251, 255]);
  });

  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(Array.from(base64urlToBytes(bytesToBase64url(bytes)))).toEqual(Array.from(bytes));
  });
});

describe('actionChallenge (WYSIWYS hash) parity', () => {
  it('is base64url(sha256(utf8(canonical))) — vectored against the empty string', () => {
    // sha256("") is a well-known constant; the console must hash exactly this way.
    const sha256Empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(actionChallenge('')).toBe(bytesToBase64url(hexToBytes(sha256Empty)));
  });

  it('is deterministic and yields a 43-char unpadded base64url digest', () => {
    const canonical = '{"action_type":"approve_grant","agent_id":"ag_x"}';
    const h = actionChallenge(canonical);
    expect(h).toBe(actionChallenge(canonical));
    expect(h).toHaveLength(43); // 32-byte digest, unpadded base64url
    expect(h).not.toMatch(/[+/=]/);
  });

  it('changes if any byte of the canonical action changes', () => {
    expect(actionChallenge('{"a":1}')).not.toBe(actionChallenge('{"a":2}'));
  });
});

describe('sha256hex (content-bound action strings) parity', () => {
  it('is lowercase hex sha256(utf8) — the control plane’s sha256hex, vectored against "" and "abc"', () => {
    // These are the two textbook SHA-256 vectors; `task.accept:<id>:<sha256hex(note ?? "")>`
    // must reproduce the server's derivation byte for byte or the review fails WYSIWYS.
    expect(sha256hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('canonicalJsonStringify (must byte-match the control plane)', () => {
  it('sorts object keys recursively and matches the server’s RFC 8785 subset', () => {
    expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJsonStringify({ z: { y: 1, x: 2 }, a: [3, 2, 1] })).toBe('{"a":[3,2,1],"z":{"x":2,"y":1}}');
    // Key ORDER in the source object must not change the output.
    const a = canonicalJsonStringify({ title: 't', description: 'd', output_format: 'json' });
    const b = canonicalJsonStringify({ output_format: 'json', description: 'd', title: 't' });
    expect(a).toBe(b);
    expect(a).toBe('{"description":"d","output_format":"json","title":"t"}');
  });

  it('produces the exact task.create action type the server re-derives', () => {
    // The console signs `task.create:<sha256hex(canonicalJsonStringify(fields))>`;
    // the server recomputes the same from the fields it parses.
    const fields = { title: 'Check the quickstart', description: 'Run it clean', output_format: 'json' as const };
    const actionType = `task.create:${sha256hex(canonicalJsonStringify(fields))}`;
    expect(actionType).toBe(
      `task.create:${sha256hex('{"description":"Run it clean","output_format":"json","title":"Check the quickstart"}')}`,
    );
  });
});
