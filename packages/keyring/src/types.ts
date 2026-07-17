/**
 * Keyring object model — see KEYRING_SPEC.md §3.
 *
 * Identity     — exists in BasedAgents already (Ed25519 keypair, ag_ ID). Keyring adds none.
 * Credential   — encrypted secret material + metadata. Secret exists only as sealed boxes.
 * Grant        — the binding (identity, credential, constraints).
 * Lease        — short-lived, in-memory delivery of a secret to a running agent.
 * AccessEvent  — append-only signed record of every access and admin operation.
 */

// ─── Identity ───

/** A known identity the owner can grant credentials to. The agent_id itself encodes the pubkey. */
export interface KnownIdentity {
  agent_id: string;
  /** Friendly local name, e.g. "ci-bot". Unique within the vault when set. */
  name?: string;
  /**
   * Optional local path to the agent's keypair file, so `based run --agent ci-bot`
   * can act as the agent without an explicit --keypair flag. A path only —
   * private key material never enters the vault.
   */
  keypair_path?: string;
  added_at: string;
}

// ─── Credential ───

export interface CredentialMeta {
  /** Human label, e.g. "Supabase service-role key (acme-prod)". */
  label: string;
  /** Provider slug, e.g. "supabase", "stripe", "github". */
  provider?: string;
  /** Environment variable name used for CLI env injection, e.g. "SUPABASE_SERVICE_ROLE_KEY". */
  env_var?: string;
  /** Scope descriptor, e.g. "read-only", "repo:acme/site". */
  scope?: string;
  /** Free-form rotation policy note, e.g. "rotate every 90d". */
  rotation_policy?: string;
  /** Provider-side key ID if known — enables future Provisioner burn/rotate. */
  provider_key_id?: string;
}

export interface Credential extends CredentialMeta {
  credential_id: string;
  created_at: string;
  updated_at: string;
  /**
   * agent_id → base64 sealed box of the secret value.
   * Always contains the owner's copy; plus one per identity with an active grant.
   * This is the ONLY place secret material exists, and it is always ciphertext.
   */
  sealed: Record<string, string>;
}

/** Credential without sealed material — safe to display/serialize anywhere. */
export type CredentialPublic = Omit<Credential, 'sealed'>;

// ─── Grant ───

export interface GrantConstraints {
  /** ISO timestamp after which the grant no longer authorizes leases. */
  expires_at?: string;
  /** Max lease TTL in seconds. Leases are clamped to min(requested, this, 900 default). */
  max_lease_ttl_seconds?: number;
  /** Max number of successful leases before the grant stops authorizing. */
  max_uses?: number;
  /** Project tag for filtering/audit. */
  project?: string;
  /**
   * Escape hatch (Custody Fix 1). When false/absent, `keyring_lease` refuses to
   * hand the raw secret to the model — the agent must use `keyring_run` /
   * `keyring_render`, so the value never enters the conversation transcript.
   * The owner may set this true per-grant in the console to allow raw leasing;
   * the lease tool then returns the value behind a loud warning banner.
   */
  unsafe_value_release?: boolean;
}

export interface Grant {
  grant_id: string;
  agent_id: string;
  credential_id: string;
  constraints: GrantConstraints;
  status: 'active' | 'revoked';
  use_count: number;
  created_at: string;
  revoked_at?: string;
  revoke_reason?: string;
}

// ─── Grant requests (approvals inbox) ───

export interface GrantRequest {
  request_id: string;
  agent_id: string;
  provider: string;
  scope?: string;
  note?: string;
  status: 'pending' | 'approved' | 'denied';
  created_at: string;
  resolved_at?: string;
  /** Set when approved. */
  credential_id?: string;
  grant_id?: string;
  deny_reason?: string;
}

// ─── Lease ───

/** Default and maximum-by-default lease TTL: 15 minutes (KEYRING_SPEC §3). */
export const DEFAULT_LEASE_TTL_SECONDS = 900;

/**
 * A live lease. `value` is the decrypted secret — in memory only, never written
 * to disk, never logged. Callers must treat it as expired after `expires_at`.
 */
export interface Lease {
  lease_id: string;
  credential: CredentialPublic;
  grant_id: string;
  agent_id: string;
  value: string;
  ttl_seconds: number;
  issued_at: string;
  expires_at: string;
  access_event_id: string;
}

// ─── AccessEvent ───

export type AccessEventType =
  | 'vault_created'
  | 'identity_added'
  | 'identity_removed'
  | 'credential_added'
  | 'credential_updated'
  | 'credential_removed'
  | 'grant_created'
  | 'grant_revoked'
  | 'kill_switch'
  | 'lease'
  | 'lease_denied'
  | 'run'
  | 'render'
  | 'request_created'
  | 'request_approved'
  | 'request_denied'
  | 'passkey_anchored'
  | 'passkey_removed';

/**
 * Append-only signed record (KEYRING_SPEC §3):
 * { agent_pubkey, agent_signature, credential_id, grant_id, timestamp, requesting_context }
 * plus hash-chain fields. `signed_payload` is the exact canonical JSON string the
 * actor signed, so every event is independently verifiable from the log alone.
 */
