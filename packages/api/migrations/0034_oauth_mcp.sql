-- 0034: OAuth 2.1 Authorization Server + Streamable-HTTP Resource Server for the
-- BasedAgents MCP connector (SPEC §4). Backs the SECOND cookieless Worker
-- (agent-registry-mcp, src/mcp/worker.ts) which shares this same agent-registry
-- D1 but never mounts /v1/owner — so these tables are the connector's entire
-- credential surface.
--
-- PROPRIETARY control-plane schema (the owner FKs bind to the 0023 owners
-- table). Not covered by the repo's Apache-2.0 grant — see LICENSING.md.
--
-- Invariants, uniform across all six tables (matching magic_link_tokens / the
-- DBAdapter's transaction-free model):
--   * NO plaintext tokens — every token/code column is the sha256hex of a
--     base64url(randomBytes(32)) secret; the plaintext is emitted once and never
--     persisted, so a DB read never yields a usable credential.
--   * ISO-8601 TEXT timestamps (new Date().toISOString()) throughout, compared
--     as strings / via Date — never epoch integers.
--   * Single-use is enforced by ONE atomic conditional UPDATE
--     (... SET consumed_at=? WHERE hash=? AND consumed_at IS NULL AND expires_at>?)
--     verified by result.changes===1 — D1/SQLite has no transactions, so there
--     is never a read-then-write race window.
--   * owner_id FKs to owners(id) ON DELETE CASCADE: closing an account drops
--     every code/token/challenge it ever held.

-- Registered OAuth clients (RFC 7591 Dynamic Client Registration, public
-- clients only — token_endpoint_auth_method='none', no secret ever stored).
-- redirect_uris is a JSON array matched by EXACT byte comparison at /authorize
-- and /token (open-redirect / code-exfiltration defense). reg_ip_hash + the
-- created_at index feed the per-IP DCR rate limit and the never-used-client GC.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,                  -- 'oc_' + base64url(randomBytes)
  client_name TEXT,
  redirect_uris TEXT NOT NULL,                 -- JSON array, exact match
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  grant_types TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]',
  registration_source TEXT NOT NULL DEFAULT 'dcr',
  reg_ip_hash TEXT,                            -- sha256hex(ip) for the DCR limiter
  metadata TEXT,                               -- JSON: extra RFC 7591 fields
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_created ON oauth_clients(created_at);

-- The full /authorize request row. It OUTLIVES the magic-link email round-trip
-- (state is authoritative in D1, resumable from the URL token — not hostage to
-- the signed cookie), so every parameter needed to later mint the code lives
-- here. owner_id starts NULL and is set exactly once, atomically, when the
-- magic link is consumed (WHERE owner_id IS NULL). consumed_at is set when
-- /oauth/decision mints the code — single-use.
CREATE TABLE IF NOT EXISTS oauth_authorization_requests (
  id TEXT PRIMARY KEY,                         -- 'authreq_' + base64url
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,               -- PKCE S256 challenge (plain rejected)
  resource TEXT NOT NULL,                     -- RFC 8707; == MCP_RESOURCE_URL
  scope TEXT NOT NULL,                        -- space-delimited, ⊆ supported set
  state TEXT,
  owner_id TEXT REFERENCES owners(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,                   -- +10m
  consumed_at TEXT
);

-- The AS's OWN magic-link challenge — purpose-isolated from the console's
-- magic_link_tokens so a link minted here can NEVER authenticate a console
-- session (and vice versa). Bound to authreq_id so the click resumes the exact
-- authorization it was issued for (login-fixation defense).
CREATE TABLE IF NOT EXISTS oauth_login_challenges (
  token_hash TEXT PRIMARY KEY,                -- sha256hex(lt)
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  authreq_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,                   -- +15m
  consumed_at TEXT
);

-- Authorization codes: 60-second single-use, bound to the full tuple
-- (client_id, owner_id, redirect_uri, code_challenge, resource, scope) so the
-- token exchange re-verifies every binding (PKCE + audience + exact redirect).
CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  code_hash TEXT PRIMARY KEY,                 -- sha256hex(code)
  client_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,                   -- +60s
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_client ON oauth_auth_codes(client_id);

-- Access tokens (1h). The bearer middleware looks up by token_hash and
-- re-asserts resource===MCP_RESOURCE_URL on EVERY /mcp call (RFC 8707 audience
-- re-check) — confused-deputy defense. Indexed by owner for revocation sweeps.
CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  token_hash TEXT PRIMARY KEY,               -- sha256hex(access_token)
  client_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,                   -- +1h
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_oat_owner ON oauth_access_tokens(owner_id);

-- Refresh tokens (30d), ROTATED on every use. rotated_to links old→new so a
-- replay of an already-consumed refresh token walks the chain and revokes ALL
-- of it (theft detection): consume is the atomic conditional UPDATE, and a
-- consumed row presented again is the reuse signal.
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,               -- sha256hex(refresh_token)
  client_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,                   -- +30d
  rotated_to TEXT,                           -- token_hash of the successor
  consumed_at TEXT,
  revoked_at TEXT
);
