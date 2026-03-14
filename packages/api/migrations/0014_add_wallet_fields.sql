-- Phase 1: Wallet Identity — add wallet address and network to agents
ALTER TABLE agents ADD COLUMN wallet_address TEXT;
ALTER TABLE agents ADD COLUMN wallet_network TEXT DEFAULT 'eip155:8453';
