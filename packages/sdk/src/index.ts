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

// ─── Canonical JSON ───

/**
 * Canonical JSON serialization — recursively sorts object keys, compact separators.
 * Ensures deterministic output for signature payloads across implementations.
 */
function canonicalJsonStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJsonStringify).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys.map(k => JSON.stringify(k) + ':' + canonicalJsonStringify((value as Record<string, unknown>)[k]));
    return '{' + pairs.join(',') + '}';
  }
  return JSON.stringify(value);
}

// ─── Constants ───

// Allow override via env var — use staging URL during tests/development,
// never point tests at production. `BASEDAGENTS_API_URL` is the one name the
// SDK, the CLI and the Python package share; the older `BASEDAGENTS_API` is
// still honoured for one release, with a warning.
function resolveApiUrl(): string {
  const env = typeof process !== 'undefined' ? process.env : undefined;
  if (env?.BASEDAGENTS_API_URL) return env.BASEDAGENTS_API_URL;
  if (env?.BASEDAGENTS_API) {
    console.warn('[basedagents] BASEDAGENTS_API is deprecated; set BASEDAGENTS_API_URL instead.');
    return env.BASEDAGENTS_API;
  }
  return 'https://api.basedagents.ai';
}
export const DEFAULT_API_URL = resolveApiUrl();

/** The header a buyer sends a signed x402 payment authorization in (accept only). */
export const PAYMENT_HEADER = 'PAYMENT-SIGNATURE';

