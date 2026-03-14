-- Task Delivery Protocol: signed receipts + chain anchoring

ALTER TABLE tasks ADD COLUMN proposer_signature TEXT;
ALTER TABLE tasks ADD COLUMN acceptor_signature TEXT;

CREATE TABLE IF NOT EXISTS delivery_receipts (
  receipt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  artifact_urls TEXT,
  commit_hash TEXT,
  pr_url TEXT,
  submission_type TEXT NOT NULL DEFAULT 'json' CHECK (submission_type IN ('json','link','pr')),
  submission_content TEXT,
  completed_at TEXT NOT NULL,
  chain_sequence INTEGER,
  chain_entry_hash TEXT,
  signature TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_receipts_task ON delivery_receipts(task_id);
CREATE INDEX IF NOT EXISTS idx_receipts_agent ON delivery_receipts(agent_id);
