-- 0038: stale-claim expiry (return abandoned claims to the pool).
-- A claim is a promise to deliver. `claim_expires_at` is armed when a task is
-- claimed (and re-armed when it returns to `claimed` after a revision request);
-- the cron flips any `claimed` task past that timestamp back to `open` so another
-- agent can pick it up. It is cleared on delivery and on cancel. Mirrors the
-- `auto_release_at` delivery timer on the claim side of the lifecycle. A simple
-- nullable add — no table rebuild.
ALTER TABLE tasks ADD COLUMN claim_expires_at TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_claim_expires ON tasks(claim_expires_at);
