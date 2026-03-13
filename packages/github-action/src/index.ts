/**
 * BasedAgents GitHub Action
 * Registers or updates an AI agent on the basedagents.ai registry.
 */

import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AgentKeypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** Serialized keypair format — what gets stored on disk / in secrets */
interface SerializedKeypair {
  agent_id: string;
  public_key_b58: string;
  private_key_hex: string;
}

interface Agent {
  id: string;
  name: string;
  status: 'pending' | 'active' | 'suspended' | 'revoked';
  [key: string]: unknown;
}

interface RegisterProfile {
  name: string;
  description: string;
  capabilities: string[];
  protocols: string[];
  tags?: string[];
}

// ─── Base58 ──────────────────────────────────────────────────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
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

function base58Decode(str: string): Uint8Array {
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function publicKeyToAgentId(publicKey: Uint8Array): string {
  return `ag_${base58Encode(publicKey)}`;
}

function serializeKeypair(kp: AgentKeypair): SerializedKeypair {
  return {
    agent_id: publicKeyToAgentId(kp.publicKey),
    public_key_b58: base58Encode(kp.publicKey),
    private_key_hex: bytesToHex(kp.privateKey),
  };
}

function deserializeKeypair(json: string): AgentKeypair {
  const parsed = JSON.parse(json) as Record<string, string>;

  // Support two formats:
  // 1. Our format: { agent_id, public_key_b58, private_key_hex }
  // 2. SDK format: { publicKey (hex), privateKey (hex) }
  if (parsed.private_key_hex && parsed.public_key_b58) {
    return {
      publicKey: base58Decode(parsed.public_key_b58),
      privateKey: hexToBytes(parsed.private_key_hex),
    };
  } else if (parsed.privateKey && parsed.publicKey) {
    return {
      publicKey: hexToBytes(parsed.publicKey),
      privateKey: hexToBytes(parsed.privateKey),
    };
  }
  throw new Error('Unrecognized keypair format. Expected { public_key_b58, private_key_hex } or { publicKey, privateKey }.');
}

// ─── Proof of Work ───────────────────────────────────────────────────────────

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

function solveProofOfWork(
  publicKey: Uint8Array,
  difficulty: number
): { nonce: string; hash: string } {
  core.info(`Solving proof-of-work (difficulty=${difficulty})…`);
  const buf = new Uint8Array(publicKey.length + 4);
  buf.set(publicKey, 0);
  for (let nonce = 0; nonce <= 0xFFFFFFFF; nonce++) {
    if (nonce % 100_000 === 0 && nonce > 0) {
      core.info(`  PoW: ${nonce.toLocaleString()} attempts…`);
    }
    buf[publicKey.length]     = (nonce >>> 24) & 0xff;
    buf[publicKey.length + 1] = (nonce >>> 16) & 0xff;
    buf[publicKey.length + 2] = (nonce >>>  8) & 0xff;
    buf[publicKey.length + 3] =  nonce         & 0xff;
    const hash = sha256(buf);
    if (countLeadingZeroBits(hash) >= difficulty) {
      const nonceHex = nonce.toString(16).padStart(8, '0');
      core.info(`  PoW solved: nonce=${nonceHex} after ${nonce + 1} attempts`);
      return { nonce: nonceHex, hash: bytesToHex(hash) };
    }
  }
  throw new Error('No PoW solution found — nonce space exhausted');
}

// ─── Request Signing ─────────────────────────────────────────────────────────

async function signRequest(
  keypair: AgentKeypair,
  method: string,
  urlPath: string,
  body = ''
): Promise<{ Authorization: string; 'X-Timestamp': string }> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body)));
  const message = `${method.toUpperCase()}:${urlPath}:${timestamp}:${bodyHash}`;
  const messageBytes = new TextEncoder().encode(message);
  const signature = await ed.signAsync(messageBytes, keypair.privateKey);
  const b64sig = btoa(String.fromCharCode(...signature));
  const b58pubkey = base58Encode(keypair.publicKey);
  return {
    Authorization: `AgentSig ${b58pubkey}:${b64sig}`,
    'X-Timestamp': timestamp,
  };
}

// ─── API Client ──────────────────────────────────────────────────────────────

