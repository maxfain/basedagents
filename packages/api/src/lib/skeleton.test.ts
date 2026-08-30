import { describe, it, expect } from 'vitest';
import { nameSkeleton } from './skeleton.js';

// The property under test everywhere: two names that render identically must
// produce the SAME skeleton (so register/complete 409s the second one), and
// genuinely different names must not be dragged into collision.

describe('nameSkeleton', () => {
  it('case-folds (skeleton matches the existing NOCASE uniqueness)', () => {
    expect(nameSkeleton('GENESIS')).toBe('genesis');
    expect(nameSkeleton('GeNeSiS')).toBe(nameSkeleton('genesis'));
  });

  it('maps Cyrillic homoglyphs onto their Latin look-alikes', () => {
    // е (U+0435), о (U+043E), а (U+0430) — pixel-identical to Latin e/o/a.
    expect(nameSkeleton('G\u0435n\u0435sisAg\u0435nt')).toBe(nameSkeleton('GenesisAgent'));
    expect(nameSkeleton('\u0430g\u043Ent')).toBe(nameSkeleton('agont'));
  });

  it('maps Greek homoglyphs (omicron, alpha)', () => {
    expect(nameSkeleton('Genesis\u03BFmega')).toBe(nameSkeleton('Genesisomega'));
    expect(nameSkeleton('\u03B1lpha')).toBe(nameSkeleton('alpha'));
  });

  it('folds fullwidth and mathematical letter styles via NFKC (astral-safe)', () => {
    expect(nameSkeleton('Ｇｅｎｅｓｉｓ')).toBe('genesis'); // Ｇｅｎｅｓｉｓ
    expect(nameSkeleton('\u{1D5A6}enesis')).toBe('genesis'); // 𝖦 math sans-serif G
  });

  it('strips invisible characters (zero-width, bidi, soft hyphen)', () => {
    expect(nameSkeleton('Gen\u200Besis')).toBe('genesis'); // ZWSP
    expect(nameSkeleton('Gen\u00ADesis')).toBe('genesis'); // soft hyphen
    expect(nameSkeleton('\u202EGenesis\u202C')).toBe('genesis'); // RLO + PDF bidi controls
  });

  it('strips diacritic dress-up', () => {
    expect(nameSkeleton('G\u00E9n\u00E9sis')).toBe('genesis'); // é precomposed
    expect(nameSkeleton('Ge\u0301nesis')).toBe('genesis'); // e + combining acute
  });

  it('maps the digit/symbol classics', () => {
    expect(nameSkeleton('G00gle')).toBe(nameSkeleton('Google'));
    expect(nameSkeleton('Agent1')).toBe(nameSkeleton('Agentl'));
  });

  it('collapses whitespace runs and trims', () => {
    expect(nameSkeleton('  Genesis   Agent ')).toBe('genesis agent');
  });

  it('keeps genuinely distinct names distinct', () => {
    expect(nameSkeleton('AlphaBot')).not.toBe(nameSkeleton('BetaBot'));
    expect(nameSkeleton('GenesisAgent')).not.toBe(nameSkeleton('GenesisAgent2'));
  });
});
