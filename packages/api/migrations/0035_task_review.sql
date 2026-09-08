-- 0035: task review + human-posted tasks + settlement bookkeeping (Tasks P0).
-- Full rebuild: SQLite cannot relax NOT NULL (creator_agent_id) or add a CHECK in place
-- (0027:73-92 precedent). tasks is referenced by submissions / delivery_receipts /
-- payment_events, so the rebuild keeps the table NAME: back up, drop, recreate, refill.
-- (CREATE tasks_new → DROP → RENAME fails at COMMIT with child rows even under
-- defer_foreign_keys — verified.) Runs inside D1's migration transaction; node.ts wraps
-- each file in a better-sqlite3 transaction so the pragma is effective locally too.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE tasks_backup AS SELECT * FROM tasks;
DROP TABLE tasks;

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  creator_agent_id TEXT REFERENCES agents(id),          -- nullable now
  creator_owner_id TEXT,                                 -- ow_…; NO FK (owners absent on OSS deploys, 0033:15-18)
  creator_kind TEXT NOT NULL DEFAULT 'agent' CHECK (creator_kind IN ('agent','owner')),
  creator_assertion_id TEXT,
  claimed_by_agent_id TEXT REFERENCES agents(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT,
  required_capabilities TEXT,
  expected_output TEXT,
  output_format TEXT DEFAULT 'json',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','submitted','verified','closed','cancelled')),
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  submitted_at TEXT,
  verified_at TEXT,
  accepted_by TEXT CHECK (accepted_by IS NULL OR accepted_by IN ('creator','auto')),
  review_note TEXT,
  review_assertion_id TEXT,
  revision_count INTEGER NOT NULL DEFAULT 0,
  revision_requested_at TEXT,
  disputed_at TEXT,
  cancelled_at TEXT,
  proposer_signature TEXT,
  acceptor_signature TEXT,
  bounty_amount TEXT,                                    -- atomic units, digits only
  bounty_token TEXT,
  bounty_network TEXT,
  payment_status TEXT NOT NULL DEFAULT 'none',           -- no CHECK on purpose (N2)
  payment_signature TEXT,
  payment_requirements TEXT,
  payment_payer TEXT,
  payment_nonce TEXT,
  payment_verified INTEGER NOT NULL DEFAULT 0,
  payment_settled INTEGER NOT NULL DEFAULT 0,
  payment_tx_hash TEXT,
  payment_expires_at TEXT,
  auto_release_at TEXT,
  settle_attempts INTEGER NOT NULL DEFAULT 0,
  settle_broadcast INTEGER NOT NULL DEFAULT 0,
  settle_started_at TEXT,
  settle_next_at TEXT,
  settled_at TEXT,
  last_settle_error TEXT,
  CHECK ((creator_agent_id IS NULL) <> (creator_owner_id IS NULL))
);

INSERT INTO tasks (task_id, creator_agent_id, creator_kind, claimed_by_agent_id, title, description, category,
  required_capabilities, expected_output, output_format, status, created_at, claimed_at, submitted_at, verified_at,
  accepted_by, proposer_signature, acceptor_signature, bounty_amount, bounty_token, bounty_network, payment_status,
  payment_signature, payment_verified, payment_settled, payment_tx_hash, payment_expires_at, auto_release_at)
SELECT task_id, creator_agent_id, 'agent', claimed_by_agent_id, title, description, category,
  required_capabilities, expected_output, output_format, status, created_at, claimed_at, submitted_at, verified_at,
  CASE WHEN status IN ('verified','closed') THEN 'creator' END,
  proposer_signature, acceptor_signature,
  CASE WHEN bounty_amount IS NOT NULL AND bounty_amount NOT GLOB '*[^0-9]*' THEN bounty_amount END,
  bounty_token, bounty_network,
  CASE COALESCE(payment_status,'none')
       WHEN 'none' THEN 'none' WHEN 'settled' THEN 'settled' WHEN 'failed' THEN 'failed'
       WHEN 'expired' THEN 'expired' ELSE 'expired' END,   -- legacy authorized/disputed/refunded: unsettleable
  payment_signature, COALESCE(payment_verified,0), COALESCE(payment_settled,0),
  payment_tx_hash, payment_expires_at, auto_release_at
FROM tasks_backup;

DROP TABLE tasks_backup;

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category);
CREATE INDEX IF NOT EXISTS idx_tasks_creator ON tasks(creator_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_claimer ON tasks(claimed_by_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_payment_status ON tasks(payment_status);
CREATE INDEX IF NOT EXISTS idx_tasks_auto_release ON tasks(auto_release_at);
CREATE INDEX IF NOT EXISTS idx_tasks_creator_owner ON tasks(creator_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_settle ON tasks(payment_status, settle_next_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_payment_nonce ON tasks(payment_nonce) WHERE payment_nonce IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_receipts_task_completed ON delivery_receipts(task_id, completed_at DESC);
