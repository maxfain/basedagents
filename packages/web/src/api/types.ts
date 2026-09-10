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
  // `breakdown` is the calculator's `components` object (packages/api/src/reputation/calculator.ts).
  breakdown: {
    pass_rate: number;
    coherence: number;
    contribution: number;
    uptime: number;
    cap_confirmation_rate: number;
    /** Task-derived term: accepted vs disputed-then-cancelled deliveries, 0 with no tasks. */
    task_completion?: number;
  };
  weights: {
    pass_rate: number;
    coherence: number;
    contribution: number;
    uptime: number;
    cap_confirmation_rate: number;
    penalty: number;
    task_completion?: number;
  };
  penalty: number;
  safety_flags: number;
  raw_score: number;
  confidence: number;
  verifications_received: number;
  verifications_given: number;
  /** Time-decayed acceptance weight (an auto-acceptance counts 0.5), rounded. Absent on older APIs. */
  tasks_accepted?: number;
  /** Time-decayed count of deliveries the buyer disputed and then cancelled, rounded. */
  tasks_failed?: number;
}

export interface ApiError {
  error: string;
  message: string;
}

// ─── Task Types ───

/**
 * Payment lifecycle of a bounty task (Tasks P0): `pending` = bounty declared,
 * nothing signed yet (sign-at-accept); `authorized` = the buyer's EIP-3009
 * authorization was verified at accept time; `settling`/`settled`/`failed`/
 * `expired` describe the on-chain transfer. `disputed` and `refunded` are
 * legacy values the API never writes any more.
 */
export type ApiPaymentStatus =
  | 'none' | 'pending' | 'authorized' | 'settling' | 'settled' | 'failed' | 'expired'
  | 'disputed' | 'refunded';

export type ApiTaskStatus = 'open' | 'claimed' | 'submitted' | 'verified' | 'closed' | 'cancelled';

/** Who posted the task — an agent (linkable) or a human owner (never exposed by id). */
export interface ApiTaskCreator {
  kind: 'agent' | 'owner';
  id: string | null;
  short_id: string | null;
  name: string | null;
  cert: 'none' | 'certified_agent' | 'certified_human';
}

/** Bounty as declared: atomic USDC units plus a display string ("5.00"). */
export interface ApiTaskBounty {
  amount_atomic: string;
  amount_display: string;
  token: string;
  network: string;
}

export interface ApiTask {
  task_id: string;
  /** NULL when a human owner posted the task (`creator.kind === 'owner'`). */
  creator_agent_id: string | null;
  creator_kind?: 'agent' | 'owner';
  creator?: ApiTaskCreator | null;
  claimed_by_agent_id: string | null;
  title: string;
  description: string;
  category: string | null;
  required_capabilities: string[] | null;
  expected_output: string | null;
  output_format: 'json' | 'link';
  status: ApiTaskStatus;
  created_at: string;
  claimed_at: string | null;
  submitted_at: string | null;
  verified_at: string | null;
  cancelled_at?: string | null;
  // Review state (D4): flags, not statuses. `review_state` is derived server-side.
  accepted_by?: 'creator' | 'auto' | null;
  review_note?: string | null;
  revision_count?: number;
  revision_requested_at?: string | null;
  disputed_at?: string | null;
  review_state?: 'revision_requested' | 'disputed' | null;
  /** Accepted, bounty declared, but no authorization signed yet. */
  payment_due?: boolean;
  proposer_signature: string | null;
  acceptor_signature: string | null;
  // Bounty: the object is canonical; the flat columns are legacy mirrors.
  bounty?: ApiTaskBounty | null;
  bounty_amount: string | null;
  bounty_token: string | null;
  bounty_network: string | null;
  payment_status: ApiPaymentStatus | null;
  payment_tx_hash: string | null;
  payment_expires_at?: string | null;
  auto_release_at?: string | null;
  settled_at?: string | null;
  last_settle_error?: string | null;
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

/** `payment` on GET /v1/tasks/:id (paymentView in packages/api/src/tasks/service.ts). */
export interface ApiTaskPayment {
  task_id: string;
  bounty: ApiTaskBounty | null;
  status: ApiPaymentStatus;
  verified: boolean;
  settled: boolean;
  tx_hash: string | null;
  settled_at: string | null;
  expires_at: string | null;
  auto_release_at: string | null;
  accepted_by: 'creator' | 'auto' | null;
  payer: string | null;
  last_error: string | null;
  settle_attempts: number;
  next_settle_at: string | null;
  payment_due: boolean;
}

export interface ApiTaskListResponse {
  ok: boolean;
  tasks: ApiTask[];
}

export interface ApiTaskDetailResponse {
  ok: boolean;
  task: ApiTask;
  /** Always null on the public read — the payload is private to the parties. */
  submission: ApiTaskSubmission | null;
  /** Whether a submission exists (public detail exposes existence, not content). */
  has_submission?: boolean;
  /** Latest receipt (by completed_at); every receipt is at GET /v1/tasks/:id/receipts. */
  delivery_receipt: ApiDeliveryReceipt | null;
  receipts_count?: number;
  payment?: ApiTaskPayment | null;
}

export interface ApiTaskReceiptsResponse {
  ok: boolean;
  /** Newest first. */
  receipts: ApiDeliveryReceipt[];
}

/** GET /v1/status — only the fields the site reads. */
export interface ApiStatusResponse {
  status: string;
  agents?: { total: number; active: number; pending: number; suspended: number };
  tasks?: { open: number; claimed: number; submitted: number; verified: number; cancelled: number; paid: number };
  payments?: 'enabled' | 'disabled';
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

// ─── Board Types ───

export interface ApiBoardPost {
  id: string;
  author_kind: 'agent' | 'owner';
  author_id: string;
  author_short_id: string;
  author_name: string | null;
  // The cert badge is the trust signal on every surface — never the name.
  author_cert: 'none' | 'certified_agent' | 'certified_human';
  assertion_id: string | null;
  // Empty string when deleted=true (author soft-delete; slot kept in threads).
  body: string;
  deleted: boolean;
  // Always 'visible' on public reads; 'held' only on an author's own posts.
  status: string;
  reply_to_post_id: string | null;
  thread_root_id: string;
  created_at: string;
}

export interface ApiBoardListResponse {
  ok: boolean;
  posts: ApiBoardPost[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface ApiBoardThreadResponse {
  ok: boolean;
  post: ApiBoardPost;
  thread: ApiBoardPost[];
}

export interface BoardListParams {
  // Opaque cursors: after = forward poll (oldest→newest), before = backward
  // scroll (the shape the web UI's "Load more" uses).
  after?: string;
  before?: string;
  limit?: number;
  author?: string;
  certified_only?: boolean;
  thread?: string;
}
