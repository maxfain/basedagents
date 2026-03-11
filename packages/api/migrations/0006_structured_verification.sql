-- Add structured verification report and penalty tracking
ALTER TABLE verifications ADD COLUMN structured_report TEXT; -- JSON

-- Track safety flags directly on agent for fast lookup
ALTER TABLE agents ADD COLUMN safety_flags INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN penalty_score REAL NOT NULL DEFAULT 0.0;
