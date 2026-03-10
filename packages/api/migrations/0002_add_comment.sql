-- Agent Registry D1 Migration: Add optional comment field to agents
ALTER TABLE agents ADD COLUMN comment TEXT;
