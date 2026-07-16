-- Keyring control plane: the authority ladder (spec v0.2 §5.1 revision +
-- onboarding redesign). PROPRIETARY — see packages/api/src/control/LICENSE.
--
-- Signup becomes progressive: anonymous → email (magic link) → passkey.
--   - `init` on the user's machine creates the vault + agent identity and a
--     LINK CODE here; the /link page claims it with one email field.
--   - The claim (magic-link click) ratifies: owner creation (id still derived
--     from the vault Ed25519 key), the delegation of the linking agent, and
--     the vault-key binding. The PASSKEY is minted at the first approval —
--     the first moment authority is exercised.
--   - Agent-invited accounts are CLAIM-PENDING: an invite row, not an owner.
--     Until the human claims, nothing is storable or leasable (structurally:
--     no owner row, no vault key, no delegation exists yet).

-- CLI-created link codes ("Take control of this agent").
CREATE TABLE IF NOT EXISTS link_codes (
  id TEXT PRIMARY KEY,                       -- lnk_...
  code TEXT NOT NULL UNIQUE,                 -- short human-safe code in the /link URL
  vault_public_key TEXT NOT NULL,            -- base58 Ed25519 — the owner identity root
  agent_id TEXT NOT NULL,                    -- the agent being claimed (ag_...)
  agent_public_key TEXT NOT NULL,            -- base58 — pinned at init time
  agent_name TEXT,                           -- "Claude Code @ hostname"
  email TEXT,                                -- set at claim submission
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | email_sent | claimed | expired
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  claimed_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_link_codes_code ON link_codes(code);

-- Magic-link tokens for claim and login (mirror of owner_recovery_tokens:
-- sha256-stored, short-lived, single-use via atomic conditional consume).
CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id TEXT PRIMARY KEY,                       -- mlt_...
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL,                     -- claim | login
  email TEXT NOT NULL,
  link_code_id TEXT,                         -- claim: which link code this ratifies
  owner_id TEXT,                             -- login: which owner (claim: null until created)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME
);

-- Agent-initiated owner invites ("an agent asks its human for an email").
-- Claim-pending is structural: an invite is NOT an owner. Expires in 72h.
CREATE TABLE IF NOT EXISTS owner_invites (
  id TEXT PRIMARY KEY,                       -- inv_...
  email TEXT NOT NULL,
  agent_id TEXT NOT NULL,                    -- the inviting agent
  agent_name TEXT,
  invite_count INTEGER NOT NULL DEFAULT 1,   -- re-invite backoff bookkeeping
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | claimed | expired
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_sent_at DATETIME,
  expires_at DATETIME NOT NULL,
  claimed_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_owner_invites_agent ON owner_invites(agent_id);
CREATE INDEX IF NOT EXISTS idx_owner_invites_email ON owner_invites(email);

-- Sessions carry the rung that minted them: email sessions LOOK; the act
-- ceremony (fresh WebAuthn assertion) is unchanged and rung-independent.
ALTER TABLE owner_sessions ADD COLUMN method TEXT NOT NULL DEFAULT 'passkey'; -- passkey | email

-- Delegations gain a provenance: ladder claims create the first delegation
-- with no passkey assertion (the magic-link claim is the ratifying
-- authority), so authorizing_assertion_id becomes nullable. SQLite cannot
-- relax NOT NULL in place — rebuild the table.
CREATE TABLE delegations_new (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  authorized_via TEXT NOT NULL DEFAULT 'assertion',  -- assertion | claim
  authorizing_assertion_id TEXT REFERENCES action_assertions(id),
  revoke_assertion_id TEXT REFERENCES action_assertions(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME,
  UNIQUE(owner_id, agent_id)
);
INSERT INTO delegations_new (id, owner_id, agent_id, label, status, authorized_via, authorizing_assertion_id, revoke_assertion_id, created_at, revoked_at)
  SELECT id, owner_id, agent_id, label, status, 'assertion', authorizing_assertion_id, revoke_assertion_id, created_at, revoked_at FROM delegations;
DROP TABLE delegations;
ALTER TABLE delegations_new RENAME TO delegations;

-- Browser-sealed pending connections (the connect card). The console seals
-- the pasted provider token CLIENT-SIDE to the owner's vault key; only
-- ciphertext lands here. The daemon opens, validates against the provider,
-- stores the credential + grant locally, and confirms.
CREATE TABLE IF NOT EXISTS pending_connections (
  id TEXT PRIMARY KEY,                       -- pcx_...
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,                    -- who the connection is for
  provider TEXT NOT NULL,                    -- vercel | supabase | ...
  label TEXT,                                -- human label ("Vercel")
  env_var TEXT,                              -- preset env var name
  sealed_secret TEXT NOT NULL,               -- base64 sealed box → owner vault key
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | stored | failed
  failure_reason TEXT,
  daemon_credential_id TEXT,                 -- set on confirm
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_pending_connections_owner ON pending_connections(owner_id, status);
