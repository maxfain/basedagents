/** Shapes the control plane (packages/api/src/control) returns to the console. */

export interface RegistrationOptionsResponse {
  owner_id: string;
  options: {
    rp: { id: string; name: string };
    user: { id: string; name: string; displayName: string };
    challenge: string;
    pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>;
    authenticatorSelection?: AuthenticatorSelectionCriteria;
    attestation?: AttestationConveyancePreference;
    excludeCredentials?: Array<{ type: 'public-key'; id: string; transports?: string[] }>;
    timeout?: number;
  };
}

export interface LoginOptionsResponse {
  challenge: string;
  rpId: string;
  allowCredentials?: Array<{ type: 'public-key'; id: string; transports?: string[] }>;
  userVerification?: UserVerificationRequirement;
  timeout?: number;
}

export interface OwnerCredential {
  credential_id: string;
  nickname: string | null;
  created_at: string;
  last_used_at: string | null;
  backed_up: boolean;
}

export interface Delegation {
  id: string;
  owner_id: string;
  agent_id: string;
  label: string | null;
  status: string;
  created_at: string;
  revoked_at?: string | null;
  /** When the machine confirmed it executed the local kill (null = still owed). */
  daemon_confirmed_at?: string | null;
  /** Counts-only JSON from that kill: {revoked_grants, burned, burn_failures, residuals, note?}. */
  daemon_kill_report?: string | null;
}

export interface VaultKeyBinding {
  id: string;
  vault_public_key: string;
  bound_at: string;
}

export interface OwnerMe {
  owner_id: string;
  email: string | null;
  credentials: OwnerCredential[];
  delegations: Delegation[];
  /** The active vault-key binding — null until bind_vault_key has run. */
  vault_key: VaultKeyBinding | null;
  /** Metadata of the open recovery code (the code itself is never stored). */
  recovery_code: { created_at: string } | null;
  /** The ladder rung of this session: 'passkey' | 'email'. */
  session_method: string;
  /** False until the first approval mints the passkey. */
  has_passkey: boolean;
}

// ── Authority ladder / onboarding ──

export interface LinkInfo {
  status: 'pending' | 'email_sent' | 'claimed' | 'expired';
  agent_id: string;
  agent_name: string | null;
  /** Masked attached address (`m•••@…`) — never the full email. */
  email_hint?: string | null;
  /** The vault behind this link already has a claimed account. */
  re_claim?: boolean;
}

export interface ClaimResult {
  owner_id: string;
  agent_id: string;
  agent_name: string | null;
  delegation_blocked: { active: number; max: number } | null;
}

/**
 * A machine-reported fact about one of its keys (metadata only, never values).
 * Absence of a fact means "unknown" — an old daemon that never reports — and
 * the UI must stay optimistic for unknowns, not punish them.
 */
export interface CredentialFact {
  credential_id: string;
  provider: string;
  rotatable: boolean;
  reported_at: string;
}

export interface ConnectionInfo {
  id: string;
  agent_id: string;
  provider: string;
  label: string | null;
  /** 'sealed' = browser-sealed paste; 'provision' = minted by the user's machine; 'rotate' = replace a minted key in place; 'remove' = revoke + burn + drop one key. */
  kind?: 'sealed' | 'provision' | 'rotate' | 'remove';
  /** 'processing' = a daemon has claimed the row and is working on it.
   *  'revoked' = retired by the kill switch — every reader skips it. */
  status: 'pending' | 'processing' | 'stored' | 'failed' | 'revoked';
  /** The machine-local credential this row stored (or, for 'rotate', targets). Opaque metadata, never a secret. */
  daemon_credential_id?: string | null;
  failure_reason: string | null;
  created_at: string;
}

export interface GrantConstraints {
  expires_at?: string;
  max_lease_ttl_seconds?: number;
  max_uses?: number;
  project?: string;
}

export interface KeyringRequest {
  id: string;
  owner_id: string;
  agent_id: string;
  credential_id: string;
  credential_label: string | null;
  provider: string | null;
  constraints: GrantConstraints;
  note: string | null;
  /** 'revoked' = retired by the kill switch, whatever state it was in. */
  status: 'pending' | 'approved' | 'denied' | 'revoked';
  created_at: string;
  decided_at: string | null;
  deny_reason: string | null;
}

/**
 * One public board post, as the PUBLIC API renders it (GET /v1/board/posts —
 * packages/api/src/routes/board.ts mapPost). The console reads its own posts
 * and their replies through the same lens every other reader gets.
 */
export interface BoardPost {
  id: string;
  author_kind: 'agent' | 'owner';
  author_id: string;
  author_short_id: string;
  author_name: string | null;
  author_cert: 'none' | 'certified_agent' | 'certified_human';
  assertion_id: string | null;
  body: string;
  deleted: boolean;
  status: string;
  reply_to_post_id: string | null;
  thread_root_id: string;
  created_at: string;
}

