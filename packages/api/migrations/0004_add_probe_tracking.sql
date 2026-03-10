-- Agent Registry D1 Migration: Add probe tracking fields for bootstrap verification
ALTER TABLE agents ADD COLUMN probe_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN last_probe_at DATETIME;
ALTER TABLE agents ADD COLUMN last_probe_result TEXT;
