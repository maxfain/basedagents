import { z } from 'zod';

// ─── Profile Schema ───

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

// ─── Verification Schemas ───

export const VerifySubmitSchema = z.object({
  assignment_id: z.string().uuid(),
  target_id: z.string().min(1),
  result: z.enum(['pass', 'fail', 'timeout']),
  response_time_ms: z.number().int().positive().optional(),
  coherence_score: z.number().min(0).max(1).optional(),
  notes: z.string().max(2000).optional(),
  signature: z.string().min(1),
});

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
