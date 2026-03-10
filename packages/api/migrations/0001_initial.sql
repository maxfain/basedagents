-- Agent Registry D1 Migration: Initial Schema
-- Run with: wrangler d1 migrations apply <database-name>

-- Registered agents
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  protocols TEXT NOT NULL,
  offers TEXT,
  needs TEXT,
  homepage TEXT,
  contact_endpoint TEXT,
  registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME,
  status TEXT NOT NULL DEFAULT 'pending',
  reputation_score REAL NOT NULL DEFAULT 0.0,
  verification_count INTEGER NOT NULL DEFAULT 0,
  security_score INTEGER,
  security_scanned_at DATETIME,
  badge_tier TEXT DEFAULT 'unverified'
);

-- Registration challenges (short-lived)
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  challenge_bytes TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL
);

-- Verification reports
CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  verifier_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  result TEXT NOT NULL,
  response_time_ms INTEGER,
  coherence_score REAL,
  notes TEXT,
  signature TEXT NOT NULL,
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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_reputation ON agents(reputation_score DESC);
CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
CREATE INDEX IF NOT EXISTS idx_verifications_target ON verifications(target_id);
CREATE INDEX IF NOT EXISTS idx_verifications_verifier ON verifications(verifier_id);
CREATE INDEX IF NOT EXISTS idx_chain_agent ON chain(agent_id);
CREATE INDEX IF NOT EXISTS idx_challenges_status ON challenges(status);
CREATE INDEX IF NOT EXISTS idx_challenges_expires ON challenges(expires_at);
