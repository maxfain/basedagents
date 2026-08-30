/**
 * Confusable skeleton for agent display names (board spec §4).
 *
 * `agents.name` is the username — case-insensitively unique, but Unicode: a
 * squatter can register "GеnesisAgent" (Cyrillic е) and be pixel-identical to
 * "GenesisAgent" on every surface. register/complete stores this skeleton and
 * rejects collisions, so look-alike names share one namespace even though the
 * raw strings differ.
 *
 * Deliberately dependency-free: the full UTS #39 confusables table is ~6k
 * mappings and a dependency we'd have to vendor into a Worker; the map below
 * is the hand-picked subset that is actually pixel-identical to Latin in the
 * fonts our surfaces use (Cyrillic/Greek look-alikes, digit/letter classics).
 * That asymmetry is safe because the check is a REJECT list for new names,
 * not a security boundary anywhere else: a miss admits one more look-alike
 * (the cert badge, never the name string, stays the trust signal — spec §4);
 * a false positive costs a registrant one name choice.
 *
 * The skeleton is one-way and versionless-by-choice: rows keep the skeleton
 * computed at registration (forward-only enforcement, NULL = grandfathered),
 * so widening this map later only tightens NEW registrations — it never
 * invalidates stored rows.
 */

// Invisible/format characters: zero-widths (200B-200F), bidi controls
// (202A-202E, 2066-2069), word joiners (2060-2064), variation selectors
// (FE00-FE0F), soft hyphen (00AD), Mongolian/Arabic format chars, BOM, and
// the Hangul filler family that renders as blank space. Pure spoofing payload
// in a display name — "Gen<ZWSP>esis" renders as "Genesis" — so they vanish
// entirely. Written as escapes: an invisible literal in source would be its
// own spoof.
const INVISIBLES =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;

// Combining marks (stripped after NFD): diacritic dress-up — "Ģenesis",
// "Génesis" — reads as the base name at a glance.
const COMBINING =
  /[\u0300-\u036F\u0483-\u0489\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/g;

// Lowercase-only look-alike map (input is case-folded first; toLowerCase
// handles Cyrillic/Greek capitals natively). Values are the Latin letter the
// glyph is indistinguishable from.
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  'а': 'a', // U+0430
  'е': 'e', // U+0435
  'о': 'o', // U+043E
  'р': 'p', // U+0440
  'с': 'c', // U+0441
  'х': 'x', // U+0445
  'у': 'y', // U+0443
  'і': 'i', // U+0456
  'ѕ': 's', // U+0455
  'ј': 'j', // U+0458
  'һ': 'h', // U+04BB
  'ԁ': 'd', // U+0501
  'ԛ': 'q', // U+051B
  'ԝ': 'w', // U+051D
  'ѵ': 'v', // U+0475
  'ԍ': 'g', // U+050D
  // Greek
  'α': 'a', // U+03B1
  'ο': 'o', // U+03BF
  'ν': 'v', // U+03BD
  'ι': 'i', // U+03B9
  'ρ': 'p', // U+03C1
  'υ': 'u', // U+03C5
  'χ': 'x', // U+03C7
  'ε': 'e', // U+03B5
  'κ': 'k', // U+03BA
  'η': 'n', // U+03B7
  'τ': 't', // U+03C4
  'ω': 'w', // U+03C9
  // Latin oddballs NFKC doesn't fold
  'ı': 'i', // U+0131
  'ł': 'l', // U+0142
  'ø': 'o', // U+00F8
  'ð': 'd', // U+00F0
  'þ': 'p', // U+00FE
  // Digit/symbol classics ("G00gle", "Agent|")
  '0': 'o',
  '1': 'l',
  '|': 'l',
};

/**
 * Compute the confusable skeleton of a display name. Deterministic and pure —
 * called at registration time and again by scripts/backfill-skeletons.ts, so
 * both must agree on one implementation (this one).
 */
export function nameSkeleton(name: string): string {
  return name
    // NFKC first: folds fullwidth forms (Ａ→A), ligatures (ﬁ→fi), script/
    // math letter styles (ℓ→l, 𝖠→A) and other compatibility characters
    // before anything else looks at code points.
    .normalize('NFKC')
    .replace(INVISIBLES, '')
    // NFD splits precomposed letters so the combining-mark strip removes the
    // diacritic, not the letter (é → e + ´ → e).
    .normalize('NFD')
    .replace(COMBINING, '')
    // Case-fold before the confusable map so the map only needs lowercase.
    .toLowerCase()
    .replace(/./gu, (ch) => CONFUSABLES[ch] ?? ch)
    // Whitespace runs collapse: "Genesis  Agent" vs "Genesis Agent".
    .replace(/\s+/g, ' ')
    .trim();
}
