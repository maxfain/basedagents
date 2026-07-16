-- Keyring control plane: account recovery (CONTROL_PLANE.md §6).
-- PROPRIETARY control-plane migration — see packages/api/src/control/LICENSE.
--
-- Recovery is semi-custodial AUTHORITY rotation only: an emailed magic-link
-- token (mailbox factor) plus an offline one-time recovery code (possession
-- factor) — both required, neither sufficient — authenticate enrolling a NEW
-- passkey, which revokes every other passkey and all live sessions. The
-- Ed25519 confidentiality key, the vault binding, and all ciphertext are never
-- touched by recovery.

-- Passkeys become revocable (rotation revokes all but the newly enrolled one).
ALTER TABLE owner_webauthn_credentials ADD COLUMN status TEXT NOT NULL DEFAULT 'active'; -- active | revoked
ALTER TABLE owner_webauthn_credentials ADD COLUMN revoked_at DATETIME;

-- One-time recovery codes. Only the sha256 hex of the code is stored; the
-- plaintext is shown exactly once at generation. Generating a new code
-- supersedes any open one, so at most one code is redeemable per owner.
CREATE TABLE IF NOT EXISTS owner_recovery_codes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,                -- sha256 hex of the normalized code
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  used_at DATETIME,                              -- consumed by a completed recovery
  superseded_at DATETIME                         -- replaced by a newer code
);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_owner ON owner_recovery_codes(owner_id);

-- Magic-link tokens (the mailbox factor). Only the sha256 hex is stored; the
-- token itself travels in the emailed link's URL fragment. Short-lived,
-- single-use (atomic conditional consume, CONTROL_PLANE.md §4).
CREATE TABLE IF NOT EXISTS owner_recovery_tokens (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,               -- sha256 hex of the token
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_recovery_tokens_owner ON owner_recovery_tokens(owner_id);
