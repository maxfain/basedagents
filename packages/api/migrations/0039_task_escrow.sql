-- 0039: escrow for task bounties (Tasks P1).
--
-- Escrow is the default money model for a bounty task: the buyer DEPOSITS the
-- bounty into the registry's house wallet when the task is posted, the task is
-- claimable only once that deposit has settled, and the house wallet RELEASES
-- the funds to the deliverer when the buyer (or the 7-day timer) accepts the
-- delivery — or REFUNDS the buyer when the task is cancelled. `escrow = 0`
-- keeps the sign-at-accept flow (0035) untouched, so this is a plain set of
-- nullable adds — no table rebuild.
--
-- The existing payment_* / settle_* columns describe ONE transfer at a time;
-- `escrow_leg` says which one (deposit | release | refund) they currently
-- describe. The settled facts of the deposit are copied into the
-- escrow_deposit_* columns before the release/refund leg reuses the columns.
ALTER TABLE tasks ADD COLUMN escrow INTEGER NOT NULL DEFAULT 0;
-- funding | unfunded | funded | releasing | released | refunding | refunded (NULL when escrow = 0)
ALTER TABLE tasks ADD COLUMN escrow_status TEXT;
-- deposit | release | refund — the transfer the payment_* columns currently describe
ALTER TABLE tasks ADD COLUMN escrow_leg TEXT;
-- server-signed legs started for this task (bounded re-sign after a definitive failure)
ALTER TABLE tasks ADD COLUMN escrow_leg_attempts INTEGER NOT NULL DEFAULT 0;
-- the house wallet that holds this task's deposit (recorded at funding; keys may rotate)
ALTER TABLE tasks ADD COLUMN escrow_wallet TEXT;
-- the buyer's paying address — the refund destination — and the deposit's on-chain facts
ALTER TABLE tasks ADD COLUMN escrow_deposit_payer TEXT;
ALTER TABLE tasks ADD COLUMN escrow_deposit_nonce TEXT;
ALTER TABLE tasks ADD COLUMN escrow_deposit_tx_hash TEXT;
ALTER TABLE tasks ADD COLUMN escrow_funded_at TEXT;
ALTER TABLE tasks ADD COLUMN escrow_release_tx_hash TEXT;
ALTER TABLE tasks ADD COLUMN escrow_released_at TEXT;
ALTER TABLE tasks ADD COLUMN escrow_refund_tx_hash TEXT;
ALTER TABLE tasks ADD COLUMN escrow_refunded_at TEXT;

-- The cron's escrow sweep: funded tasks whose acceptance/cancellation still needs a payout leg.
CREATE INDEX IF NOT EXISTS idx_tasks_escrow_sweep ON tasks(escrow_status, status) WHERE escrow = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_escrow_deposit_nonce ON tasks(escrow_deposit_nonce) WHERE escrow_deposit_nonce IS NOT NULL;
