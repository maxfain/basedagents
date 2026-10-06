-- 0050: AgentID verified-identity links (optional OIDC attestation, 2026-10-06).
--
-- An agent that already holds a BasedAgents identity (ag_…, its Ed25519 signing
-- key) can OPTIONALLY link an AgentID (https://agentid.com) — an OIDC identity
-- backed by a verified AgentMail inbox. This does NOT replace AgentSig: agents
-- still authenticate every request by signing it. The link is an extra, verified
-- attestation that carries (a) an owner grouping key (`owner_sub`, shared by all
-- agents one person runs — the sybil signal the trust layer wants) and (b) a
-- verified contact email.
--
-- Two tables, modelled on the oauth_* control tables (0034):
--   * agentid_links            — the durable verified link (one per agent).
--   * agentid_link_challenges  — the short-lived OIDC authorization-code flow
--                                state (PKCE verifier + nonce), GC'd by expiry.
--
-- Single-use of a challenge is enforced with one atomic conditional UPDATE
-- (consumed_at IS NULL) checked via changes()===1 — there are no transactions in
-- the D1/DBAdapter model. owner_sub is stored but NEVER exposed publicly; it is
-- for reputation/sybil weighting only.

CREATE TABLE IF NOT EXISTS agentid_links (
  agent_id       TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  issuer         TEXT NOT NULL,                       -- OIDC issuer, e.g. https://auth.agentid.com
  sub            TEXT NOT NULL,                       -- AgentID subject (stable across apps)
  owner_sub      TEXT,                                -- owner grouping key (sybil weighting) — never exposed
  email          TEXT,                                -- verified agent inbox address (masked when public)
  email_verified INTEGER NOT NULL DEFAULT 0,
  display_name   TEXT,
  linked_at      TEXT NOT NULL,                       -- ISO-8601; first successful link
  updated_at     TEXT NOT NULL                        -- ISO-8601; last re-link/refresh
);
-- One BasedAgents agent per AgentID subject (and vice versa via the PK above).
CREATE UNIQUE INDEX IF NOT EXISTS idx_agentid_links_issuer_sub ON agentid_links(issuer, sub);
-- Group an owner's agents cheaply for sybil-aware reputation.
CREATE INDEX IF NOT EXISTS idx_agentid_links_owner_sub ON agentid_links(owner_sub);

CREATE TABLE IF NOT EXISTS agentid_link_challenges (
  state_hash     TEXT PRIMARY KEY,                    -- sha256hex(state); the OIDC `state` is returned via the browser
  link_id        TEXT NOT NULL UNIQUE,                -- public, pollable id ('ail_…')
  agent_id       TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  code_verifier  TEXT NOT NULL,                       -- PKCE S256 verifier (server-held, short-lived)
  nonce          TEXT NOT NULL,                       -- OIDC nonce expected back in the id_token
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'linked', 'failed')),
  error          TEXT,                                -- coarse failure reason surfaced to the poller
  confirm_binding TEXT,                               -- sha256hex of the consent-browser cookie, set ONCE at the consent GET
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  consumed_at    TEXT                                 -- set when the confirm POST consumes it (single-use)
);
CREATE INDEX IF NOT EXISTS idx_agentid_challenges_expires ON agentid_link_challenges(expires_at);
