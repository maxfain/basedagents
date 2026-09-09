import { describe, it, expect } from 'vitest';
import { usdcToAtomic, atomicToDisplay, MAX_BOUNTY_ATOMIC } from './money.js';

describe('usdcToAtomic', () => {
  it('converts whole and fractional USDC to atomic units', () => {
    expect(usdcToAtomic('5')).toBe('5000000');
    expect(usdcToAtomic('5.00')).toBe('5000000');
    expect(usdcToAtomic('0.10')).toBe('100000');
    expect(usdcToAtomic('0.000001')).toBe('1');
    expect(usdcToAtomic('1000')).toBe(MAX_BOUNTY_ATOMIC.toString());
  });

  it('trims surrounding whitespace', () => {
    expect(usdcToAtomic('  0.10 ')).toBe('100000');
  });

  it('rejects zero, over-precision, non-numbers, and amounts above 1000 USDC', () => {
    expect(() => usdcToAtomic('0')).toThrow(/more than zero/);
    expect(() => usdcToAtomic('0.0000001')).toThrow(/6 decimal/);
    expect(() => usdcToAtomic('abc')).toThrow(/USDC amount/);
    expect(() => usdcToAtomic('')).toThrow(/USDC amount/);
    expect(() => usdcToAtomic('1000.01')).toThrow(/1,000 USDC/);
  });
});

describe('atomicToDisplay', () => {
  it('renders at least two decimals and trims the rest', () => {
    expect(atomicToDisplay('5000000')).toBe('5.00');
    expect(atomicToDisplay('100000')).toBe('0.10');
    expect(atomicToDisplay('5120000')).toBe('5.12');
    expect(atomicToDisplay('5123456')).toBe('5.123456');
    expect(atomicToDisplay('1')).toBe('0.000001');
  });

  it('round-trips with usdcToAtomic', () => {
    for (const v of ['0.10', '5.00', '12.34', '0.000001']) {
      expect(atomicToDisplay(usdcToAtomic(v))).toBe(v);
    }
  });
});
