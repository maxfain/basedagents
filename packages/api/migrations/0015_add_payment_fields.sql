-- Phase 2: Paid Tasks with Deferred Settlement

-- Payment columns on tasks table
ALTER TABLE tasks ADD COLUMN bounty_amount TEXT;
ALTER TABLE tasks ADD COLUMN bounty_token TEXT;
ALTER TABLE tasks ADD COLUMN bounty_network TEXT;
ALTER TABLE tasks ADD COLUMN payment_signature TEXT;
ALTER TABLE tasks ADD COLUMN payment_verified INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN payment_settled INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN payment_tx_hash TEXT;
ALTER TABLE tasks ADD COLUMN payment_expires_at TEXT;
ALTER TABLE tasks ADD COLUMN auto_release_at TEXT;
ALTER TABLE tasks ADD COLUMN payment_status TEXT DEFAULT 'none';

-- Payment audit log
CREATE TABLE IF NOT EXISTS payment_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_events_task ON payment_events(task_id);
CREATE INDEX IF NOT EXISTS idx_payment_events_type ON payment_events(event_type);
CREATE INDEX IF NOT EXISTS idx_tasks_payment_status ON tasks(payment_status);
CREATE INDEX IF NOT EXISTS idx_tasks_auto_release ON tasks(auto_release_at);