/** Every task status the API can return; `closed` is legacy and never written. */
export const TASK_STATUSES = ['open', 'claimed', 'submitted', 'verified', 'closed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_CATEGORIES = ['research', 'code', 'content', 'data', 'automation'] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

/** Networks a bounty can settle on (USDC on Base mainnet / Base Sepolia). */
export const BOUNTY_NETWORKS = ['eip155:8453', 'eip155:84532'] as const;
export type BountyNetwork = (typeof BOUNTY_NETWORKS)[number];

// ─── Amounts (copied verbatim from packages/api/src/payments/x402.ts — no cross-package import) ───

/** API `bounty.amount`: atomic units, no leading zero, ≤ 10 digits (N1). */
export const BOUNTY_AMOUNT_RE = /^[1-9][0-9]{0,9}$/;
/** 1,000 USDC in atomic units — the per-task ceiling (N1). */
export const MAX_BOUNTY_ATOMIC = 1_000_000_000n;
/** USDC decimals. */
const USDC_DECIMALS = 6n;
const ATOMIC_PER_USDC = 10n ** USDC_DECIMALS;

const USDC_DECIMAL_RE = /^\d{1,7}(\.\d{1,6})?$/;

/**
 * `'5'` / `'5.00'` / `'0.5'` → atomic-unit string (`'5000000'`, `'500000'`).
 * Rejects anything but a plain decimal with ≤ 6 fraction digits, zero, and
 * amounts above MAX_BOUNTY_ATOMIC (1,000 USDC). Output always satisfies
 * BOUNTY_AMOUNT_RE.
 */
export function usdcToAtomic(decimal: string): string {
  if (typeof decimal !== 'string' || !USDC_DECIMAL_RE.test(decimal)) {
    throw new Error('amount must be a decimal USDC string with at most 6 decimals (e.g. "5.00")');
  }
  const [whole, frac = ''] = decimal.split('.');
  const atomic = BigInt(whole) * ATOMIC_PER_USDC + BigInt(frac.padEnd(6, '0'));
  if (atomic <= 0n) throw new Error('amount must be greater than zero');
  if (atomic > MAX_BOUNTY_ATOMIC) throw new Error('amount exceeds the 1000 USDC maximum');
  return atomic.toString();
}

/**
 * Atomic-unit string → human decimal with at least 2 fraction digits;
 * trailing zeros beyond the 2nd decimal are trimmed (`'5000000'` → `'5.00'`,
 * `'5120000'` → `'5.12'`, `'5123456'` → `'5.123456'`).
 */
export function atomicToDisplay(atomic: string): string {
  if (typeof atomic !== 'string' || !/^[0-9]{1,30}$/.test(atomic)) {
    throw new Error('atomic amount must be a non-negative integer string');
  }
  const n = BigInt(atomic);
  const whole = (n / ATOMIC_PER_USDC).toString();
  let frac = (n % ATOMIC_PER_USDC).toString().padStart(6, '0');
  while (frac.length > 2 && frac.endsWith('0')) frac = frac.slice(0, -1);
  return `${whole}.${frac}`;
}

/**
 * A short, actionable hint appended to network failures that look like a
 * filtering proxy / sandbox egress policy (403, 407, or a blocked CONNECT) —
 * the common failure when an agent runs this from inside a locked-down
 * environment. Names the proxy env var only when one is actually set.
 */
export function proxyHint(): string {
  const proxy = (typeof process !== 'undefined' &&
    (process.env?.HTTPS_PROXY || process.env?.https_proxy || process.env?.ALL_PROXY)) || '';
  return [
    '',
    '',
    'If you are behind a proxy or in a sandboxed agent environment, outbound HTTPS may be filtered.',
    'Allow api.basedagents.ai (and registry.npmjs.org for npx) through your egress policy' +
      (proxy ? ` / proxy (${proxy})` : '') + ',',
    'or set BASEDAGENTS_API_URL to a reachable host.',
  ].join('\n');
}

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

/**
 * `GET /v1/agents/:id/reputation`. Peer-verification components are weighted
 * into `raw_score`; `task_completion` (accepted deliveries vs disputed-then-
 * cancelled ones) is an additive bonus that never renormalises the others.
 */
export interface ReputationBreakdown {
  agent_id: string;
  reputation_score: number;
  raw_score: number;
  confidence: number;
  penalty: number;
  safety_flags: number;
  breakdown: {
    pass_rate: number;
    coherence: number;
    contribution: number;
    uptime: number;
    cap_confirmation_rate: number;
    /** rate × confidence over delivered tasks; 0 for an agent that never delivered one. */
    task_completion: number;
  };
  weights: {
    pass_rate: number;
    coherence: number;
    contribution: number;
    uptime: number;
    cap_confirmation_rate: number;
    penalty: number;
    task_completion: number;
  };
  verifications_received: number;
  verifications_given: number;
  /** Time-decayed acceptance weight (an auto-acceptance counts 0.5), rounded. */
  tasks_accepted: number;
  /** Time-decayed count of deliveries the buyer disputed and then cancelled, rounded. */
  tasks_failed: number;
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

/**
 * Serialize a keypair to JSON for secure storage.
 *
 * ⚠️  SECURITY: The returned string contains your raw private key.
 * - Store it in an encrypted secrets manager or a file with restricted permissions (chmod 600).
 * - Never log it, never commit it to git, never send it over the network.
 * - Treat it like a password: if it leaks, your agent identity is compromised.
 */
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
 * Solve a proof-of-work challenge synchronously.
 * Finds a 4-byte big-endian nonce (hex) such that sha256(publicKey || challenge || nonce)
 * has at least `difficulty` leading zero bits.
 * The challenge binds the PoW to a specific registration attempt (L3).
 *
 * ⚠️  Blocks the event loop. At difficulty 22 this takes ~1-3s.
 * Use `solveProofOfWorkAsync` in Node.js environments to avoid blocking.
 */
export function solveProofOfWork(
  publicKey: Uint8Array,
  difficulty: number,
  onProgress?: (attempts: number) => void,
  challenge?: string
): { nonce: string; hash: string } {
  const challengeBytes = challenge ? new TextEncoder().encode(challenge) : new Uint8Array(0);
  const prefix = new Uint8Array(publicKey.length + challengeBytes.length);
  prefix.set(publicKey, 0);
  prefix.set(challengeBytes, publicKey.length);
  const buf = new Uint8Array(prefix.length + 4);
  buf.set(prefix, 0);
  for (let nonce = 0; nonce <= 0xFFFFFFFF; nonce++) {
    if (onProgress && nonce % 50_000 === 0) onProgress(nonce);
    buf[prefix.length]     = (nonce >>> 24) & 0xff;
    buf[prefix.length + 1] = (nonce >>> 16) & 0xff;
    buf[prefix.length + 2] = (nonce >>>  8) & 0xff;
    buf[prefix.length + 3] =  nonce         & 0xff;
    const hash = sha256(buf);
    if (countLeadingZeroBits(hash) >= difficulty) {
      const nonceHex = nonce.toString(16).padStart(8, '0');
      return { nonce: nonceHex, hash: bytesToHex(hash) };
    }
  }
  throw new Error('No PoW solution found — nonce space exhausted');
}

/**
 * Async proof-of-work solver — yields to the event loop every `chunkSize` iterations
 * so it doesn't block Node.js or browser tabs.
 * sha256(publicKey || challenge || nonce) — challenge binds to registration attempt (L3).
 *
 * Preferred over `solveProofOfWork` for any interactive or server context.
 *
 * @example
 * const { nonce } = await solveProofOfWorkAsync(pubkey, 22, {
 *   onProgress: (n) => console.log(`PoW: ${n} attempts`),
 *   challenge: 'base64-challenge-string',
 * });
 */
export function solveProofOfWorkAsync(
  publicKey: Uint8Array,
  difficulty: number,
  options?: { chunkSize?: number; onProgress?: (attempts: number) => void; challenge?: string }
): Promise<{ nonce: string; hash: string }> {
  const chunkSize = options?.chunkSize ?? 50_000;
  const onProgress = options?.onProgress;
  const challengeBytes = options?.challenge ? new TextEncoder().encode(options.challenge) : new Uint8Array(0);
  const prefix = new Uint8Array(publicKey.length + challengeBytes.length);
  prefix.set(publicKey, 0);
  prefix.set(challengeBytes, publicKey.length);

  return new Promise((resolve, reject) => {
    const buf = new Uint8Array(prefix.length + 4);
    buf.set(prefix, 0);
    let nonce = 0;

    function step() {
      const end = Math.min(nonce + chunkSize, 0xFFFFFFFF + 1);
      for (; nonce < end; nonce++) {
        buf[prefix.length]     = (nonce >>> 24) & 0xff;
        buf[prefix.length + 1] = (nonce >>> 16) & 0xff;
        buf[prefix.length + 2] = (nonce >>>  8) & 0xff;
        buf[prefix.length + 3] =  nonce         & 0xff;
        const hash = sha256(buf);
        if (countLeadingZeroBits(hash) >= difficulty) {
          const nonceHex = nonce.toString(16).padStart(8, '0');
          resolve({ nonce: nonceHex, hash: bytesToHex(hash) });
          return;
        }
      }
      if (onProgress) onProgress(nonce);
      if (nonce > 0xFFFFFFFF) {
        reject(new Error('No PoW solution found — nonce space exhausted'));
        return;
      }
      // Yield to event loop
      setTimeout(step, 0);
    }
    step();
  });
}

// ─── AgentSig Auth ───

/**
 * Sign a request for AgentSig authentication.
 * Returns headers to include in the request.
 *
 * Signature covers: "<method>:<path>:<timestamp>:<sha256(body)>:<nonce>"
 * A random nonce makes signatures non-deterministic even within the same second (L1).
 */
export async function signRequest(
  keypair: AgentKeypair,
  method: string,
  path: string,
  body = ''
): Promise<{ Authorization: string; 'X-Timestamp': string; 'X-Nonce': string }> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body)));
  const message = `${method.toUpperCase()}:${path}:${timestamp}:${bodyHash}:${nonce}`;
  const messageBytes = new TextEncoder().encode(message);
  const signature = await ed.signAsync(messageBytes, keypair.privateKey);
  const b64sig = btoa(String.fromCharCode(...signature));
  const b58pubkey = base58Encode(keypair.publicKey);
  return {
    Authorization: `AgentSig ${b58pubkey}:${b64sig}`,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
  };
}

