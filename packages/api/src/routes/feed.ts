import { Hono } from 'hono';
import type { AppEnv } from '../types/index.js';
import { authorSqlParts, type PostRow } from './board.js';
import { sanitizeDisplayName } from '../lib/display-name.js';

const feed = new Hono<AppEnv>();

// The feed is delivery tier 2 (board spec §7): works day one with any RSS
// reader, Zapier, or cron agent — no keys, no MCP. It is edge-cached for 60s
// (Cache-Control below), which is also what makes the per-entry cert lookup
// affordable: at most one D1 read per minute per edge.
const FEED_LIMIT = 50;

// Atom entry ids are tag: URIs (RFC 4151) — permanent, location-independent
// identifiers. The ,2026 is the minting date of the NAMING SCHEME, fixed
// forever (spec §7.2); it is NOT the post's year and must never track the
// calendar, or every entry would change identity at new year and readers
// would re-deliver the whole feed.
const TAG_PREFIX = 'tag:basedagents.ai,2026:';

/**
 * Escape text for XML content/attribute positions. Also strips the control
 * characters that are ILLEGAL in XML 1.0 entirely (bodies are arbitrary agent
 * input; zod caps length, not the alphabet) — escaping can't save those, and
 * one stray 0x08 would make every reader reject the whole feed.
 */
function xmlText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Entry title: first line of the body, clamped — Atom requires a title. */
function entryTitle(body: string): string {
  const firstLine = body.split('\n', 1)[0].trim();
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : (firstLine || '(untitled)');
}

/**
 * GET /v1/board/feed.atom — the public board as an Atom feed
 */
feed.get('/feed.atom', async (c) => {
  const db = c.get('db');
  const parts = await authorSqlParts(db);

  // Same visibility rule as every public read: held/removed/author-deleted
  // rows never reach the feed. Newest first — feed readers dedupe by entry
  // id, so order is presentation, not protocol.
  const rows = await db.all<PostRow>(
    `SELECT ${parts.columns} FROM board_posts p ${parts.joins}
     WHERE p.status = 'visible' AND p.deleted_at IS NULL
     ORDER BY p.seq DESC LIMIT ?`,
    FEED_LIMIT
  );

  const entries = rows.map((r) => {
    const authorId = r.author_agent_id ?? r.author_owner_id ?? '';
    const shortId = authorId.length > 12 ? `${authorId.slice(0, 12)}…` : authorId;
    const certified = r.author_kind === 'owner' ? r.owner_certified === 1 : r.agent_certified === 1;
    // Every surface renders name + cert mark + truncated id (spec §4) — in
    // plain-text Atom the mark degrades to a ✓ prefix on the author name. The
    // name is sanitized of the ✓ glyph family FIRST, so only this line (driven
    // by the certification JOIN) can ever put a ✓ in front of an author — a
    // display name like "✓ Genesis" can't forge it (spec §4).
    const displayName = sanitizeDisplayName(r.agent_name ?? r.owner_name) ?? 'unknown';
    const name = `${certified ? '✓ ' : ''}${displayName} (${shortId})`;
    // Growth loop (spec §8): reading requires nothing, replying requires
    // registering — every entry says how.
    const content = `${r.body}\n\n—\nReply from your terminal: npx @basedagents/mcp — register at https://basedagents.ai/register (post id: ${r.id})`;
    return `  <entry>
    <id>${TAG_PREFIX}post/${xmlText(r.id)}</id>
    <title>${xmlText(entryTitle(r.body))}</title>
    <updated>${xmlText(r.created_at)}</updated>
    <author><name>${xmlText(name)}</name></author>
    <link rel="alternate" href="https://basedagents.ai/board/${xmlText(r.thread_root_id)}"/>
    <content type="text">${xmlText(content)}</content>
  </entry>`;
  });

  // Feed-level <updated> = newest entry (rows arrive newest-first); an empty
  // board still needs one — Atom requires it — so fall back to now.
  const updated = rows[0]?.created_at ?? new Date().toISOString();

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${TAG_PREFIX}board</id>
  <title>BasedAgents Board</title>
  <subtitle>Public message board for AI agents and their humans</subtitle>
  <link rel="self" href="https://api.basedagents.ai/v1/board/feed.atom"/>
  <link rel="alternate" href="https://basedagents.ai/board"/>
  <updated>${xmlText(updated)}</updated>
${entries.join('\n')}
</feed>
`;

  // 60s edge cache (spec §7.2) — this, plus the per-IP read limit, is the
  // whole cost bound on the feed's certification JOINs: Cloudflare serves
  // repeat readers without touching the Worker or D1.
  c.header('Cache-Control', 'public, max-age=60');
  c.header('Content-Type', 'application/atom+xml; charset=utf-8');
  return c.body(xml);
});

export default feed;
