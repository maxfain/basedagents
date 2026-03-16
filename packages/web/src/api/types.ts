// ─── API Response Types (snake_case, matching backend) ───

export interface ApiDeclaredSkill {
  name: string;
  registry: 'npm' | 'clawhub' | 'pypi';
  version?: string;
  private?: boolean;
}

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
  comment: string | null;
  organization: string | null;
  organization_url: string | null;
  logo_url: string | null;
  tags: string[];
  version: string | null;
  contact_email: string | null;
  x_handle: string | null;
  skills: ApiDeclaredSkill[];
  wallet_address: string | null;
  wallet_network: string | null;
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
  agent_name?: string | null;
  agent_comment?: string | null;
  public_key: string;
  nonce: string;
  profile_hash: string;
  timestamp: string;
  entry_type?: 'registration' | 'update';
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

// ─── Task Types ───

export interface ApiTask {
  task_id: string;
  creator_agent_id: string;
  claimed_by_agent_id: string | null;
  title: string;
  description: string;
  category: string | null;
  required_capabilities: string[] | null;
  expected_output: string | null;
  output_format: 'json' | 'link';
  status: 'open' | 'claimed' | 'submitted' | 'verified' | 'closed' | 'cancelled';
  created_at: string;
  claimed_at: string | null;
  submitted_at: string | null;
  verified_at: string | null;
  proposer_signature: string | null;
  acceptor_signature: string | null;
  bounty_amount: string | null;
  bounty_token: string | null;
  bounty_network: string | null;
  payment_status: 'none' | 'authorized' | 'settled' | 'failed' | 'disputed' | 'expired' | null;
  payment_tx_hash: string | null;
}

export interface ApiTaskSubmission {
  submission_id: string;
  task_id: string;
  agent_id: string;
  submission_type: 'json' | 'link';
  content: string;
  summary: string;
  created_at: string;
}

export interface ApiDeliveryReceipt {
  receipt_id: string;
  task_id: string;
  agent_id: string;
  summary: string;
  artifact_urls: string[] | null;
  commit_hash: string | null;
  pr_url: string | null;
  submission_type: 'json' | 'link' | 'pr';
  submission_content: string | null;
  completed_at: string;
  chain_sequence: number | null;
  chain_entry_hash: string | null;
  signature: string;
}

export interface ApiTaskListResponse {
  ok: boolean;
  tasks: ApiTask[];
}

export interface ApiTaskDetailResponse {
  ok: boolean;
  task: ApiTask;
  submission: ApiTaskSubmission | null;
  delivery_receipt: ApiDeliveryReceipt | null;
}

export interface TaskSearchParams {
  status?: string;
  category?: string;
  capability?: string;
  creator?: string;
  claimer?: string;
  limit?: number;
  offset?: number;
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
  sort?: 'reputation' | 'registered_at' | 'name';
}

// ─── Scan Types ───

export interface ScanFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  file: string;
  line?: number;
  snippet?: string;
  description: string;
}

export interface ScanMetadata {
  files_scanned?: number;
  has_install_scripts?: boolean;
  install_scripts?: string[];
  total_size?: number;
  dependencies?: number;
  // GitHub-specific fields
  stars?: number;
  forks?: number;
  open_issues?: number;
  language?: string;
  license?: string;
  has_ci?: boolean;
  created_at?: string;
  pushed_at?: string;
  // PyPI-specific fields (nested in source_metadata.extra)
  source_metadata?: {
    extra?: {
      author?: string;
      author_email?: string;
      license?: string;
      requires_python?: string;
      home_page?: string;
      project_url?: string;
      project_urls?: Record<string, string>;
      classifiers?: string[];
      has_setup_py?: boolean;
      has_setup_cfg?: boolean;
      has_pyproject_toml?: boolean;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ScanBasedAgents {
  registered?: boolean;
  verified?: boolean;
  reputation_score?: number;
  agent_id?: string;
  agent_name?: string;
  profile_url?: string;
  [key: string]: unknown;
}

export interface ApiScanReport {
  ok: boolean;
  id: string;
  package_name: string;
  package_version: string;
  score: number;
  grade: string;
  findings: ScanFinding[];
  metadata: ScanMetadata;
  basedagents: ScanBasedAgents;
  provenance?: {
    bonus: number;
    signals: string[];
  };
  scanned_at: string;
  submitted_by: string | null;
  created_at: string;
  source?: 'npm' | 'github' | 'pypi';
  scanner_version?: number;
}

export interface ApiScanListItem {
  id: string;
  package_name: string;
  package_version: string;
  score: number;
  grade: string;
  finding_count: number;
  critical_high_count: number;
  scanned_at: string;
  submitted_by: string | null;
  report_url: string;
  source?: 'npm' | 'github' | 'pypi';
  scanner_version?: number;
}

export interface ApiScanListResponse {
  ok: boolean;
  packages: ApiScanListItem[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
}

export interface ScanSearchParams {
  limit?: number;
  offset?: number;
  sort?: 'recent' | 'score';
  source?: string;
}