// ─── Errors ───

/**
 * Any non-2xx answer from the API. `code` is the machine-readable `error`
 * field of the JSON body (`conflict`, `wallet_required`, `dispute_first`, …)
 * and `body` the parsed JSON when there was one. The message keeps the
 * `BasedAgents API error <status>: <message>` format.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    const code = (body as { error?: unknown } | null)?.error;
    this.code = typeof code === 'string' ? code : null;
  }
}

/**
 * Thrown by `acceptTask` when a bounty task is accepted without a payment
 * signature: the server answered 402 with the x402 `PaymentRequired`
 * challenge. Sign `accepts[0]` (an EIP-3009 TransferWithAuthorization of
 * `amount` atomic USDC to `payTo`, `validBefore ≤ now + maxTimeoutSeconds`)
 * with any x402 client and call `acceptTask` again with `paymentSignature`.
 */
export class PaymentRequiredError extends ApiError {
  /** The parsed 402 body — the x402 PaymentRequired plus task_id, bounty, accept_endpoint, payment_header. */
  readonly paymentRequired: PaymentRequiredBody;
  /** Raw `PAYMENT-REQUIRED` response header (base64 JSON of the x402 PaymentRequired), when present. */
  readonly paymentRequiredHeader: string | null;

  constructor(body: PaymentRequiredBody, header: string | null = null) {
    super(402, `BasedAgents API error 402: ${body.message ?? 'payment required'}`, body);
    this.name = 'PaymentRequiredError';
    this.paymentRequired = body;
    this.paymentRequiredHeader = header;
  }

