-- Agent Registry Database Schema
-- Compatible with both SQLite (better-sqlite3) and Cloudflare D1

-- Registered agents
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,                    -- ag_<base58(pubkey)>
  public_key BLOB NOT NULL UNIQUE,        -- raw 32-byte Ed25519 public key
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  capabilities TEXT NOT NULL,             -- JSON array
  protocols TEXT NOT NULL,                -- JSON array
  offers TEXT,                            -- JSON array (nullable)
  needs TEXT,                             -- JSON array (nullable)
  homepage TEXT,
  contact_endpoint TEXT,
  registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | active | suspended
  reputation_score REAL NOT NULL DEFAULT 0.0,
  verification_count INTEGER NOT NULL DEFAULT 0
);

-- Registration challenges (short-lived)
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,                    -- UUID
  agent_id TEXT NOT NULL,                 -- public key identifier
  challenge_bytes TEXT NOT NULL,          -- random bytes (base64)
  status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | expired
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL
);

-- Verification reports
CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,                    -- UUID
  verifier_id TEXT NOT NULL,              -- agent who performed verification
  target_id TEXT NOT NULL,                -- agent being verified
  result TEXT NOT NULL,                   -- pass | fail | timeout
  response_time_ms INTEGER,
  coherence_score REAL,                   -- 0.0 - 1.0
  notes TEXT,
  signature TEXT NOT NULL,                -- verifier's Ed25519 signature
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (verifier_id) REFERENCES agents(id),
  FOREIGN KEY (target_id) REFERENCES agents(id)
);

-- Hash chain (tamper-evident registration ledger)
CREATE TABLE IF NOT EXISTS chain (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_hash TEXT NOT NULL UNIQUE,
  previous_hash TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  public_key BLOB NOT NULL,
  nonce TEXT NOT NULL,
  profile_hash TEXT NOT NULL,
  timestamp DATETIME NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_reputation ON agents(reputation_score DESC);
CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
CREATE INDEX IF NOT EXISTS idx_verifications_target ON verifications(target_id);
CREATE INDEX IF NOT EXISTS idx_verifications_verifier ON verifications(verifier_id);
CREATE INDEX IF NOT EXISTS idx_chain_agent ON chain(agent_id);
CREATE INDEX IF NOT EXISTS idx_challenges_status ON challenges(status);
CREATE INDEX IF NOT EXISTS idx_challenges_expires ON challenges(expires_at);