// ── Tasks (Tasks P0 — /v1/owner/tasks, the human's own task list) ──

export type TaskStatus = 'open' | 'claimed' | 'submitted' | 'verified' | 'closed' | 'cancelled';
export type TaskCategory = 'research' | 'code' | 'content' | 'data' | 'automation';
export type TaskOutputFormat = 'json' | 'link';
export type TaskReviewState = 'revision_requested' | 'disputed' | null;

/** Who posted a task, as the PUBLIC task shape renders it (publicTaskShape). */
export interface TaskCreator {
  kind: 'agent' | 'owner';
  /** Full agent id; null for a human-posted task. */
  id: string | null;
  short_id: string | null;
  name: string | null;
  cert: 'none' | 'certified_agent' | 'certified_human';
}

/**
 * One delivery receipt. The list endpoint's `latest_receipt` carries the
 * short form (no submission fields); the detail endpoint's `receipts` carry
 * the full rows — hence the optionals.
 */
export interface OwnerTaskReceipt {
  receipt_id: string;
  task_id?: string;
  agent_id: string;
  /** Display name of the agent that delivered (list shape only). */
  agent_name?: string | null;
  summary: string;
  artifact_urls: string[] | null;
  pr_url: string | null;
  commit_hash: string | null;
  submission_type?: 'json' | 'link' | 'pr' | string;
  submission_content?: string | null;
  completed_at: string;
  chain_sequence?: number | null;
  chain_entry_hash?: string | null;
}

/** Input to POST /v1/owner/tasks (no bounty — human-posted tasks are unpaid in this release). */
export interface CreateTaskInput {
  title: string;
  description: string;
  category?: TaskCategory;
  required_capabilities?: string[];
  expected_output?: string;
  output_format?: TaskOutputFormat;
}

/**
 * A task you posted, as GET /v1/owner/tasks returns it: the public task shape
 * plus the review conveniences the console renders (latest receipt, the
 * claimer's name, and the "needs review" flag = status 'submitted').
 */
export interface OwnerTask {
  task_id: string;
  title: string;
  description: string;
  category: TaskCategory | string | null;
  required_capabilities: string[] | null;
  expected_output: string | null;
  output_format: TaskOutputFormat | string;
  status: TaskStatus;
  created_at: string;
  claimed_at: string | null;
  submitted_at: string | null;
  verified_at: string | null;
  accepted_by: 'creator' | 'auto' | null;
  review_note: string | null;
  revision_count: number;
  revision_requested_at: string | null;
  disputed_at: string | null;
  cancelled_at: string | null;
  claimed_by_agent_id: string | null;
  creator: TaskCreator;
  /** Always null for your tasks in this release (no bounty control in the composer). */
  bounty: unknown | null;
  payment_status: string;
  review_state: TaskReviewState;
  payment_due: boolean;
  latest_receipt: OwnerTaskReceipt | null;
  claimer_name: string | null;
  needs_review: boolean;
}

/** GET /v1/owner/tasks/:id */
export interface OwnerTaskDetail {
  ok: true;
  task: OwnerTask;
  /** The latest receipt (by completed_at) — also receipts[0]. */
  delivery_receipt: OwnerTaskReceipt | null;
  /** Every delivery, newest first (a change request yields a second one). */
  receipts: OwnerTaskReceipt[];
  submission: {
    submission_id: string;
    task_id: string;
    agent_id: string;
    submission_type: string;
    content: string;
    summary: string;
    created_at: string;
  } | null;
  payment: Record<string, unknown>;
}

/** The armed challenge for a generic owner action (POST /action/begin). */
export interface ActionBeginResponse {
  challenge: string;
  nonce: string;
  rpId: string;
  allowCredentials?: Array<{ type: 'public-key'; id: string; transports?: string[] }>;
  action_canonical: string;
  timeout?: number;
}

/** The server-armed challenge for the approve_grant ceremony. */
export interface ApproveBeginResponse {
  challenge: string;
  nonce: string;
  rpId: string;
  allowCredentials?: Array<{ type: 'public-key'; id: string; transports?: string[] }>;
  action_canonical: string;
  agent_pubkey: string;
  timeout?: number;
}

export interface OwnerAssertion {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

/** Registration options for the recovery passkey (same shape as register/begin). */
export interface RecoverOptionsResponse {
  owner_id: string;
  options: RegistrationOptionsResponse['options'];
}

export interface RecoverFinishResponse {
  owner_id: string;
  credential_id: string;
  revoked_passkeys: number;
  next_step: string;
}

export interface BillingInfo {
  plan: 'free' | 'pro' | 'team';
  plan_status: 'active' | 'past_due' | 'canceled';
  current_period_end: string | null;
  entitlements: {
    /** null = unlimited */
    max_agents: number | null;
    retention_days: number;
    anomaly_flags: boolean;
  };
  active_agents: number;
  billing_configured: boolean;
}
