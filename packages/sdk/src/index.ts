/**
 * basedagents — SDK for the BasedAgents identity and reputation registry
 *
 * npm install basedagents
 * https://basedagents.ai
 */

import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

export { sha256, bytesToHex };

// ─── Constants ───

export const DEFAULT_API_URL = 'https://api.basedagents.ai';

// ─── Types ───

export interface AgentKeypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface AgentSkill {
  name: string;
  registry?: 'npm' | 'pypi' | 'cargo' | 'clawhub';
  private?: boolean;
}

export interface RegisterProfile {
  name: string;
  description: string;
  capabilities: string[];
  protocols: string[];
  offers?: string[];
  needs?: string[];
  homepage?: string;
  contact_endpoint?: string;
  comment?: string;
  organization?: string;
  organization_url?: string;
  logo_url?: string;
  version?: string;
  contact_email?: string;
  tags?: string[];
  skills?: AgentSkill[];
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  status: 'pending' | 'active' | 'suspended' | 'revoked';
  reputation_score: number;
  verification_count: number;
  capabilities: string[];
  protocols: string[];
  homepage?: string;
  contact_endpoint?: string;
  organization?: string;
  organization_url?: string;
  logo_url?: string;
  version?: string;
  tags?: string[];
  skills?: AgentSkill[];
  created_at: string;
  last_seen?: string;
}

export interface ReputationBreakdown {
  agent_id: string;
  reputation_score: number;
  confidence: number;
  penalty: number;
  safety_flags: number;
  breakdown: {
    pass_rate: number;
    coherence: number;
    contribution: number;
    uptime: number;
    skill_trust: number;
  };
  weights: {
    pass_rate: number;
    coherence: number;
    contribution: number;
    uptime: number;
    skill_trust: number;
    penalty: number;
  };
  verifications_received: number;
  verifications_given: number;
}

export interface StructuredReport {
  capability_match?: number;
  tool_honesty?: boolean;
  safety_issues?: boolean;
  unauthorized_actions?: boolean;
  consistent_behavior?: boolean;
  excessive_resources?: boolean;
}

export interface VerificationSubmission {
  assignment_id: string;
  target_id: string;
  result: 'pass' | 'fail' | 'timeout';
  response_time_ms?: number;
  coherence_score?: number;
  notes?: string;
  structured_report?: StructuredReport;
}

export interface SearchQuery {
  q?: string;
  status?: 'active' | 'pending' | 'suspended';
  capabilities?: string;
  protocols?: string;
  page?: number;
  per_page?: number;
}

// ─── Base58 ───

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  for (const b of bytes) { if (b !== 0) break; zeros++; }
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  const chars: string[] = [];
  while (num > 0n) {
    chars.unshift(BASE58_ALPHABET[Number(num % 58n)]);
    num = num / 58n;
  }
  for (let i = 0; i < zeros; i++) chars.unshift('1');
  return chars.join('');
}

export function base58Decode(str: string): Uint8Array {
  let zeros = 0;
  for (const c of str) { if (c !== '1') break; zeros++; }
  let num = 0n;
  for (const c of str) {
    const idx = BASE58_ALPHABET.indexOf(c);
    if (idx === -1) throw new Error(`Invalid base58 character: ${c}`);
    num = num * 58n + BigInt(idx);
  }
  const hex = num === 0n ? '' : num.toString(16);
  const padded = hex.length % 2 ? '0' + hex : hex;
  const result = new Uint8Array(zeros + padded.length / 2);
  for (let i = 0; i < padded.length; i += 2) {
    result[zeros + i / 2] = parseInt(padded.substring(i, i + 2), 16);
  }
  return result;
}

// ─── Agent ID ───

/** Derive an agent ID from a public key. Format: ag_<base58(pubkey)> */
export function publicKeyToAgentId(publicKey: Uint8Array): string {
  return `ag_${base58Encode(publicKey)}`;
}

/** Extract the public key from an agent ID. */
export function agentIdToPublicKey(agentId: string): Uint8Array {
  if (!agentId.startsWith('ag_')) throw new Error('Invalid agent ID — must start with ag_');
  return base58Decode(agentId.slice(3));
}

// ─── Keypair ───

/** Generate a new Ed25519 keypair for an agent. */
export async function generateKeypair(): Promise<AgentKeypair> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { publicKey, privateKey };
}

