-- Keyring control plane: billing (coder brief Task 1).
-- PROPRIETARY control-plane migration — see packages/api/src/control/LICENSE.
--
-- North star: local is free, hosted is paid. The AGENT is the unit of scale
-- (Free = 3 delegated agents, Pro = unlimited). Security actions (revoke,
-- kill switch, recent timeline) are NEVER gated by these columns — plan state
-- is consulted only at delegation creation and grant approval, never at lease
-- time or on any daemon endpoint.

ALTER TABLE owners ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';          -- free | pro | team ('team' reserved, v0.3)
ALTER TABLE owners ADD COLUMN plan_status TEXT NOT NULL DEFAULT 'active'; -- active | past_due | canceled
ALTER TABLE owners ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE owners ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE owners ADD COLUMN current_period_end DATETIME;

CREATE INDEX IF NOT EXISTS idx_owners_stripe_customer ON owners(stripe_customer_id);

-- Webhook idempotency: one row per processed Stripe event id. The INSERT is
-- the atomic claim (UNIQUE violation = already processed) — CONTROL_PLANE.md
-- §4 conditional-write discipline applied to webhook replay.
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,                 -- Stripe event id (evt_...)
  type TEXT NOT NULL,
  received_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- E2E test outbox (coder brief Task 2): in E2E=1 environments the mailer
-- writes here instead of calling Resend. Empty in production; the read
-- endpoint 404s outside E2E.
CREATE TABLE IF NOT EXISTS test_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
