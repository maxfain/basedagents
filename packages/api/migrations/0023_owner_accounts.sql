-- Keyring control plane: owner accounts, WebAuthn passkeys, delegations.
-- KEYRING_SPEC v0.2 §5 · see CONTROL_PLANE.md for the authority model.
--
-- PROPRIETARY control-plane schema. Not covered by the repo's Apache-2.0 grant.
-- See LICENSING.md. Lives in the shared agent-registry D1 because the
-- owner->agent delegation edge references the (open) agents table.

-- Owners: the accountable human. ow_-prefixed first-class identity.
-- The Ed25519 vault key (owner_vault_keys) is the CONFIDENTIALITY root and lives
-- in the local vault daemon; the passkeys (owner_webauthn_credentials) are the
-- AUTHORITY root. Email is notifications + recovery ONLY, never authentication.
CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY,                          -- ow_<base58(vault_ed25519_pub)>
  email TEXT UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',         -- active | suspended | closed
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- WebAuthn passkeys (authority root). One row per registered authenticator.
-- public_key is the COSE key (ES256: P-256 x/y). signature_counter is enforced
-- monotonic via an atomic conditional UPDATE (see CONTROL_PLANE.md §4).
CREATE TABLE IF NOT EXISTS owner_webauthn_credentials (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,            -- base64url WebAuthn credential id
  public_key BLOB NOT NULL,                      -- COSE public key bytes
  signature_counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,                               -- JSON array
  aaguid TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  nickname TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME
);

-- Binds the owner's Ed25519 vault (confidentiality) key to the owner, attested
-- by a WebAuthn assertion. Resolves "the passkey is the root key": the authority
-- key attests the confidentiality key. Anchored locally by the daemon.
CREATE TABLE IF NOT EXISTS owner_vault_keys (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  vault_public_key TEXT NOT NULL,                -- base58 Ed25519 pubkey
  status TEXT NOT NULL DEFAULT 'active',          -- active | rotated
  binding_assertion_id TEXT,                      -- action_assertions.id that authorized the binding
  bound_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  rotated_at DATETIME,
  UNIQUE(owner_id, vault_public_key)
);

-- Server-issued, single-use WebAuthn challenges (registration / login / action).
-- consumed_at nullable so consumption is an atomic conditional UPDATE.
-- action_hash pins the exact action a purpose='action' assertion authorizes.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  owner_id TEXT REFERENCES owners(id) ON DELETE CASCADE,   -- null during signup
  challenge TEXT NOT NULL UNIQUE,                 -- base64url random
  purpose TEXT NOT NULL,                          -- register | login | action
  action_type TEXT,                               -- for action: e.g. approve_grant, revoke_grant, kill_switch
  action_hash TEXT,                               -- for action: sha256 of canonical action payload
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME
);

-- "Sessions to look": httpOnly SameSite=Strict cookie. Read-only browsing.
-- Only the token hash is stored; the token itself is never persisted.
CREATE TABLE IF NOT EXISTS owner_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,                -- sha256 of the session token
  credential_id TEXT,                             -- which passkey logged in
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME,
  last_seen_at DATETIME,
  user_agent TEXT,
  ip_hash TEXT
);

-- "Signatures to act": append-only, hash-chained record of every owner WebAuthn
-- action assertion. The human-authority evidence. Each mutating row (delegation,
-- grant, binding) references the assertion that authorized it.
CREATE TABLE IF NOT EXISTS action_assertions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL,                    -- passkey that signed
  action_type TEXT NOT NULL,
  action_hash TEXT NOT NULL,                      -- sha256 of the canonical action payload
  authenticator_data TEXT NOT NULL,              -- base64url
  client_data_json TEXT NOT NULL,                -- base64url
  signature TEXT NOT NULL,                        -- base64url WebAuthn signature
  sequence INTEGER NOT NULL,                      -- per-owner monotonic chain sequence
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_id, sequence)
);

-- Delegation edge: owner -> agent. "Whose agent is this?" Authorized by an
-- owner WebAuthn action assertion. agent_id references the (open) registry.
CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,                            -- del_<...>
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active',           -- active | revoked
  authorizing_assertion_id TEXT NOT NULL REFERENCES action_assertions(id),
  revoke_assertion_id TEXT REFERENCES action_assertions(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME,
  UNIQUE(owner_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_owner_webauthn_owner ON owner_webauthn_credentials(owner_id);
CREATE INDEX IF NOT EXISTS idx_owner_vault_keys_owner ON owner_vault_keys(owner_id);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_owner_sessions_owner ON owner_sessions(owner_id);
CREATE INDEX IF NOT EXISTS idx_owner_sessions_token ON owner_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_action_assertions_owner ON action_assertions(owner_id);
CREATE INDEX IF NOT EXISTS idx_delegations_owner ON delegations(owner_id);
CREATE INDEX IF NOT EXISTS idx_delegations_agent ON delegations(agent_id);