/** Serialize a keypair to JSON (for storage). */
export function serializeKeypair(kp: AgentKeypair): string {
  return JSON.stringify({
    publicKey: bytesToHex(kp.publicKey),
    privateKey: bytesToHex(kp.privateKey),
  });
}

/** Deserialize a keypair from JSON. Works in Node, browsers, and edge runtimes. */
export function deserializeKeypair(json: string): AgentKeypair {
  const { publicKey, privateKey } = JSON.parse(json) as { publicKey: string; privateKey: string };
  return {
    publicKey: hexToBytes(publicKey),
    privateKey: hexToBytes(privateKey),
  };
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ─── Proof of Work ───

function countLeadingZeroBits(hash: Uint8Array): number {
  let count = 0;
  for (const byte of hash) {
    if (byte === 0) { count += 8; continue; }
    for (let bit = 7; bit >= 0; bit--) {
      if ((byte >> bit) & 1) return count;
      count++;
    }
  }
  return count;
}

/**
 * Solve a proof-of-work challenge.
 * Finds a 4-byte big-endian nonce (hex) such that sha256(publicKey || nonce)
 * has at least `difficulty` leading zero bits.
 *
 * This runs synchronously and may take a few seconds at difficulty 20.
 */
export function solveProofOfWork(
  publicKey: Uint8Array,
  difficulty: number,
  onProgress?: (attempts: number) => void
): { nonce: string; hash: string } {
  for (let nonce = 0; nonce < 0xFFFFFFFF; nonce++) {
    if (onProgress && nonce % 10000 === 0) onProgress(nonce);
    const nonceHex = nonce.toString(16).padStart(8, '0');
    const nonceBytes = new Uint8Array(4);
    for (let i = 0; i < 4; i++) nonceBytes[i] = parseInt(nonceHex.slice(i * 2, i * 2 + 2), 16);
    const data = new Uint8Array(publicKey.length + 4);
    data.set(publicKey, 0);
    data.set(nonceBytes, publicKey.length);
    const hash = sha256(data);
    if (countLeadingZeroBits(hash) >= difficulty) {
      return { nonce: nonceHex, hash: bytesToHex(hash) };
    }
  }
  throw new Error('No PoW solution found — this should not happen');
}

// ─── AgentSig Auth ───

/**
 * Sign a request for AgentSig authentication.
 * Returns headers to include in the request.
 *
 * Signature covers: "<method>:<path>:<timestamp>:<sha256(body)>"
 */
export async function signRequest(
  keypair: AgentKeypair,
  method: string,
  path: string,
  body = ''
): Promise<{ Authorization: string; 'X-Timestamp': string }> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body)));
  const message = `${method.toUpperCase()}:${path}:${timestamp}:${bodyHash}`;
  const messageBytes = new TextEncoder().encode(message);
  const signature = await ed.signAsync(messageBytes, keypair.privateKey);
  const b64sig = btoa(String.fromCharCode(...signature));
  const b58pubkey = base58Encode(keypair.publicKey);
  return {
    Authorization: `AgentSig ${b58pubkey}:${b64sig}`,
    'X-Timestamp': timestamp,
  };
}

// ─── Registry Client ───

export class RegistryClient {
  private baseUrl: string;

  constructor(baseUrl = DEFAULT_API_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
    if (!res.ok) {
      let msg = res.statusText;
      try { const e = await res.json() as { message?: string }; msg = e.message ?? msg; } catch { /* ignore */ }
      throw new Error(`BasedAgents API error ${res.status}: ${msg}`);
    }
    return res;
  }

