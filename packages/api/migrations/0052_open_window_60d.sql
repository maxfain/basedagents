-- 0052: the default open window grows from 7 to 60 days (decision D13,
-- revised). New posts and claim-lapse re-stamps take the new default from
-- tasks/expiry.ts; this moves the tasks already on the board onto it, so
-- their old 7-day stamps don't keep expiring work the new rule keeps listed.
--
-- Only `open`, non-escrow rows whose window is PROVABLY the 7-day default
-- move, to their start + 60 days (expires_at + 53 days, written in the app's
-- toISOString() form so lexicographic compares keep holding):
--   * stamped at post: expires_at is 7 days after created_at, or up to two
--     minutes less. The console stamps the window before its awaited rate-limit
--     and passkey checks and created_at after them; no request outlives the
--     edge's 100-second timeout, so a gap of two minutes covers it;
--   * re-stamped when a lapsed claim reopened the task: the cron records that
--     reopen as a task.claim_expired event at the same instant it stamps the
--     window, so expires_at equals that event's created_at + 7 days exactly.
--
-- Everything else keeps its date: a window the poster chose (however long the
-- post took to stamp), NULL windows (never-expiring house and managed-testing
-- tasks), and escrow tasks, where a longer window would hold back a deposit
-- refund the poster was promised at 7 days.
UPDATE tasks
SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+53 days')
WHERE status = 'open'
  AND expires_at IS NOT NULL
  AND escrow = 0
  AND (
    (julianday(expires_at) - julianday(created_at)) * 86400000.0
      BETWEEN 7 * 86400000.0 - 120000 AND 7 * 86400000.0 + 1000
    OR EXISTS (
      SELECT 1 FROM agent_events e
      WHERE e.ref_kind = 'task' AND e.ref_id = tasks.task_id
        AND e.type = 'task.claim_expired'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', e.created_at, '+7 days') = tasks.expires_at
    )
  );
