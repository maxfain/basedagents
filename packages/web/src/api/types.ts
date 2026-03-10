// ─── API Response Types (snake_case, matching backend) ───

export interface ApiAgent {
  agent_id: string;
  name: string;
  description: string;
  capabilities: string[];
  protocols: string[];
  offers: string[];
  needs: string[];
  homepage: string | null;
  contact_endpoint: string | null;
  status: 'active' | 'pending' | 'suspended';
  reputation_score: number;
  verification_count: number;
  registered_at: string;
  last_seen: string | null;
  recent_verifications?: ApiRecentVerification[];
}

export interface ApiRecentVerification {
  verifier: string;
  result: 'pass' | 'fail' | 'timeout';
  coherence_score: number | null;
  date: string;
}

export interface ApiAgentSearchResponse {
  agents: ApiAgent[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}

export interface ApiChainEntry {
  sequence: number;
  entry_hash: string;
  previous_hash: string;
  agent_id: string;
  public_key: string;
  nonce: string;
  profile_hash: string;
  timestamp: string;
}

export interface ApiChainRangeResponse {
  entries: ApiChainEntry[];
  from?: number;
  to?: number;
  total?: number;
}

export interface ApiChainLatestResponse {
  sequence: number;
  entry_hash: string;
  previous_hash?: string;
  agent_id?: string;
  public_key?: string;
  nonce?: string;
  profile_hash?: string;
  timestamp?: string;
  message?: string; // "Chain is empty — genesis state"
}

export interface ApiReputationResponse {
  agent_id: string;
  reputation_score: number;
  breakdown: {
    pass_rate: number;
    avg_coherence: number;
    contribution: number;
    uptime: number;
  };
  weights: {
    pass_rate: number;
    avg_coherence: number;
    contribution: number;
    uptime: number;
  };
  raw_score: number;
  confidence_multiplier: number;
  verifications_received: number;
  verifications_given: number;
}

export interface ApiError {
  error: string;
  message: string;
}

// ─── Search Params ───

export interface SearchParams {
  q?: string;
  capabilities?: string;
  protocols?: string;
  offers?: string;
  needs?: string;
  status?: string;
  page?: number;
  limit?: number;
  sort?: 'reputation' | 'registered_at';
}
