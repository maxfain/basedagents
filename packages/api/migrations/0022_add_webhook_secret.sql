-- MED-6: Add per-agent webhook secret for HMAC-SHA256 signing
ALTER TABLE agents ADD COLUMN webhook_secret TEXT DEFAULT NULL;
