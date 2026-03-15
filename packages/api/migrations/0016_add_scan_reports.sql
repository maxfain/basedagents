CREATE TABLE IF NOT EXISTS scan_reports (
  id TEXT PRIMARY KEY,
  package_name TEXT NOT NULL,
  package_version TEXT NOT NULL,
  score INTEGER NOT NULL,
  grade TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  basedagents_json TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  submitted_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scan_reports_package ON scan_reports(package_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_reports_package_version ON scan_reports(package_name, package_version);
