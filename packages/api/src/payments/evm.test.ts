/**
 * EVM primitives (evm.ts): RLP against the reference vectors, and EIP-1559 signing
 * against transactions signed by an independent implementation (eth-account 0.13.4,
 * same key and fields): the raw bytes, and so the hashes, must match exactly.
 */
import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bigintToBytes, bytesToHex, hexToBytes, rlpEncode, signEip1559, toChecksumAddress, addressFromPrivateKey, type RlpItem } from './evm.js';

const enc = (s: string) => new TextEncoder().encode(s);

/** Minimal RLP decoder (test only): strings → bytes, lists → arrays. */
function rlpDecode(input: Uint8Array): RlpItem {
  const read = (at: number): [RlpItem, number] => {
    const b = input[at];
    const int = (from: number, len: number) => input.slice(from, from + len).reduce((n, x) => n * 256 + x, 0);
    if (b < 0x80) return [input.slice(at, at + 1), at + 1];
    if (b <= 0xb7) return [input.slice(at + 1, at + 1 + b - 0x80), at + 1 + b - 0x80];
    if (b <= 0xbf) { const ll = b - 0xb7; const len = int(at + 1, ll); return [input.slice(at + 1 + ll, at + 1 + ll + len), at + 1 + ll + len]; }
    const ll = b <= 0xf7 ? 0 : b - 0xf7;
    const len = b <= 0xf7 ? b - 0xc0 : int(at + 1, ll);
    const end = at + 1 + ll + len;
    const out: RlpItem[] = [];
    for (let p = at + 1 + ll; p < end;) { const [item, next] = read(p); out.push(item); p = next; }
    return [out, end];
  };
  return read(0)[0];
}
const hex = (b: Uint8Array) => '0x' + bytesToHex(b);

describe('rlpEncode', () => {
  it('matches the reference vectors', () => {
    expect(hex(rlpEncode(enc('dog')))).toBe('0x83646f67');
    expect(hex(rlpEncode([enc('cat'), enc('dog')]))).toBe('0xc88363617483646f67');
    expect(hex(rlpEncode(new Uint8Array(0)))).toBe('0x80');
    expect(hex(rlpEncode([]))).toBe('0xc0');
    expect(hex(rlpEncode(bigintToBytes(0n)))).toBe('0x80');
    expect(hex(rlpEncode(bigintToBytes(15n)))).toBe('0x0f');
    expect(hex(rlpEncode(bigintToBytes(1024n)))).toBe('0x820400');
    const set: RlpItem = [[], [[]], [[], [[]]]];
    expect(hex(rlpEncode(set))).toBe('0xc7c0c1c0c3c0c1c0');
    // 56 bytes: the first string that takes a length-of-length prefix.
    expect(hex(rlpEncode(enc('Lorem ipsum dolor sit amet, consectetur adipisicing elit')))).toBe(
      '0xb8384c6f72656d20697073756d20646f6c6f722073697420616d65742c20636f6e7365637465747572206164697069736963696e6720656c6974',
    );
  });
});

describe('signEip1559', () => {
  // eth-account's documented test key; never holds anything.
  const KEY = hexToBytes('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
  const tx = (nonce: bigint, data: string, gas: bigint) => ({
    chainId: 5042n, nonce, maxPriorityFeePerGas: 2011n, maxFeePerGas: 40_000_002_011n, gas,
    to: '0x3600000000000000000000000000000000000000', value: 0n, data,
  });

  it('produces the same transactions as eth-account', () => {
    expect(addressFromPrivateKey(KEY)).toBe('0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
    const simple = signEip1559(tx(0n, '0x', 21000n), KEY);
    expect(simple.raw).toBe(
      '0x02f86b8213b2808207db8509502f97db8252089436000000000000000000000000000000000000008080c080a00293ed1915aa89676029716025fc9e64ab4df86ceb4b5e416fbac12447711ce1a07812306b9537bd56909ee1ee721869fac765b1c6e94edb936dda94abb1945a0f',
    );
    expect(simple.hash).toBe('0x964b8905b6dd649ec267e9c00935375d3dc66258ec9d80676f8d8d179c348441');
    // Long calldata (a list over 55 bytes) and a two-byte nonce.
    expect(signEip1559(tx(7n, '0xe3ee160e' + 'ab'.repeat(288), 96543n), KEY).hash).toBe('0x7634a4b4f99ead564ba0c14110d52d84aa6e6663927dc4ae6466f95abf7807fe');
    expect(signEip1559(tx(300n, '0x' + '01'.repeat(55), 1n), KEY).hash).toBe('0xf503bf92846d17c5656397581cfe2d646ae6ba30bd12332baf9585f3f09d8710');
  });

  it('signs for the key: the sender recovers from the signed fields', () => {
    for (let i = 0; i < 20; i++) {
      const key = secp256k1.utils.randomPrivateKey();
      const { raw, hash } = signEip1559(tx(BigInt(i), '0x1234', 50_000n), key);
      expect(hash).toBe(hex(keccak_256(hexToBytes(raw))));
      const bytes = hexToBytes(raw);
      expect(bytes[0]).toBe(0x02);
      const fields = rlpDecode(bytes.slice(1)) as Uint8Array[];
      expect(fields).toHaveLength(12);
      const [yParity, r, s] = fields.slice(9) as Uint8Array[];
      const digest = keccak_256(new Uint8Array([0x02, ...rlpEncode(fields.slice(0, 9) as RlpItem[])]));
      const word = (b: Uint8Array) => { const w = new Uint8Array(32); w.set(b, 32 - b.length); return w; };
      const pub = secp256k1.Signature.fromCompact(new Uint8Array([...word(r), ...word(s)]))
        .addRecoveryBit(yParity.length ? yParity[0] : 0).recoverPublicKey(digest).toRawBytes(false);
      expect(toChecksumAddress(keccak_256(pub.slice(1)).slice(12))).toBe(addressFromPrivateKey(key));
    }
  });

  it('refuses a malformed recipient or calldata', () => {
    expect(() => signEip1559({ ...tx(0n, '0x', 1n), to: '0x12' }, KEY)).toThrow(/to/);
    expect(() => signEip1559(tx(0n, '0x123', 1n), KEY)).toThrow(/data/);
  });
});
