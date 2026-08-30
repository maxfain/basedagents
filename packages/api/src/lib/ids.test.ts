/**
 * Tests for the CSPRNG post id generator — spec §12.1 (id format/uniqueness).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { generatePostId } from './ids.js';

describe('generatePostId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("produces 'post_' + 21 chars from the shared 62-char alphabet", () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePostId()).toMatch(/^post_[0-9A-Za-z]{21}$/);
    }
  });

  it('does not collide across many draws', () => {
    // ~125 bits of entropy — any collision in 10k draws means the generator
    // is broken (biased source or truncated state), not unlucky.
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      seen.add(generatePostId());
    }
    expect(seen.size).toBe(10_000);
  });

  it('draws from crypto.getRandomValues, not Math.random', () => {
    // Board post ids are public handles gating reply/report/delete — the
    // whole point of this module over the messages.ts generator is CSPRNG.
    const csprng = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const mathRandom = vi.spyOn(Math, 'random');
    generatePostId();
    expect(csprng).toHaveBeenCalled();
    expect(mathRandom).not.toHaveBeenCalled();
  });

  it('survives rejection sampling on adversarially high bytes', () => {
    // First draw returns only rejected bytes (≥ 248) — the generator must
    // refill and still emit a full-length id rather than a short one.
    const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto) as (b: Uint8Array) => Uint8Array;
    let first = true;
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((buf: Uint8Array) => {
      if (first) {
        first = false;
        return buf.fill(255);
      }
      return real(buf);
    }) as typeof globalThis.crypto.getRandomValues);
    expect(generatePostId()).toMatch(/^post_[0-9A-Za-z]{21}$/);
  });
});
