-- Track which scanner version produced each report
ALTER TABLE scan_reports ADD COLUMN scanner_version INTEGER NOT NULL DEFAULT 1;

-- Rescan queue: reports that need re-scanning
CREATE TABLE IF NOT EXISTS rescan_queue (
  id TEXT PRIMARY KEY,
  scan_report_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'npm',
  package_name TEXT NOT NULL,
  package_version TEXT NOT NULL,
  ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, processing, completed, failed
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_attempt_at TEXT,
  error TEXT,
  UNIQUE(scan_report_id)
);
CREATE INDEX IF NOT EXISTS idx_rescan_queue_status ON rescan_queue(status);
