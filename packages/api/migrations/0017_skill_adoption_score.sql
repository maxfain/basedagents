-- Migration: Add adoption_score to skill_cache
-- adoption_score is the download-based popularity signal (display only, not a trust input).
-- trust_score is now exclusively the safety-aware inverted model.

ALTER TABLE skill_cache ADD COLUMN adoption_score REAL NOT NULL DEFAULT 0.0;
