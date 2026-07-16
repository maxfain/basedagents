/**
 * Control-plane action contract — the canonical statements an owner's WebAuthn
 * passkey signs to authorize a privileged action, shared by the hosted control
 * plane and the local vault daemon.
 *
 * Both sides MUST produce byte-identical canonical JSON for the same action, or
 * their action hashes won't agree and the daemon will (correctly) reject the
 * approval. This module is the single source of truth for that format; the
 * control plane implements the matching side. See CONTROL_PLANE.md §2.
 *
 * The grant-approval statement pins the exact sealing target — the grantee
 * agent's public key — so a compromised control plane cannot redirect the seal
 * to an attacker key without invalidating the owner's signature.
 */

import { sha256 } from '@noble/hashes/sha256';
import { canonicalJsonStringify, base58Encode } from './util.js';
import type { GrantConstraints } from './types.js';

// ─── base64url ───

export function base64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The WebAuthn challenge that binds an assertion to an exact action:
 * base64url(sha256(utf8(canonicalAction))), unpadded. Identical to the control
 * plane's actionChallenge — the value is both the challenge and the action_hash.
 */
export function actionChallenge(canonicalAction: string): string {
  return base64urlEncode(sha256(new TextEncoder().encode(canonicalAction)));
}

// ─── Canonical statements ───

/** Only the constraint keys that are set, so both sides serialize identically. */
function normalizeConstraints(c: GrantConstraints): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c.expires_at !== undefined) out.expires_at = c.expires_at;
  if (c.max_lease_ttl_seconds !== undefined) out.max_lease_ttl_seconds = c.max_lease_ttl_seconds;
  if (c.max_uses !== undefined) out.max_uses = c.max_uses;
  if (c.project !== undefined) out.project = c.project;
  return out;
}

export interface GrantApprovalStatement {
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
 * Canonical JSON for "the owner approves granting `credential_id` to `agent_id`
 * (pubkey `agent_pubkey`) under `constraints`". The agent's public key is pinned
 * so the daemon can confirm the signed approval names exactly the key it is
 * about to seal to.
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

/** Convenience: the action hash the owner passkey signs for a grant approval. */
export function grantApprovalHash(s: GrantApprovalStatement): string {
  return actionChallenge(grantApprovalCanonical(s));
}

/** Derive the pinned agent pubkey (base58) from an agent id — used to build the statement. */
export { base58Encode };
