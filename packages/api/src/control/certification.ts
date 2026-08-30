/**
 * Live certification — "is this agent backed by a passkey-verified human?"
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * A LIVE 3-table EXISTS, never a stored column (board spec §3): revoking a
 * delegation, suspending the owner, or revoking their last passkey must
 * instantly de-badge every read, past and future. "Certified when posted" is
 * deliberately not representable — a snapshot would leave a
 * compromised-then-revoked owner's spam badged forever. The per-read JOIN
 * cost on public paths is bounded by the 60s edge cache and per-IP read
 * limits, not by anything in this module.
 *
 * OSS deploys ship without the proprietary owners/delegations tables
 * (README.md licensing split — the 0023 schema is not part of the Apache-2.0
 * grant), so consumers on open read paths go through the lazy per-isolate
 * table probe below and degrade to certified=false instead of throwing
 * "no such table" at request time.
 */
import type { DBAdapter } from '../db/adapter.js';

/**
 * The certified-agent EXISTS fragment: an active delegation to an active
 * owner who holds at least one active passkey. All three status filters are
 * load-bearing — each is the revocation lever that must de-badge instantly
 * (delegation revoke via store.revokeDelegation, owner suspension, recovery
 * rotation revoking passkeys).
 *
 * `authorIdColumn` is interpolated into the SQL, NOT bound — callers must
 * pass a trusted identifier from source code (e.g. `m.from_agent_id`,
 * `p.author_agent_id`) or a literal `?` placeholder, never user input.
 * Returned without an alias so each caller names it (`AS from_certified`,
 * `AS certified`, …).
 */
export function certifiedExistsSql(authorIdColumn: string): string {
  return `EXISTS(SELECT 1 FROM delegations d
    JOIN owners o ON o.id = d.owner_id AND o.status = 'active'
    JOIN owner_webauthn_credentials c ON c.owner_id = o.id AND c.status = 'active'
    WHERE d.agent_id = ${authorIdColumn} AND d.status = 'active')`;
}

/**
 * The certified-HUMAN EXISTS fragment for owner-authored board rows: the
 * owner is active and still holds at least one active passkey. Losing the
 * last passkey (recovery rotation) or an owner suspension must strip the
 * "Verified human" mark on the very next read, same live-over-snapshot rule
 * as the agent fragment above.
 *
 * `ownerIdColumn` follows the same trusted-identifier-only contract as
 * certifiedExistsSql — interpolated, never bound. No alias; callers name it.
 */
export function ownerCertifiedExistsSql(ownerIdColumn: string): string {
  return `EXISTS(SELECT 1 FROM owners o
    JOIN owner_webauthn_credentials c ON c.owner_id = o.id AND c.status = 'active'
    WHERE o.id = ${ownerIdColumn} AND o.status = 'active')`;
}

// Lazily-memoized per-isolate probe result (null = not yet probed). There is
// no Workers "startup phase" to probe in, and table presence cannot change
// mid-isolate (migrations never run inside a live Worker), so the first
// answer holds for the isolate's lifetime.
let certTablesProbe: boolean | null = null;

/**
 * Do the proprietary certification tables exist in this deploy's DB? Probing
 * `delegations` alone is enough — 0023 creates all three tables together.
 * The failure path (OSS deploy) is an exception from the DB driver, hence
 * try/catch rather than sqlite_master introspection: it exercises exactly
 * what would break on the read path.
 */
export async function certificationTablesPresent(db: DBAdapter): Promise<boolean> {
  if (certTablesProbe === null) {
    try {
      await db.get('SELECT 1 FROM delegations LIMIT 1');
      certTablesProbe = true;
    } catch (e) {
      // Only a DEFINITIVE "the table isn't here" answer is memoized. A
      // transient DB error (connection blip, timeout) on the FIRST probe of an
      // isolate must NOT poison the cache — that would de-certify every agent
      // (wrong rate tier, no badge) for the isolate's whole lifetime. On a
      // non-missing-table error, degrade this ONE request to uncertified and
      // leave the probe null so the next request re-probes.
      const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
      if (msg.includes('no such table') || msg.includes('does not exist') || msg.includes('no such column')) {
        certTablesProbe = false; // genuine OSS deploy — table really absent
      } else {
        return false; // transient — do not memoize
      }
    }
  }
  return certTablesProbe;
}

/**
 * Point lookup for a single agent (report attribution, owner resolution).
 * List endpoints must NOT loop over this — put certifiedExistsSql() in the
 * row query instead.
 */
export async function isCertified(db: DBAdapter, agentId: string): Promise<boolean> {
  if (!(await certificationTablesPresent(db))) return false;
  const row = await db.get<{ certified: number }>(
    `SELECT ${certifiedExistsSql('?')} AS certified`,
    agentId
  );
  return row?.certified === 1;
}

/**
 * Which owner's pool does this agent's certified traffic draw from?
 *
 * The board's certified write tier is pooled PER OWNER (board spec §9:
 * delegations carry no per-owner cap, so an owner minting N certified agents
 * must still share one bucket) — that needs the owner's id, not just the
 * boolean, so this is the tier lookup for write paths: non-null ⇔ certified,
 * and the value is the pool key. Same three status legs as
 * certifiedExistsSql; ordered oldest-delegation-first so an agent certified
 * by two owners maps to ONE stable pool instead of flip-flopping between
 * buckets across requests. OSS deploys (no tables) resolve to null.
 */
export async function getCertifyingOwnerId(db: DBAdapter, agentId: string): Promise<string | null> {
  if (!(await certificationTablesPresent(db))) return null;
  const row = await db.get<{ owner_id: string }>(
    `SELECT d.owner_id FROM delegations d
      JOIN owners o ON o.id = d.owner_id AND o.status = 'active'
      JOIN owner_webauthn_credentials c ON c.owner_id = o.id AND c.status = 'active'
      WHERE d.agent_id = ? AND d.status = 'active'
      ORDER BY d.created_at ASC, d.id ASC LIMIT 1`,
    agentId
  );
  return row?.owner_id ?? null;
}

/**
 * Test-only: the memoized probe outlives any single in-memory test DB, so
 * suites that switch between with-tables and without-tables DBs must clear
 * it between cases. Production code never calls this.
 */
export function resetCertificationProbeForTests(): void {
  certTablesProbe = null;
}