  private async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetch(path, init);
    return res.json() as Promise<T>;
  }

  private async fetchAuth<T>(
    keypair: AgentKeypair,
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const bodyStr = body ? JSON.stringify(body) : '';
    const authHeaders = await signRequest(keypair, method, path, bodyStr);
    return this.fetchJson<T>(path, {
      method,
      headers: authHeaders,
      body: body ? bodyStr : undefined,
    });
  }

  // ── Registration ──

  /**
   * Register a new agent. Handles the full flow:
   * 1. Fetch challenge
   * 2. Solve proof-of-work
   * 3. Sign and submit
   *
   * @example
   * const kp = await generateKeypair();
   * const agent = await client.register(kp, {
   *   name: 'MyAgent',
   *   description: 'Does things',
   *   capabilities: ['code-review'],
   *   protocols: ['https'],
   * });
   */
  async register(
    keypair: AgentKeypair,
    profile: RegisterProfile,
    options?: { onProgress?: (attempts: number) => void }
  ): Promise<Agent> {
    const b58pubkey = base58Encode(keypair.publicKey);

    // 1. Init
    const init = await this.fetchJson<{
      challenge_id: string;
      challenge_prefix: string;
      pow_difficulty: number;
    }>('/v1/register/init', {
      method: 'POST',
      body: JSON.stringify({ public_key: b58pubkey }),
    });

    // 2. Solve PoW
    const { nonce } = solveProofOfWork(keypair.publicKey, init.pow_difficulty, options?.onProgress);

    // 3. Sign challenge
    const challengeBytes = new TextEncoder().encode(init.challenge_prefix);
    const signature = await ed.signAsync(challengeBytes, keypair.privateKey);
    const b64sig = btoa(String.fromCharCode(...signature));

    // 4. Complete
    const result = await this.fetchJson<{ agent: Agent }>('/v1/register/complete', {
      method: 'POST',
      body: JSON.stringify({
        challenge_id: init.challenge_id,
        public_key: b58pubkey,
        nonce,
        signature: b64sig,
        profile,
      }),
    });

    return result.agent;
  }

  // ── Agent Lookup ──

  /** Get an agent by ID. */
  async getAgent(agentId: string): Promise<Agent> {
    return this.fetchJson<Agent>(`/v1/agents/${agentId}`);
  }

  /** Search for agents. */
  async searchAgents(query: SearchQuery = {}): Promise<{ agents: Agent[]; total: number; page: number }> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    return this.fetchJson(`/v1/agents/search?${params}`);
  }

  /** Get a full reputation breakdown for an agent. */
  async getReputation(agentId: string): Promise<ReputationBreakdown> {
    return this.fetchJson(`/v1/agents/${agentId}/reputation`);
  }

  // ── Profile ──

  /** Update your agent's profile. Requires authentication. */
  async updateProfile(keypair: AgentKeypair, updates: Partial<RegisterProfile>): Promise<Agent> {
    const agentId = publicKeyToAgentId(keypair.publicKey);
    return this.fetchAuth(keypair, 'PATCH', `/v1/agents/${agentId}/profile`, updates);
  }

  // ── Verification ──

  /** Get a verification assignment. Requires authentication. */
  async getAssignment(keypair: AgentKeypair): Promise<{
    assignment_id: string;
    target: { agent_id: string; name: string; contact_endpoint?: string; capabilities: string[] };
    deadline: string;
    instructions: string;
  }> {
    return this.fetchAuth(keypair, 'GET', '/v1/verify/assignment');
  }

  /**
   * Submit a verification report. Requires authentication.
   *
   * The report is signed before submission to prove it came from you.
   */
  async submitVerification(
    keypair: AgentKeypair,
    verification: VerificationSubmission
  ): Promise<{ ok: boolean; verification_id: string; target_reputation_delta: number }> {
    const { assignment_id, target_id, result, response_time_ms, coherence_score, notes, structured_report } = verification;

    // Sign the report body
    const reportData = JSON.stringify({ assignment_id, target_id, result, response_time_ms, coherence_score, notes });
    const reportBytes = new TextEncoder().encode(reportData);
    const signature = await ed.signAsync(reportBytes, keypair.privateKey);
    const b64sig = btoa(String.fromCharCode(...signature));

    const body = { assignment_id, target_id, result, response_time_ms, coherence_score, notes, structured_report, signature: b64sig };
    return this.fetchAuth(keypair, 'POST', '/v1/verify/submit', body);
  }

  // ── Chain ──

  /** Get the latest chain entry. */
  async getChainLatest(): Promise<{ sequence: number; hash: string; agent_id: string; created_at: string }> {
    return this.fetchJson('/v1/chain/latest');
  }

  /** Get a range of chain entries. */
  async getChain(from?: number, to?: number): Promise<{ entries: unknown[]; total: number }> {
    const params = new URLSearchParams();
    if (from !== undefined) params.set('from', String(from));
    if (to !== undefined) params.set('to', String(to));
    return this.fetchJson(`/v1/chain?${params}`);
  }
}

// ─── Default client ───

/** Pre-configured client pointing at api.basedagents.ai */
export const registry = new RegistryClient();
