-- 0028: onboarding funnel events + provider vote tiles (onboarding redesign).
--
-- funnel_events: anonymous, append-only counters for the onboarding funnel
--   copy_command → init_run → mcp_config_written → passkey_created →
--   provider_connected → first_lease. No identity is ever stored — only the
--   event name, an optional random per-run correlation id, and an optional
--   provider slug. first_lease is accepted for a future local opt-in; nothing
--   ships it today (leases are local-first and stay on the user's machine).
--
-- provider_votes: the marketing page's "vote for next" tiles (+1 per tap).

CREATE TABLE IF NOT EXISTS funnel_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  funnel_id TEXT,
  provider TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_funnel_events_event ON funnel_events(event, created_at);

CREATE TABLE IF NOT EXISTS provider_votes (
  provider TEXT PRIMARY KEY,
  votes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
