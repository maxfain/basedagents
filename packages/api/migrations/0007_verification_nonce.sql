-- Anti-replay: store nonce on each verification report
ALTER TABLE verifications ADD COLUMN nonce TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_verifications_nonce ON verifications(nonce) WHERE nonce IS NOT NULL;
