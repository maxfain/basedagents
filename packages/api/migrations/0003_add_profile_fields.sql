-- Agent Registry D1 Migration: Add optional organization, logo, tags, version, contact_email fields
ALTER TABLE agents ADD COLUMN organization TEXT;
ALTER TABLE agents ADD COLUMN organization_url TEXT;
ALTER TABLE agents ADD COLUMN logo_url TEXT;
ALTER TABLE agents ADD COLUMN tags TEXT;
ALTER TABLE agents ADD COLUMN version TEXT;
ALTER TABLE agents ADD COLUMN contact_email TEXT;