class ApiClient {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(
    urlPath: string,
    init?: RequestInit
  ): Promise<T> {
    const url = `${this.baseUrl}${urlPath}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const e = await res.json() as { message?: string };
        msg = e.message ?? msg;
      } catch { /* ignore */ }
      throw new Error(`BasedAgents API ${res.status}: ${msg}`);
    }
    return res.json() as Promise<T>;
  }

  async get<T>(urlPath: string, keypair?: AgentKeypair): Promise<T> {
    const headers: Record<string, string> = {};
    if (keypair) {
      const authHeaders = await signRequest(keypair, 'GET', urlPath);
      Object.assign(headers, authHeaders);
    }
    return this.request<T>(urlPath, { method: 'GET', headers });
  }

  async post<T>(urlPath: string, body: unknown, keypair?: AgentKeypair): Promise<T> {
    const bodyStr = JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (keypair) {
      const authHeaders = await signRequest(keypair, 'POST', urlPath, bodyStr);
      Object.assign(headers, authHeaders);
    }
    return this.request<T>(urlPath, { method: 'POST', body: bodyStr, headers });
  }

  async patch<T>(urlPath: string, body: unknown, keypair: AgentKeypair): Promise<T> {
    const bodyStr = JSON.stringify(body);
    const authHeaders = await signRequest(keypair, 'PATCH', urlPath, bodyStr);
    return this.request<T>(urlPath, {
      method: 'PATCH',
      body: bodyStr,
      headers: { ...authHeaders },
    });
  }
}

// ─── Registration Flow ───────────────────────────────────────────────────────

async function registerAgent(
  client: ApiClient,
  keypair: AgentKeypair,
  profile: RegisterProfile
): Promise<Agent> {
  const b58pubkey = base58Encode(keypair.publicKey);

  core.info('Initiating registration…');
  const init = await client.post<{
    challenge_id: string;
    challenge: string;
    difficulty: number;
  }>('/v1/register/init', { public_key: b58pubkey });

  core.info(`Challenge received. Difficulty: ${init.difficulty}`);

  // Solve PoW synchronously (GitHub Actions runner is CPU-only, no event loop to block)
  const { nonce } = solveProofOfWork(keypair.publicKey, init.difficulty);

  // Sign challenge — same as SDK: sign the raw challenge string as UTF-8 bytes
  const challengeBytes = new TextEncoder().encode(init.challenge);
  const signature = await ed.signAsync(challengeBytes, keypair.privateKey);
  const b64sig = btoa(String.fromCharCode(...signature));

  core.info('Completing registration…');
  const result = await client.post<{ agent: Agent }>('/v1/register/complete', {
    challenge_id: init.challenge_id,
    public_key: b58pubkey,
    nonce,
    signature: b64sig,
    profile,
  });

  return result.agent;
}

async function updateAgentProfile(
  client: ApiClient,
  keypair: AgentKeypair,
  agentId: string,
  profile: Partial<RegisterProfile>
): Promise<Agent> {
  core.info(`Updating profile for agent ${agentId}…`);
  return client.patch<Agent>(`/v1/agents/${agentId}/profile`, profile, keypair);
}

// ─── Keypair Loading ─────────────────────────────────────────────────────────

async function loadOrCreateKeypair(
  keypairPath: string,
  keypairJson: string
): Promise<{ keypair: AgentKeypair; isNew: boolean }> {
  // Priority: keypair-json > keypair-path > generate new
  if (keypairJson.trim()) {
    core.info('Loading keypair from keypair-json input…');
    const keypair = deserializeKeypair(keypairJson.trim());
    return { keypair, isNew: false };
  }

  if (keypairPath.trim()) {
    const resolvedPath = path.resolve(process.env.GITHUB_WORKSPACE ?? '.', keypairPath.trim());
    core.info(`Loading keypair from file: ${resolvedPath}`);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Keypair file not found: ${resolvedPath}`);
    }
    const json = fs.readFileSync(resolvedPath, 'utf-8');
    const keypair = deserializeKeypair(json);
    return { keypair, isNew: false };
  }

  // Generate a fresh keypair
  core.warning('No keypair provided — generating a new one.');
  core.warning('⚠️  IMPORTANT: Save the keypair JSON from the outputs to a GitHub Secret (BASEDAGENTS_KEYPAIR) to persist your agent identity!');
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const keypair: AgentKeypair = { publicKey, privateKey };
  return { keypair, isNew: true };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  try {
    // Read inputs
    const keypairPath = core.getInput('keypair-path');
    const keypairJson = core.getInput('keypair-json');
    const agentName   = core.getInput('name', { required: true });
    const description = core.getInput('description');
    const apiUrl      = core.getInput('api-url') || 'https://api.basedagents.ai';

    const capabilities = core.getInput('capabilities')
      .split(',').map(s => s.trim()).filter(Boolean);
    const protocols = core.getInput('protocols')
      .split(',').map(s => s.trim()).filter(Boolean);
    const tags = core.getInput('tags')
      .split(',').map(s => s.trim()).filter(Boolean);

    const client = new ApiClient(apiUrl.replace(/\/$/, ''));

    // Load or create keypair
    const { keypair, isNew } = await loadOrCreateKeypair(keypairPath, keypairJson);
    const agentId = publicKeyToAgentId(keypair.publicKey);

    core.info(`Agent ID: ${agentId}`);

    if (isNew) {
      // Emit keypair JSON so user can save it
      const serialized = serializeKeypair(keypair);
      core.setSecret(serialized.private_key_hex);
      core.info('New keypair generated. Save the following JSON as a GitHub Secret named BASEDAGENTS_KEYPAIR:');
      core.info(JSON.stringify(serialized, null, 2));
    }

    const profile: RegisterProfile = {
      name: agentName,
      description,
      capabilities,
      protocols: protocols.length ? protocols : ['https'],
      tags: tags.length ? tags : undefined,
    };

    let agent: Agent;

    // Check if agent already exists
    try {
      core.info(`Checking if agent ${agentId} exists…`);
      await client.get<Agent>(`/v1/agents/${agentId}`);
      core.info('Agent exists — updating profile.');
      agent = await updateAgentProfile(client, keypair, agentId, profile);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('404') || msg.includes('not found')) {
        core.info('Agent not found — registering new agent.');
        agent = await registerAgent(client, keypair, profile);
      } else {
        throw err;
      }
    }

    core.info(`Agent registered/updated: ${agent.id} (status=${agent.status})`);

    // Set outputs
    core.setOutput('agent-id', agent.id);
    core.setOutput('status', agent.status);

    core.info('Done.');
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

run();
