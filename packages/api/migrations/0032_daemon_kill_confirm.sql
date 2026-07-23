-- 0032: the kill switch's local half — daemon confirmation of revocations.
--
-- The console kill switch revokes the delegation here (the agent can no
-- longer ask for anything), but the LOCAL half — revoke the vault grants,
-- burn minted provider-side keys, sweep for ambient residuals — runs on the
-- owner's machine. Field-hit: that half was never delivered; the confirm
-- dialog promised "your machine drops its access on the next sync" and no
-- endpoint existed to make it true.
--
-- Now: GET /daemon/revocations serves revoked delegations not yet confirmed;
-- the daemon runs the same local kill as `based kill` and confirms back via
-- POST /daemon/revocations/:id/confirm with a counts-only report
-- (grants revoked, keys burned, burn failures, ambient residuals — numbers
-- and a short note, never values). The console then shows the honest state:
-- "cut off at the account" vs "your machine confirmed, N residuals found".
ALTER TABLE delegations ADD COLUMN daemon_confirmed_at TEXT;
ALTER TABLE delegations ADD COLUMN daemon_kill_report TEXT;
