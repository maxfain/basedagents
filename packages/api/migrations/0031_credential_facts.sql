-- 0031: daemon-reported credential facts — currently one fact: rotatability.
--
-- The console offers per-key actions (Rotate), but only the machine knows
-- which keys an action can actually work on: provider-side ids live in the
-- local vault and never leave it. Without facts the console guesses by
-- provider and the guess fails honestly-but-annoyingly after the click.
--
-- The daemon posts {credential_id, provider, rotatable} rows on sync
-- (POST /daemon/credential-facts, upsert); the console reads them
-- (GET /credential-facts) and hides Rotate only when a fact affirmatively
-- says rotatable = 0 — an unreported key keeps today's behavior, so old
-- daemons lose nothing. Metadata only: ids and booleans, never values.
CREATE TABLE IF NOT EXISTS credential_facts (
  owner_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  rotatable INTEGER NOT NULL DEFAULT 0,
  reported_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, credential_id)
);
