-- Keyring control plane: approvals inbox + grant approvals ready for the daemon.
-- KEYRING_SPEC v0.2 §5 · CONTROL_PLANE.md §2 (grant flow) / §2.1 (canonical).
--
-- PROPRIETARY control-plane schema (see LICENSING.md).
--
-- Flow: an agent (or owner) files a keyring_request for a credential grant. The
-- owner approves it in the console with a fresh WebAuthn assertion over the
-- grant-approval canonical (which pins the grantee pubkey). That produces a
-- grant_approvals row the daemon pulls, verifies locally, applies, and confirms.
-- The control plane never sees a secret; grant_approvals holds metadata + the
-- owner assertion only.

-- Approvals inbox: a request to grant `credential_id` to `agent_id`.
CREATE TABLE IF NOT EXISTS keyring_requests (
  id TEXT PRIMARY KEY,                           -- req_<...>
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- The credential is identified by the id the daemon reported (credentials are
  -- the daemon's; the control plane holds label/provider metadata only).
  credential_id TEXT NOT NULL,
  credential_label TEXT,
  provider TEXT,
  -- Requested constraints (JSON): expires_at, max_lease_ttl_seconds, max_uses, project.
  constraints TEXT NOT NULL DEFAULT '{}',
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | approved | denied
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  decided_at DATETIME,
  decision_assertion_id TEXT REFERENCES action_assertions(id),
  deny_reason TEXT
);

-- An owner-approved grant, ready for the daemon to apply and confirm. Carries
-- exactly the fields the daemon re-derives the action hash from (§2.1) plus the
-- owner WebAuthn assertion that signed it, so the daemon can verify offline.
CREATE TABLE IF NOT EXISTS grant_approvals (
  id TEXT PRIMARY KEY,                           -- gap_<...>
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES keyring_requests(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  agent_pubkey TEXT NOT NULL,                      -- base58 Ed25519 — the pinned sealing target
  credential_id TEXT NOT NULL,
  constraints TEXT NOT NULL,                       -- JSON, the exact approved constraints
  nonce TEXT NOT NULL UNIQUE,                      -- per-ceremony, single-use
  action_hash TEXT NOT NULL,                       -- base64url(sha256(canonical)) — for cross-checks
  -- The owner passkey assertion (base64url parts) — what the daemon verifies.
  assertion_credential_id TEXT NOT NULL,
  authenticator_data TEXT NOT NULL,
  client_data_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  assertion_id TEXT NOT NULL REFERENCES action_assertions(id),
  status TEXT NOT NULL DEFAULT 'pending_daemon',   -- pending_daemon | confirmed | failed
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  confirmed_at DATETIME,
  daemon_grant_id TEXT,                            -- the grant id the daemon reported on confirm
  failure_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_keyring_requests_owner ON keyring_requests(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_keyring_requests_agent ON keyring_requests(agent_id);
CREATE INDEX IF NOT EXISTS idx_grant_approvals_owner ON grant_approvals(owner_id, status);
