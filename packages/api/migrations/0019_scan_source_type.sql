-- Add source column (default 'npm' for existing rows)
ALTER TABLE scan_reports ADD COLUMN source TEXT NOT NULL DEFAULT 'npm';

-- Add ref column for GitHub (branch/tag/commit)
ALTER TABLE scan_reports ADD COLUMN ref TEXT;

-- Update unique index to include source
-- (same package name could exist on npm and github)
DROP INDEX IF EXISTS idx_scan_reports_package_version;
CREATE UNIQUE INDEX idx_scan_reports_source_package_version
  ON scan_reports(source, package_name, package_version);
