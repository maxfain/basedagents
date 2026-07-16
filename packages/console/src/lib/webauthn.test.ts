import { describe, it, expect } from 'vitest';
import { base64urlToBytes, bytesToBase64url } from './webauthn.js';
import { actionChallenge } from './action.js';

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