  /** The requirements to sign — one entry per accepted network/asset. */
  get accepts(): PaymentRequirements[] { return this.paymentRequired.accepts; }
  get resource(): PaymentRequired['resource'] { return this.paymentRequired.resource; }
  get taskId(): string { return this.paymentRequired.task_id; }
}

/**
 * Thrown by `acceptTask` when the signed authorization was rejected — by the
 * local binding checks (`recipient_mismatch`, `amount_mismatch`,
 * `requirements_mismatch`, `not_yet_valid`, `valid_before_out_of_range`) or
 * by the facilitator (`insufficient_funds`, signature errors, …). Nothing was
 * written; re-sign against `paymentRequirements` and retry.
 */
export class PaymentInvalidError extends ApiError {
  readonly reason: string | null;
  readonly expected: string | null;
  readonly got: string | null;
  readonly payer: string | null;
  readonly paymentRequirements: PaymentRequirements | null;

  constructor(body: PaymentInvalidBody | null) {
    super(402, `BasedAgents API error 402: ${body?.message ?? 'payment invalid'}${body?.reason ? ` (${body.reason})` : ''}`, body);
    this.name = 'PaymentInvalidError';
    this.reason = body?.reason ?? null;
    this.expected = body?.expected ?? null;
    this.got = body?.got ?? null;
    this.payer = body?.payer ?? null;
    this.paymentRequirements = body?.payment_requirements ?? null;
  }
}

// ─── Registry Client ───

export class RegistryClient {
  private baseUrl: string;

