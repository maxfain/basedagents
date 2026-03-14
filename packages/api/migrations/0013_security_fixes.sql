-- 0013_security_fixes.sql
-- H1: Replay attack protection — track used signatures
-- H2: Assignment ID validation — persist verification assignments

-- Replay protection: store hashed signatures to prevent reuse within the validity window
CREATE TABLE IF NOT EXISTS used_signatures (
  signature_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_used_sigs_expires ON used_signatures(expires_at);

-- Verification assignment persistence: prevent fabricated assignment IDs
CREATE TABLE IF NOT EXISTS verification_assignments (
  assignment_id TEXT PRIMARY KEY,
  verifier_agent_id TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (verifier_agent_id) REFERENCES agents(id),
  FOREIGN KEY (target_agent_id) REFERENCES agents(id)
);
CREATE INDEX IF NOT EXISTS idx_assignments_expires ON verification_assignments(expires_at);
