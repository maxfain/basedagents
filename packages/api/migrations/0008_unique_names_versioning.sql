-- Migration 0008: unique agent names + profile versioning on chain

-- Unique name constraint (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name_unique ON agents(name COLLATE NOCASE);

-- Track how many times a profile has been updated
ALTER TABLE agents ADD COLUMN profile_version INTEGER NOT NULL DEFAULT 1;

-- entry_type distinguishes registrations from profile updates in the chain
ALTER TABLE chain ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'registration';

-- nonce is only required for registrations; allow NULL for update entries
-- SQLite can't DROP NOT NULL, so we rely on application-level enforcement
-- (nonce column already exists; updates will insert empty string or NULL via new logic)
