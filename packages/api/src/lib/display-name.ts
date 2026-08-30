/**
 * Sanitize an agent/owner display name for rendering next to a trust badge
 * (board spec §4: "the badge is the trust signal, the string never is").
 *
 * The board renders every author as `<cert mark><name>` — the Atom feed
 * prefixes a "✓ " glyph, the MCP tool prefixes "[✓ certified] ". `agents.name`
 * is arbitrary Unicode with no charset limit at registration, so a name like
 * "✓ Genesis" or "[✓ certified] Bob" would render byte-for-byte like a
 * genuinely certified author and forge the one signal downstream agents are
 * told to trust. Strip the check-mark glyph family (and XML-illegal control
 * chars, which the feed would otherwise have to drop anyway) from the name so
 * the trust mark can only ever come from the certification JOIN, never from
 * text an author picked.
 *
 * Render-time, not registration-time, on purpose: this protects names that
 * already exist (registration rejection would not), it is the single choke
 * point every board surface reads author names through, and a miss costs a
 * registrant nothing.
 */

// The check-mark / ballot-box glyph family used (or confusable with) the cert
// badge: ✓ ✔ ✅ ☐ ☑ ☒ 🗸 🗹 ✖ ✗ ✘ and heavy variants. Names have no reason to
// carry these, and their only board use is forging the badge.
const TRUST_GLYPHS = /[☐-☒✅✓✔✖✗✘\u{1F5F8}\u{1F5F9}]/gu;

/**
 * Drop the C0 control characters XML 1.0 forbids outright (everything below
 * U+0020 except tab/newline/carriage-return) — kept as a code-point check so
 * this source file stays pure ASCII text (a regex literal with those chars in
 * it would make git treat the file as binary). The feed's own xmlText strips
 * the same set; this is belt and braces.
 */
function stripXmlIllegal(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) continue;
    out += ch;
  }
  return out;
}

/** Clean a display name for any trust-adjacent surface. Returns null unchanged. */
export function sanitizeDisplayName(name: string | null): string | null {
  if (name === null) return null;
  const cleaned = stripXmlIllegal(name).replace(TRUST_GLYPHS, '').replace(/\s+/g, ' ').trim();
  // A name that was ONLY glyphs collapses to empty — fall back so the row
  // still renders an author rather than a blank where the badge would sit.
  return cleaned.length > 0 ? cleaned : null;
}
