/**
 * Grant-approval action contract — control-plane side.
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * This is the control plane's implementation of the canonical statement the
 * owner's WebAuthn passkey signs to approve a credential grant (CONTROL_PLANE.md
 * §2.1). The SINGLE SOURCE OF TRUTH for the format is the daemon's
 * `packages/keyring/src/control-actions.ts` (`grantApprovalCanonical`); this file
 * MUST produce BYTE-IDENTICAL canonical JSON and the SAME action hash for the
 * same inputs, or the daemon (which re-derives and re-verifies the hash before it
 * seals) will correctly reject the approval. The interop test
 * (`approvals.test.ts`) enforces that parity against the real keyring package.
 *
 * We DELIBERATELY do NOT import from @basedagents/keyring at runtime: its
 * top-level module pulls in node:fs (VaultStore) and will not bundle in the
 * Cloudflare Worker. Instead we reimplement the pure function here over the
 * control plane's own primitives — `canonicalJsonStringify` (identical algorithm
 * to keyring's) and `actionChallenge` (base64url(sha256(utf8(canonical))),
 * unpadded) — and let the test prove the two are equal.
 */
import { canonicalJsonStringify } from '../crypto/index.js';
import { actionChallenge } from './webauthn.js';

/**
 * The four grant constraint keys the contract recognizes. Only SET keys are
 * serialized (see {@link normalizeConstraints}), so both sides agree byte-for-byte
 * regardless of which constraints are present.
 */
export interface GrantConstraints {
  /** ISO timestamp after which the grant no longer authorizes leases. */
  expires_at?: string;
  /** Max lease TTL in seconds. */
  max_lease_ttl_seconds?: number;
  /** Max number of successful leases before the grant stops authorizing. */
  max_uses?: number;
  /** Project tag for filtering/audit. */
  project?: string;
}

export interface GrantApprovalStatement {
  /** The vault owner id (the value the daemon re-derives — CONTROL_PLANE.md §2.1). */
  owner_id: string;
  /** Server-issued per-ceremony nonce — makes each approval's action_hash unique. */
  nonce: string;
  /** The grantee agent identity. */
  agent_id: string;
  /** The grantee's Ed25519 public key (base58) — the pinned sealing target. */
  agent_pubkey: string;
  credential_id: string;
  constraints: GrantConstraints;
}

/**
 * Only the constraint keys that are set, so both sides serialize identically.
 * This mirrors keyring's `normalizeConstraints` EXACTLY (same four keys, same
 * `!== undefined` guard). Any extra keys on the input object are dropped, so a
 * caller cannot smuggle unsigned fields into the signed action.
 */
function normalizeConstraints(c: GrantConstraints): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c.expires_at !== undefined) out.expires_at = c.expires_at;
  if (c.max_lease_ttl_seconds !== undefined) out.max_lease_ttl_seconds = c.max_lease_ttl_seconds;
  if (c.max_uses !== undefined) out.max_uses = c.max_uses;
  if (c.project !== undefined) out.project = c.project;
  return out;
}

/**
 * Canonical JSON for "the owner approves granting `credential_id` to `agent_id`
 * (pubkey `agent_pubkey`) under `constraints`". Field set and order are
 * irrelevant to the output (canonicalJsonStringify sorts keys) but are kept
 * identical to keyring's for readability. The agent's public key is pinned so the
 * daemon can confirm the signed approval names exactly the key it will seal to.
 */
export function grantApprovalCanonical(s: GrantApprovalStatement): string {
  return canonicalJsonStringify({
    action_type: 'approve_grant',
    owner_id: s.owner_id,
    nonce: s.nonce,
    agent_id: s.agent_id,
    agent_pubkey: s.agent_pubkey,
    credential_id: s.credential_id,
    constraints: normalizeConstraints(s.constraints),
  });
}

/** The action hash the owner passkey signs for a grant approval — also the WebAuthn challenge. */
export function grantApprovalHash(s: GrantApprovalStatement): string {
  return actionChallenge(grantApprovalCanonical(s));
}
