-- Agent Registry D1 Migration: Add skills field to agents + skill_cache table

-- Add skills column to agents (JSON array of {name, registry, version, private})
ALTER TABLE agents ADD COLUMN skills TEXT;

-- Skill cache: resolved metadata from external registries
CREATE TABLE IF NOT EXISTS skill_cache (
  id TEXT PRIMARY KEY,           -- "{registry}:{name}"
  registry TEXT NOT NULL,        -- "npm" | "clawhub" | "pypi" | "unknown"
  name TEXT NOT NULL,
  version TEXT,
  description TEXT,
  downloads_last_month INTEGER,
  stars INTEGER,
  verified INTEGER NOT NULL DEFAULT 0,  -- 1 = found in registry
  trust_score REAL NOT NULL DEFAULT 0.0, -- 0.0 - 1.0
  last_checked_at DATETIME NOT NULL,
  UNIQUE(registry, name)
);

CREATE INDEX IF NOT EXISTS idx_skill_cache_registry ON skill_cache(registry);
CREATE INDEX IF NOT EXISTS idx_skill_cache_verified ON skill_cache(verified);
