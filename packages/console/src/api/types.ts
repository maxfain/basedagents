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
}

export interface ClaimResult {
  owner_id: string;
  agent_id: string;
  agent_name: string | null;
  delegation_blocked: { active: number; max: number } | null;
}

export interface ConnectionInfo {
  id: string;
  agent_id: string;
  provider: string;
  label: string | null;
  /** 'sealed' = browser-sealed paste; 'provision' = minted by the user's machine. */
  kind?: 'sealed' | 'provision';
  /** 'processing' = a daemon has claimed the row and is working on it. */
  status: 'pending' | 'processing' | 'stored' | 'failed';
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
  status: 'pending' | 'approved' | 'denied';
  created_at: string;
  decided_at: string | null;
  deny_reason: string | null;
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
