import { z } from 'zod';

// ─── Profile Schema ───

export const SkillSchema = z.object({
  name: z.string().min(1).max(100),
  registry: z.enum(['npm', 'clawhub', 'pypi']).optional().default('npm'),
  version: z.string().max(50).optional(),
  private: z.boolean().optional().default(false),
});

export type DeclaredSkill = z.infer<typeof SkillSchema>;

export const ProfileSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(1000),
  capabilities: z.array(z.string()).min(1),
  protocols: z.array(z.string()).min(1),
  offers: z.array(z.string()).optional(),
  needs: z.array(z.string()).optional(),
  homepage: z.string().url().optional(),
  contact_endpoint: z.string().url().optional(),
  comment: z.string().max(500).optional(),
  organization: z.string().max(100).optional(),
  organization_url: z.string().url().optional(),
  logo_url: z.string().url().optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  version: z.string().max(50).optional(),
  contact_email: z.string().email().optional(),
  x_handle: z.string().max(50).regex(/^@?[A-Za-z0-9_]{1,50}$/).optional(),
  skills: z.array(SkillSchema).max(50).optional(),
  webhook_url: z.union([z.string().url().max(500), z.literal(''), z.null()]).optional(),
});

export type Profile = z.infer<typeof ProfileSchema>;

// ─── Registration Schemas ───

export const RegisterInitSchema = z.object({
  public_key: z.string().min(1),
});

export const RegisterCompleteSchema = z.object({
  challenge_id: z.string().uuid(),
  public_key: z.string().min(1),
  signature: z.string().min(1),
  nonce: z.string().min(1),
  profile: ProfileSchema,
});

// ─── Structured Verification Report ───

export const StructuredReportSchema = z.object({
  // Capability honesty (0-1): did the agent actually do what it claims?
  capability_match: z.number().min(0).max(1).optional(),
  // Tool honesty: did it only use declared tools/skills?
  tool_honesty: z.boolean().optional(),
  // Safety: did it attempt unsafe actions, prompt injection, or data exfiltration?
  safety_issues: z.boolean().optional(),
  // Authorization: did it access data outside declared permissions?
  unauthorized_actions: z.boolean().optional(),
  // Reliability: was behavior consistent across the interaction?
  consistent_behavior: z.boolean().optional(),
  // Resource usage: did it consume excessive tokens or make unexpected calls?
  excessive_resources: z.boolean().optional(),
}).optional();

export type StructuredReport = z.infer<typeof StructuredReportSchema>;

// ─── Verification Schemas ───

export const VerifySubmitSchema = z.object({
  assignment_id: z.string().uuid(),
  target_id: z.string().min(1),
  result: z.enum(['pass', 'fail', 'timeout']),
  response_time_ms: z.number().int().positive().optional(),
  coherence_score: z.number().min(0).max(1).optional(),
  notes: z.string().max(2000).optional(),
  structured_report: StructuredReportSchema,
  // Anti-replay: client-generated nonce (UUID). Stored and checked for uniqueness.
  nonce: z.string().uuid(),
  signature: z.string().min(1),
});

// ─── Task Schemas ───

export const CreateTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(10000),
  category: z.enum(['research', 'code', 'content', 'data', 'automation']).optional(),
  required_capabilities: z.array(z.string()).optional(),
  expected_output: z.string().max(2000).optional(),
  output_format: z.enum(['json', 'link']).default('json'),
});

export const SubmitDeliverableSchema = z.object({
  submission_type: z.enum(['json', 'link']),
  content: z.string().min(1).max(50000),
  summary: z.string().min(1).max(2000),
});

export const DeliverTaskSchema = z.object({
  summary: z.string().min(1).max(2000),
  artifact_urls: z.array(z.string().url()).optional(),
  commit_hash: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  pr_url: z.string().url().optional(),
  submission_type: z.enum(['json', 'link', 'pr']),
  submission_content: z.string().max(50000).optional(),
});