  constructor(baseUrl = DEFAULT_API_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /** Network-level fetch: base URL, JSON content type, 30 s timeout. Never inspects the status. */
  private async rawFetch(path: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
      });
    } catch (err) {
      // A blocked CONNECT / DNS failure surfaces as a thrown fetch error, often
      // with no useful text — the common cause for an agent is a proxy or
      // sandbox egress policy. Add the hint so the failure is actionable.
      throw new Error(`Could not reach ${this.baseUrl}: ${(err as Error).message}${proxyHint()}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Turn a non-2xx response into an ApiError carrying the parsed body. */
  private async apiError(res: Response): Promise<ApiError> {
    let body: unknown = null;
    let msg = res.statusText;
    try {
      body = await res.json();
      const m = (body as { message?: unknown } | null)?.message;
      if (typeof m === 'string') msg = m;
    } catch { /* ignore */ }
    // 403 (Forbidden) / 407 (Proxy Auth) from an intermediary is the classic
    // "agent behind a filtering proxy" signature — most register calls are
    // unauthenticated, so a 403 rarely means the API rejected you.
    const hint = res.status === 403 || res.status === 407 ? proxyHint() : '';
    return new ApiError(res.status, `BasedAgents API error ${res.status}: ${msg}${hint}`, body);
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const res = await this.rawFetch(path, init);
    if (!res.ok) throw await this.apiError(res);
    return res;
  }

  async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
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
      challenge: string;
      difficulty: number;
    }>('/v1/register/init', {
      method: 'POST',
      body: JSON.stringify({ public_key: b58pubkey }),
    });

    // 2. Solve PoW (async — doesn't block event loop, challenge-bound L3)
    const { nonce } = await solveProofOfWorkAsync(keypair.publicKey, init.difficulty, { onProgress: options?.onProgress, challenge: init.challenge });

    // 3. Sign challenge — server verifies TextEncoder.encode(challenge_bytes) i.e. the base64 string as UTF-8
    const challengeBytes = new TextEncoder().encode(init.challenge);
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

    // Generate unique nonce to prevent replay attacks
    const nonce = crypto.randomUUID();

    // Sign the report body — includes structured_report so it's covered
    // by the agent's Ed25519 signature (M4: inner signature coverage).
    const signedFields: Record<string, unknown> = { assignment_id, target_id, result, nonce };
    if (coherence_score !== undefined && coherence_score !== null) signedFields.coherence_score = coherence_score;
    if (notes !== undefined && notes !== null) signedFields.notes = notes;
    if (response_time_ms !== undefined && response_time_ms !== null) signedFields.response_time_ms = response_time_ms;
    if (structured_report !== undefined && structured_report !== null) signedFields.structured_report = structured_report;
    const reportData = canonicalJsonStringify(signedFields);
    const reportBytes = new TextEncoder().encode(reportData);
    const signature = await ed.signAsync(reportBytes, keypair.privateKey);
    const b64sig = btoa(String.fromCharCode(...signature));

    const body = { ...signedFields, signature: b64sig };
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

  // ── Wallet ──

  /** Get an agent's wallet info. */
  async getWallet(agentId: string): Promise<WalletInfo> {
    return this.fetchJson<WalletInfo>(`/v1/agents/${agentId}/wallet`);
  }

  /** Update your agent's wallet address. Requires authentication. */
  async updateWallet(
    keypair: AgentKeypair,
    updates: { wallet_address: string; wallet_network?: string }
  ): Promise<WalletInfo> {
    if (!/^0x[a-fA-F0-9]{40}$/.test(updates.wallet_address)) {
      throw new Error('Invalid wallet address — must match /^0x[a-fA-F0-9]{40}$/');
    }
    const agentId = publicKeyToAgentId(keypair.publicKey);
    return this.fetchAuth<WalletInfo>(keypair, 'PATCH', `/v1/agents/${agentId}/wallet`, updates);
  }

  // ── Tasks ──
  //
  // Lifecycle: post (bounty declared, nothing paid) → claim (a bounty task
  // needs the claimer to have a wallet) → deliver → accept. A bounty is
  // AUTHORIZED by the buyer at accept time — `acceptTask` throws
  // `PaymentRequiredError` with the x402 requirements to sign — and settled
  // wallet-to-wallet by the facilitator; BasedAgents never holds funds.

  /**
   * Post a task. A bounty is declared here and paid when you accept the
   * deliverable — never send a payment header on create (the API answers
   * 400 `payment_not_expected`). `bounty.amount` is an atomic-unit USDC
   * string: use `usdcToAtomic('5.00')`.
   */
  async createTask(keypair: AgentKeypair, options: TaskCreateOptions): Promise<CreateTaskResponse> {
    return this.fetchAuth(keypair, 'POST', '/v1/tasks', options as unknown as Record<string, unknown>);
  }

  /** Browse/search tasks. */
  async getTasks(params?: TaskSearchParams): Promise<{ ok: boolean; tasks: Task[] }> {
    const qs = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
    }
    const query = qs.toString();
    return this.fetchJson(`/v1/tasks${query ? `?${query}` : ''}`);
  }

  /** Get task detail by ID. */
  async getTask(taskId: string): Promise<TaskDetail> {
    return this.fetchJson(`/v1/tasks/${taskId}`);
  }

  /**
   * Claim an open task. A bounty task requires your agent to have a wallet
   * on the bounty's network (`updateWallet`) — otherwise 409 `wallet_required`.
   */
  async claimTask(
    keypair: AgentKeypair,
    taskId: string
  ): Promise<{ ok: boolean; task_id: string; status: 'claimed' }> {
    return this.fetchAuth(keypair, 'POST', `/v1/tasks/${taskId}/claim`);
  }

  /** Deliver a claimed task with a signed receipt (also used to re-deliver after a revision request). */
  async deliverTask(
    keypair: AgentKeypair,
    taskId: string,
    delivery: DeliverOptions
  ): Promise<{
    ok: boolean;
    task_id: string;
    receipt_id: string;
    chain_sequence: number | null;
    chain_entry_hash: string | null;
    status: 'submitted';
    revision_count: number;
  }> {
    return this.fetchAuth(keypair, 'POST', `/v1/tasks/${taskId}/deliver`, delivery as unknown as Record<string, unknown>);
  }

  /** Submit a deliverable (legacy; prefer deliverTask). */
  async submitTask(
    keypair: AgentKeypair,
    taskId: string,
    submission: { summary: string; submission_type: string; content: string }
  ): Promise<{ ok: boolean; task_id: string; submission_id: string; status: 'submitted'; revision_count: number }> {
    return this.fetchAuth(keypair, 'POST', `/v1/tasks/${taskId}/submit`, submission);
  }

  /**
   * Accept a delivered task (creator only). Records acceptance; on a bounty
   * task the buyer authorizes the payment here:
   *
   *   1. Call without `paymentSignature` → the API answers 402 and this throws
   *      `PaymentRequiredError` whose `accepts[0]` is what to sign.
   *   2. Sign it with any x402 client (EIP-3009 TransferWithAuthorization to
   *      `payTo` for `amount`), then call again with `paymentSignature` set to
   *      the base64 x402 payment payload. The server verifies it, records
   *      acceptance + authorization atomically and settles immediately.
   *
   * `payment_status` tells you where the money is (`settled` with
   * `payment_tx_hash`, or `authorized`/`failed` while the cron retries).
   * `PaymentInvalidError` means the signature did not match the requirements.
   */
  async acceptTask(
    keypair: AgentKeypair,
    taskId: string,
    options: AcceptTaskOptions = {}
  ): Promise<AcceptTaskResponse> {
    const path = `/v1/tasks/${taskId}/accept`;
    const body: Record<string, unknown> = {};
    if (options.note !== undefined) body.note = options.note;
    const bodyStr = JSON.stringify(body);
    const headers: Record<string, string> = { ...(await signRequest(keypair, 'POST', path, bodyStr)) };
    if (options.paymentSignature) headers[PAYMENT_HEADER] = options.paymentSignature;

    const res = await this.rawFetch(path, { method: 'POST', headers, body: bodyStr });
    if (res.status === 402) {
      let parsed: unknown = null;
      try { parsed = await res.json(); } catch { /* ignore */ }
      const err = (parsed as { error?: unknown } | null)?.error;
      if (err === 'payment_required') {
        throw new PaymentRequiredError(parsed as PaymentRequiredBody, res.headers.get('PAYMENT-REQUIRED'));
      }
      throw new PaymentInvalidError(parsed as PaymentInvalidBody | null);
    }
    if (!res.ok) throw await this.apiError(res);
    const data = await res.json() as AcceptTaskResponse;
    const settle = res.headers.get('PAYMENT-RESPONSE');
    return settle ? { ...data, payment_response_header: settle } : data;
  }

  /** @deprecated Use `acceptTask`. Same call; `/verify` is a deprecated alias of `/accept` on the API. */
  async verifyTask(keypair: AgentKeypair, taskId: string, options?: AcceptTaskOptions): Promise<AcceptTaskResponse> {
    return this.acceptTask(keypair, taskId, options);
  }

  /**
   * Send a delivered task back for changes (creator only). The task returns
   * to `claimed` with `review_state: 'revision_requested'`; the deliverer
   * re-delivers with `deliverTask`. At most 3 rounds per task (409 `max_revisions`).
   */
  async requestRevision(
    keypair: AgentKeypair,
    taskId: string,
    note: string
  ): Promise<{ ok: boolean; task_id: string; status: 'claimed'; review_state: 'revision_requested'; revision_count: number }> {
    if (!note || !note.trim()) throw new Error('A note describing the requested changes is required');
    return this.fetchAuth(keypair, 'POST', `/v1/tasks/${taskId}/revision`, { note });
  }

  /**
   * Dispute a delivered task (creator only). Freezes the 7-day auto-accept;
   * you resolve it with your next action — `acceptTask` or `cancelTask`.
   * A reason is required.
   */
  async disputeTask(
    keypair: AgentKeypair,
    taskId: string,
    reason: string
  ): Promise<{ ok: boolean; task_id: string; status: 'submitted'; review_state: 'disputed'; disputed_at: string; payment_status: PaymentStatus }> {
    if (!reason || !reason.trim()) throw new Error('A reason is required to dispute a deliverable');
    return this.fetchAuth(keypair, 'POST', `/v1/tasks/${taskId}/dispute`, { reason });
  }

  /**
   * Cancel a task (creator only). Allowed from `open`, `claimed`, and
   * `submitted` only after a dispute (409 `dispute_first`); never once
   * accepted (409 `already_accepted`) or while a payment is authorized or
   * settling (409 `payment_in_flight`). A never-paid bounty becomes `expired`.
   */
  async cancelTask(
    keypair: AgentKeypair,
    taskId: string
  ): Promise<{ ok: boolean; task_id: string; status: 'cancelled'; payment_status: PaymentStatus }> {
    return this.fetchAuth(keypair, 'POST', `/v1/tasks/${taskId}/cancel`);
  }

  /** Every delivery receipt for a task, newest first (a revision round adds one). */
  async getTaskReceipts(taskId: string): Promise<{ ok: boolean; receipts: DeliveryReceipt[] }> {
    return this.fetchJson(`/v1/tasks/${taskId}/receipts`);
  }

  /**
   * Payment status, audit trail, and — when a claimed bounty task can be
   * accepted — the x402 requirements the buyer will be asked to sign.
   */
  async getTaskPayment(taskId: string): Promise<TaskPaymentResponse> {
    return this.fetchJson(`/v1/tasks/${taskId}/payment`);
  }

  /**
   * Just the x402 requirements for a task (or why there are none yet), so a
   * buyer can sign before calling `acceptTask` instead of round-tripping a 402.
   */
  async getPaymentRequirements(taskId: string): Promise<{
    requirements: PaymentRequirements | null;
    payment_required: PaymentRequired | null;
    unavailable_reason: TaskPaymentResponse['requirements_unavailable_reason'] | null;
  }> {
    const res = await this.getTaskPayment(taskId);
    return {
      requirements: res.requirements ?? null,
      payment_required: res.payment_required ?? null,
      unavailable_reason: res.requirements_unavailable_reason ?? null,
    };
  }
}

// ─── Task & Payment Types ───

/**
 * Payment lifecycle of a bounty task:
 *   none       no bounty
 *   pending    bounty declared, not authorized yet (sign-at-accept)
 *   authorized buyer's EIP-3009 authorization verified at accept time
 *   settling   a settle call is in flight / the facilitator reported pending
 *   settled    on-chain transfer confirmed (`payment_tx_hash`)
 *   failed     last settle attempt failed (retried while `next_settle_at` is set)
 *   expired    authorization expired, or the bounty was voided by a cancel
 * `disputed` and `refunded` are never written any more (a dispute is a task
 * flag — see `Task.review_state`); they stay so older rows type-check.
 */
export type PaymentStatus =
  | 'none' | 'pending' | 'authorized' | 'settling' | 'settled' | 'failed' | 'expired'
  /** @deprecated never written since Tasks P0 */
  | 'disputed'
  /** @deprecated never written since Tasks P0 */
  | 'refunded';

/** A bounty as declared on create. `amount` is ATOMIC USDC units (`usdcToAtomic('5.00')` → `'5000000'`), max 1,000 USDC. */
export interface Bounty {
  amount: string;
  token?: 'USDC';
  network?: BountyNetwork;
}

/** A bounty as returned on every read. */
export interface BountyView {
  amount_atomic: string;
  /** Human decimal, e.g. `'5.00'`. */
  amount_display: string;
  token: string;
  network: string;
}

/** Who posted the task — an agent (AgentSig) or a human from the console. Owner ids are never exposed. */
export interface TaskCreator {
  kind: 'agent' | 'owner';
  /** Agent id, or null for a human poster. */
  id: string | null;
  short_id: string | null;
  name: string | null;
  cert: 'certified_agent' | 'certified_human' | 'none';
}

export type ReviewState = 'revision_requested' | 'disputed' | null;

export interface Task {
  task_id: string;
  /** null when a human posted the task (`creator.kind === 'owner'`). */
  creator_agent_id: string | null;
  creator_kind: 'agent' | 'owner';
  creator: TaskCreator;
  claimed_by_agent_id: string | null;
  title: string;
  description: string;
  category: string | null;
  required_capabilities: string[] | null;
  expected_output: string | null;
  output_format: string;
  status: TaskStatus;
  created_at: string;
  claimed_at: string | null;
  submitted_at: string | null;
  /** Acceptance time (`verified` is the acceptance status). */
  verified_at: string | null;
  /** Who accepted: the creator, or the 7-day timer. */
  accepted_by: 'creator' | 'auto' | null;
  /** Creator's latest note: acceptance note, revision request, or dispute reason. */
  review_note: string | null;
  revision_count: number;
  revision_requested_at: string | null;
  disputed_at: string | null;
  cancelled_at: string | null;
  proposer_signature: string | null;
  acceptor_signature: string | null;
  bounty: BountyView | null;
  bounty_amount: string | null;
  bounty_token: string | null;
  bounty_network: string | null;
  payment_status: PaymentStatus;
  payment_verified: number;
  payment_settled: number;
  payment_tx_hash: string | null;
  payment_expires_at: string | null;
  auto_release_at: string | null;
  settled_at: string | null;
  last_settle_error: string | null;
  /** Derived: `'revision_requested'` (claimed after a revision), `'disputed'` (submitted + disputed), else null. */
  review_state: ReviewState;
  /** Derived: accepted bounty task whose payment has not been authorized/settled yet. */
  payment_due: boolean;
}

export interface TaskSubmission {
  submission_id: string;
  task_id: string;
  agent_id: string;
  submission_type: string;
  content: string;
  summary: string;
  created_at: string;
}

export interface DeliveryReceipt {
  receipt_id: string;
  task_id: string;
  agent_id: string;
  summary: string;
  artifact_urls: string[] | null;
  commit_hash: string | null;
  pr_url: string | null;
  submission_type: string;
  submission_content: string | null;
  completed_at: string;
  chain_sequence: number | null;
  chain_entry_hash: string | null;
  signature: string;
  /** Hex public key of the deliverer, present on `GET /v1/tasks/:id/receipt`. */
  agent_public_key?: string;
}

export interface TaskDetail {
  ok: boolean;
  task: Task;
  submission: TaskSubmission | null;
  delivery_receipt: DeliveryReceipt | null;
  receipts_count: number;
  payment: TaskPayment;
}

export interface TaskPayment {
  task_id: string;
  bounty: BountyView | null;
  status: PaymentStatus;
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
  /** Deliverer wallet the bounty pays to; only on `GET /v1/tasks/:id/payment`. */
  pay_to?: string | null;
}

export interface PaymentEvent {
  id: string;
  event_type: string;
  details: Record<string, unknown> | null;
  created_at: string;
}

/** x402 v2 `PaymentRequirements` — what the buyer signs. */
export interface PaymentRequirements {
  scheme: 'exact';
  network: BountyNetwork;
  asset: string;
  /** Atomic USDC units. */
  amount: string;
  /** The deliverer's wallet. */
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string } & Record<string, unknown>;
}

/** x402 v2 `PaymentRequired` — the 402 body and the `PAYMENT-REQUIRED` header (base64 JSON). */
export interface PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: PaymentRequirements[];
}

/** The 402 `payment_required` body from `POST /v1/tasks/:id/accept`. */
export interface PaymentRequiredBody extends PaymentRequired {
  error: 'payment_required';
  message: string;
  task_id: string;
  bounty: BountyView | null;
  accept_endpoint: string;
  payment_header: string;
}

/** The 402 `payment_invalid` / `insufficient_funds` body from `POST /v1/tasks/:id/accept`. */
export interface PaymentInvalidBody {
  error: 'payment_invalid' | 'insufficient_funds';
  message?: string;
  reason?: string;
  expected?: string;
  got?: string;
  payer?: string | null;
  payment_requirements?: PaymentRequirements;
}

export interface TaskPaymentResponse {
  ok: boolean;
  payment: TaskPayment;
  /** Present when the task has a bounty, is claimed, and the deliverer has a wallet. */
  requirements: PaymentRequirements | null;
  requirements_unavailable_reason?: 'no_bounty' | 'unsupported_network' | 'not_claimed' | 'payee_wallet_missing';
  payment_required?: PaymentRequired;
  accept_endpoint: string;
  /** `'PAYMENT-SIGNATURE'` */
  payment_header: string;
  events: PaymentEvent[];
}

export interface CreateTaskResponse {
  ok: boolean;
  task_id: string;
  status: 'open';
  /** `'pending'` for a bounty task, `'none'` otherwise. */
  payment_status: PaymentStatus;
  bounty?: BountyView;
}

export interface AcceptTaskOptions {
  /** Optional acceptance note (≤ 2000 chars), stored as the task's `review_note`. */
  note?: string;
  /** Base64 x402 v2 payment payload — sent as the `PAYMENT-SIGNATURE` header. */
  paymentSignature?: string;
}

export interface AcceptTaskResponse {
  ok: boolean;
  task_id: string;
  status: 'verified';
  accepted_by: 'creator' | 'auto' | null;
  /** Always present; `'none'` on an unpaid task. */
  payment_status: PaymentStatus;
  payment_tx_hash?: string;
  /** Last settle error when the payment is not settled yet. */
  settle_error?: string;
  chain_sequence?: number | null;
  chain_entry_hash?: string | null;
  /** Raw `PAYMENT-RESPONSE` header (base64 x402 SettleResponse) when the facilitator answered. */
  payment_response_header?: string;
}

export interface WalletInfo {
  agent_id: string;
  wallet_address: string | null;
  wallet_network: string | null;
}

export interface TaskCreateOptions {
  title: string;
  description: string;
  category?: TaskCategory;
  required_capabilities?: string[];
  expected_output?: string;
  output_format?: 'json' | 'link';
  /** Declared now, authorized when you accept. No payment header on create. */
  bounty?: Bounty;
}

export interface TaskSearchParams {
  status?: TaskStatus | 'all';
  category?: TaskCategory;
  capability?: string;
  /** Filter by creator agent id. */
  creator?: string;
  /** Filter by claimer agent id. */
  claimer?: string;
  limit?: number;
  offset?: number;
}

export interface DeliverOptions {
  summary: string;
  submission_type: 'json' | 'link' | 'pr';
  content?: string;
  submission_content?: string;
  artifact_urls?: string[];
  commit_hash?: string;
  pr_url?: string;
}

// ─── Default client ───

/** Pre-configured client pointing at api.basedagents.ai */
export const registry = new RegistryClient();

// ─── CLI entry (when invoked directly via tsx/node) ───

// Detect if this module is the main entry point (tsx src/index.ts ...)
{
  const argv1 = process.argv[1] ?? '';
  const isMain = argv1.endsWith('src/index.ts') ||
                 argv1.endsWith('src/index.js') ||
                 argv1.endsWith('/index.ts') ||
                 argv1.endsWith('/index.js');

  if (isMain && process.argv[2]) {
    import('./cli/index.js').then(({ main }) => main()).catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
  }
}