export interface AccessEvent {
  event_id: string;
  sequence: number;
  timestamp: string;
  event_type: AccessEventType;
  /** base58 Ed25519 pubkey of the actor (agent for leases/requests, owner for admin ops). */
  agent_pubkey: string;
  /** base64 Ed25519 signature over `signed_payload`. */
  agent_signature: string;
  /** The exact canonical JSON string that was signed. */
  signed_payload: string;
  credential_id: string | null;
  grant_id: string | null;
  requesting_context: string | null;
  /** Extra structured info (constraints, reasons, labels). Never secret values. */
  detail: Record<string, unknown> | null;
  prev_hash: string;
  entry_hash: string;
}

// ─── Owner passkey anchor (control plane, KEYRING_SPEC §5 / CONTROL_PLANE.md §2) ───

/**
 * A locally-anchored owner WebAuthn passkey — the *authority* root the daemon
 * trusts when applying a control-plane-relayed approval. Anchored at a trusted
 * moment (the owner runs `based link` and confirms), NOT silently fetched from
 * the control plane, so a compromised control plane cannot substitute it.
 * Only the public key is stored; the passkey's private key never leaves the
 * authenticator.
 */
export interface OwnerPasskey {
  /** base64url WebAuthn credential id. */
  credential_id: string;
  /** Uncompressed P-256 public key (0x04‖x‖y), hex-encoded. */
  public_key_hex: string;
  /** WebAuthn RP ID this passkey verifies under, e.g. "basedagents.ai". */
  rp_id: string;
  /** Allowed WebAuthn origins, e.g. ["https://app.basedagents.ai"]. */
  origins: string[];
  nickname?: string;
  anchored_at: string;
}

/** A WebAuthn assertion produced by the owner's passkey in the console/browser. */
export interface OwnerAssertion {
  /** base64url WebAuthn credential id — must match an anchored passkey. */
  credentialId: string;
  authenticatorData: string; // base64url
  clientDataJSON: string;    // base64url
  signature: string;         // base64url (ASN.1 DER ECDSA)
}

/**
 * A control-plane-relayed grant approval the daemon applies. Every field is
 * bound by the owner's passkey signature: the daemon re-derives the action hash
 * from these values (plus its own owner id and the grantee's on-file pubkey) and
 * rejects the approval unless the assertion signed exactly that hash. So a
 * tampered agent, credential, or constraint set fails verification.
 */
export interface GrantApproval {
  /** Server-issued per-ceremony nonce (single-use at the daemon). */
  nonce: string;
  /** The exact credential the owner approved (must exist in the vault). */
  credential_id: string;
  /** The grantee agent id the owner approved. */
  agent_id: string;
  constraints: GrantConstraints;
  assertion: OwnerAssertion;
}

// ─── Vault file ───

export interface VaultFile {
  version: 1;
  created_at: string;
  owner: {
    agent_id: string;
    public_key_b58: string;
  };
  identities: Record<string, KnownIdentity>;
  credentials: Record<string, Credential>;
  grants: Record<string, Grant>;
  requests: Record<string, GrantRequest>;
  /** Anchored owner passkeys (control plane authority roots). Absent in pre-§5 vaults. */
  owner_passkeys?: Record<string, OwnerPasskey>;
  /** Approval nonces already applied — single-use guard against replaying a relayed approval. */
  applied_approval_nonces?: string[];
}

// ─── Views ───

export interface AgentSummary {
  agent_id: string;
  name?: string;
  is_owner: boolean;
  added_at?: string;
  active_grants: number;
  revoked_grants: number;
  total_leases: number;
  last_access?: string;
  /** Lease counts per day, oldest → newest (for the admin sparkline). */
  daily_leases: number[];
  grants: Array<Grant & { credential_label: string }>;
}

export interface CredentialSummary extends CredentialPublic {
  holders: Array<{
    agent_id: string;
    name?: string;
    grant_id: string;
    status: Grant['status'];
    constraints: GrantConstraints;
    use_count: number;
    last_leased?: string;
  }>;
}

export interface AgentCredentialView {
  credential_id: string;
  label: string;
  provider?: string;
  env_var?: string;
  scope?: string;
  grant_id: string;
  constraints: GrantConstraints;
  use_count: number;
}

export interface TimelineFilter {
  agent?: string;
  credential_id?: string;
  event_type?: AccessEventType;
  project?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface VerifyLogResult {
  ok: boolean;
  events_checked: number;
  head?: { sequence: number; entry_hash: string };
  errors: Array<{ sequence: number; event_id?: string; error: string }>;
}

export interface SignedLogExport {
  format: 'basedagents-keyring-log/v1';
  exported_at: string;
  vault_owner: { agent_id: string; public_key_b58: string };
  head: { sequence: number; entry_hash: string } | null;
  events: AccessEvent[];
  /** sha256 hex of canonical JSON of `events`. */
  events_hash: string;
  /** Owner signature over canonical {format, exported_at, vault_owner, head, events_hash}. */
  export_signature: string;
}