export const TaskQuerySchema = z.object({
  status: z.enum(['open', 'claimed', 'submitted', 'verified', 'closed', 'cancelled']).optional(),
  category: z.enum(['research', 'code', 'content', 'data', 'automation']).optional(),
  capability: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

// ─── Task Types ───

export interface Task {
  task_id: string;
  creator_agent_id: string;
  claimed_by_agent_id: string | null;
  title: string;
  description: string;
  category: string | null;
  required_capabilities: string | null; // JSON array
  expected_output: string | null;
  output_format: string;
  status: 'open' | 'claimed' | 'submitted' | 'verified' | 'closed' | 'cancelled';
  created_at: string;
  claimed_at: string | null;
  submitted_at: string | null;
  verified_at: string | null;
}

export interface Submission {
  submission_id: string;
  task_id: string;
  agent_id: string;
  submission_type: 'json' | 'link';
  content: string;
  summary: string;
  created_at: string;
}

export interface DeliveryReceipt {
  receipt_id: string;
  task_id: string;
  agent_id: string;
  summary: string;
  artifact_urls: string | null;     // JSON array of URLs
  commit_hash: string | null;
  pr_url: string | null;
  submission_type: 'json' | 'link' | 'pr';
  submission_content: string | null;
  completed_at: string;
  chain_sequence: number | null;
  chain_entry_hash: string | null;
  signature: string;
}

// ─── Message Schemas ───

export const SendMessageSchema = z.object({
  type: z.enum(['task_request', 'message']).default('message'),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10000),
  callback_url: z.string().url().max(500).optional(),
});

export const MessageQuerySchema = z.object({
  status: z.enum(['pending', 'delivered', 'read', 'replied', 'expired']).optional(),
  type: z.enum(['task_request', 'message']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

// ─── Message Types ───

export interface Message {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  type: 'task_request' | 'message';
  subject: string;
  body: string;
  status: 'pending' | 'delivered' | 'read' | 'replied' | 'expired';
  callback_url: string | null;
  reply_to_message_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

// ─── Agent Types ───

export interface Agent {
  id: string;
  public_key: Uint8Array;
  name: string;
  description: string;
  capabilities: string; // JSON array
  protocols: string;    // JSON array
  offers: string | null;
  needs: string | null;
  homepage: string | null;
  contact_endpoint: string | null;
  comment: string | null;
  organization: string | null;
  organization_url: string | null;
  logo_url: string | null;
  tags: string | null; // JSON array
  version: string | null;
  contact_email: string | null;
  x_handle: string | null;
  skills: string | null; // JSON array of DeclaredSkill
  webhook_url: string | null;
  registered_at: string;
  last_seen: string | null;
  status: 'pending' | 'active' | 'suspended';
  reputation_score: number;
  verification_count: number;
}

export interface Verification {
  id: string;
  verifier_id: string;
  target_id: string;
  result: 'pass' | 'fail' | 'timeout';
  response_time_ms: number | null;
  coherence_score: number | null;
  notes: string | null;
  signature: string;
  created_at: string;
}

export interface Challenge {
  id: string;
  agent_id: string;
  challenge_bytes: string;
  status: 'pending' | 'completed' | 'expired';
  created_at: string;
  expires_at: string;
}

export interface ChainEntry {
  sequence: number;
  entry_hash: string;
  previous_hash: string;
  agent_id: string;
  public_key: Uint8Array;
  nonce: string;
  profile_hash: string;
  timestamp: string;
}

// ─── API Response Types ───

export interface ApiError {
  error: string;
  message: string;
}

export interface RegisterInitResponse {
  challenge_id: string;
  challenge: string;
  difficulty: number;
  previous_hash: string;
  expires_at: string;
}

export interface RegisterCompleteResponse {
  agent_id: string;
  status: string;
  chain_sequence: number;
  entry_hash: string;
  message: string;
}

// ─── App Context Variables (set by middleware) ───

import type { DBAdapter } from '../db/adapter.js';

export type Variables = {
  db: DBAdapter;
  agentId: string;
  publicKey: Uint8Array;
  agentStatus: string;
};

// ─── App Bindings (for Cloudflare Workers + local) ───

export type Bindings = {
  DB?: D1Database;
  BOOTSTRAP_THRESHOLD?: string;
  ADMIN_SECRET?: string;
  REGISTRY_SIGNING_KEY?: string;
  REGISTRY_SIGNING_PUBLIC_KEY?: string;
  TWITTER_CONSUMER_KEY?: string;
  TWITTER_CONSUMER_SECRET?: string;
  TWITTER_ACCESS_TOKEN?: string;
  TWITTER_ACCESS_SECRET?: string;
};

/** Hono env type combining Bindings and Variables */
export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};

// D1Database type stub for when not running on CF
declare global {
  interface D1Database {
    prepare(query: string): D1PreparedStatement;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
    exec(query: string): Promise<D1ExecResult>;
  }
  interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = unknown>(colName?: string): Promise<T | null>;
    run<T = unknown>(): Promise<D1Result<T>>;
    all<T = unknown>(): Promise<D1Result<T>>;
    raw<T = unknown>(): Promise<T[]>;
  }
  interface D1Result<T = unknown> {
    results: T[];
    success: boolean;
    meta: Record<string, unknown>;
  }
  interface D1ExecResult {
    count: number;
    duration: number;
  }
}
