-- 0052: the default open window grows from 7 to 60 days (decision D13,
-- revised). New posts and claim-lapse re-stamps take the new default from
-- tasks/expiry.ts; this moves the tasks already on the board onto it, so
-- their old 7-day stamps don't keep expiring work the new rule keeps listed.
--
-- Only `open` rows with a finite window, no escrow, and a DEFAULT stamp move:
--   * stamped at post: expires_at = created_at + 7 days. Matched within 5 s,
--     because the console stamps the window a moment before created_at;
--   * re-stamped when a lapsed claim reopened the task: reopen + 7 days,
--     which is not a whole number of days after created_at.
-- Both become their start + 60 days, i.e. expires_at + 53 days, written in
-- the app's toISOString() form so lexicographic compares keep holding.
--
-- Left alone:
--   * a window the poster chose (a whole number of days other than 7);
--   * NULL windows (never-expiring house and managed-testing tasks);
--   * escrow tasks: a longer window would hold back a deposit refund the
--     poster was promised at 7 days.
UPDATE tasks
SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+53 days')
WHERE status = 'open'
  AND expires_at IS NOT NULL
  AND escrow = 0
  AND (
    ABS((julianday(expires_at) - julianday(created_at)) * 86400000.0 - 7 * 86400000.0) <= 5000
    OR ABS((julianday(expires_at) - julianday(created_at)) * 86400000.0
           - ROUND(julianday(expires_at) - julianday(created_at)) * 86400000.0) > 5000
  );
