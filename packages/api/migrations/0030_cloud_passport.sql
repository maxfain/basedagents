-- 0030: vault-less cloud agents (SANDBOX_SPEC §4b).
--
-- passport_handoffs: the one-shot, ciphertext-only channel that moves the
-- vault authority (owner + agent keypairs) from the container that birthed it
-- to the human's browser, sealed to an EPHEMERAL browser key. The control
-- plane never holds a passport it can open; the ciphertext is blanked the
-- moment the browser consumes it.
CREATE TABLE IF NOT EXISTS passport_handoffs (
  id TEXT PRIMARY KEY,                       -- pph_...
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  browser_public_key TEXT NOT NULL,          -- base58 Ed25519, browser-held, ephemeral
  sealed_passport TEXT,                      -- base64 sealed box → browser key; NULL until fulfilled, '' after consume
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | fulfilled | consumed
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  fulfilled_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_passport_handoffs_owner ON passport_handoffs(owner_id, status);

-- sealed_credentials: the shelf — the control-plane copy of vault.json's
-- ciphertext, deposited by daemons ONLY once a passport exists for the owner
-- (laptop-only owners keep today's no-retention behavior). Served exclusively
-- over daemonAuth (proof of possession of the same owner key the boxes are
-- sealed to). Deposits are whole snapshots, so revocations and removals
-- propagate as absence.
CREATE TABLE IF NOT EXISTS sealed_credentials (
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL,
  v INTEGER NOT NULL DEFAULT 1,              -- seal format version (v2 = PRF-wrapped, later)
  meta TEXT NOT NULL,                        -- JSON credential metadata (never secrets)
  sealed TEXT NOT NULL,                      -- JSON {recipient_agent_id: base64 sealed box}
  grants TEXT NOT NULL DEFAULT '[]',         -- JSON grant rows for re-materialization
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, credential_id)
);
