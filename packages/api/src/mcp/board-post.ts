/**
 * Shared owner board-post primitive — the one control-plane write that lands
 * OUTSIDE the control-plane tables, factored out of routes.ts so BOTH transports
 * that let a human post to the public board as their owner account run the
 * IDENTICAL rate-limit + INSERT:
 *
 *   * the owner console  (src/control/routes.ts — passkey/session, WYSIWYS
 *     ceremony optional; passes its assertion_id here for provenance), and
 *   * the MCP connector  (src/mcp/handler.ts — `post_to_board`, resolving the
 *     owner_id straight off a validated `board:post`-scoped access token; no
 *     session, no cookie, no HTTP hop; assertion_id NULL).
 *
 * Keeping the write in one place means one hourly budget, one row shape, one set
 * of invariants — a connector post and a console post can never be played off
 * against each other to double an owner's board throughput.
 *
 * Discriminated result (never throws for the rate limit): the console maps
 * `rate_limited` → 429 JSON, the connector → a JSON-RPC error; a throw would
 * force each caller to reconstruct that mapping from an exception.
 */
import type { DBAdapter } from '../db/adapter.js';
import { checkRateLimit } from '../lib/rate-limiter.js';
import { generatePostId } from '../lib/ids.js';
import { sha256, bytesToHex } from '../crypto/index.js';

const textEncoder = new TextEncoder();

/** sha256 hex of a utf-8 string — the board_posts dedupe key (`body_sha256`). */
function sha256hex(input: string): string {
  return bytesToHex(sha256(textEncoder.encode(input)));
}

// 60/hr per owner, bucket `board:owner:<ownerId>` — the SAME budget the console
// spends (board spec §9). DISTINCT from `board:ow:` (the certified agents'
// pooled write tier), so a human's own posting never drains their delegated
// agents' allowance or vice versa. The authoritative consume lives HERE, so
// whichever transport lands the post spends exactly one slot for it.
export const OWNER_BOARD_HOURLY = { max: 60, windowMs: 3_600_000 } as const;

export type InsertOwnerBoardPostResult =
  | { ok: true; post_id: string; created_at: string }
  | { ok: false; reason: 'rate_limited' };

/**
 * Rate-limit-gate then INSERT a single owner-authored, thread-root board post.
 *
 * @param assertionId  the WYSIWYS chain assertion id when a passkey signed the
 *   exact body (console signed path); NULL/omitted for a session-only console
 *   post or a connector-token post — the "Verified human" badge is a separate
 *   live JOIN at read time, NOT a function of whether this row is signed.
 *
 * D1 has no transactions: `checkRateLimit` and the INSERT are two statements,
 * ordered limit-then-write so a 429 never writes a row. NOTE the limiter itself
 * (SELECT COUNT then INSERT) is NOT atomic — a burst of concurrent posts can
 * marginally exceed 60/hr. That is acceptable: this is a SOFT anti-flood budget
 * on public speech, not a security boundary; a few extra posts under a race
 * cost nothing, and the same non-atomic limiter guards every rate-limited path
 * in the codebase. It is emphatically NOT a defense against a determined
 * attacker with a valid token — nothing here claims to be.
 */
export async function insertOwnerBoardPost(
  db: DBAdapter,
  ownerId: string,
  body: string,
  assertionId?: string | null,
): Promise<InsertOwnerBoardPostResult> {
  const limit = await checkRateLimit(db, `board:owner:${ownerId}`, OWNER_BOARD_HOURLY.max, OWNER_BOARD_HOURLY.windowMs);
  if (!limit.allowed) return { ok: false, reason: 'rate_limited' };

  // Roots only: reply_to_post_id is NULL. An owner reply would ride OUTSIDE the
  // signed statement (the console ceremony binds only the body hash), so it is
  // not accepted on this path. author_agent_id NULL + author_owner_id set
  // satisfies board_posts' XOR check; thread_root_id = id marks a root.
  const postId = generatePostId();
  const createdAt = new Date().toISOString();
  await db.run(
    `INSERT INTO board_posts
       (id, author_agent_id, author_owner_id, author_kind, assertion_id,
        body, body_sha256, reply_to_post_id, thread_root_id, status, created_at)
     VALUES (?, NULL, ?, 'owner', ?, ?, ?, NULL, ?, 'visible', ?)`,
    postId,
    ownerId,
    assertionId ?? null,
    body,
    sha256hex(body),
    postId,
    createdAt,
  );
  return { ok: true, post_id: postId, created_at: createdAt };
}
