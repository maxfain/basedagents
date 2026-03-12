/**
 * Attestation endpoint — basedagents.ai
 *
 * Issues signed capability attestations for agents. Analogous to a TLS certificate:
 * signed by the registry, short-lived, verifiable offline using the registry's
 * published public key.
 *
 * GET /v1/agents/:id/attestation  — issue an attestation for an agent
 * GET /v1/attestation/public-key  — fetch the registry's Ed25519 public key (for offline verification)
 */
import { Hono } from 'hono';
import { AppEnv } from '../types/index.js';
import { signAsync } from '@noble/ed25519';
import { hexToBytes } from '@noble/hashes/utils';
import { base58Encode } from '../crypto/index.js';

const ATTESTATION_TTL_SECONDS = 3600; // 1 hour


async function signAttestation(
  payload: Record<string, unknown>,
  privateKeyHex: string
): Promise<string> {
  // Canonical JSON: sorted keys, no whitespace
  // Compact canonical JSON: sorted keys, no spaces.
  // Must match the Python verifier: json.dumps(payload, sort_keys=True, separators=(',', ':'))
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(payload).sort()) sorted[k] = payload[k];
  const canonical = JSON.stringify(sorted);
  const msgBytes = new TextEncoder().encode(canonical);
  const privBytes = hexToBytes(privateKeyHex);
  const sig = await signAsync(msgBytes, privBytes);
  return btoa(String.fromCharCode(...sig));
}

interface AgentRow {
  id: string;
  name: string;
  public_key: string | Uint8Array | { [k: string]: number };
  capabilities: string | null;
  protocols: string | null;
  reputation_score: number;
  reputation_override: number | null;
  verification_count: number;
  status: string;
}

export const attestation = new Hono<AppEnv>();

// GET /v1/attestation/public-key
attestation.get('/public-key', (c) => {
  const env = c.env;
  const pubKeyHex = env.REGISTRY_SIGNING_PUBLIC_KEY ?? '9827a77ffa3bbddff01444277707271838098f3e8f2d29a200054cc0bca308d0';
  const pubKeyBytes = hexToBytes(pubKeyHex);
  const pubKeyB58 = base58Encode(pubKeyBytes);
  return c.json({
    public_key_hex: pubKeyHex,
    public_key_b58: pubKeyB58,
    algorithm: 'Ed25519',
    issuer: 'basedagents.ai',
  });
});

// GET /v1/agents/:id/attestation
attestation.get('/:id/attestation', async (c) => {
  const agentId = c.req.param('id');
  const db = c.get('db');

  const agent = await db.get<AgentRow>(
    `SELECT id, name, public_key, capabilities, protocols, reputation_score,
            reputation_override, verification_count, status
     FROM agents WHERE id = ?`,
    agentId
  );

  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  if (agent.status === 'suspended' || agent.status === 'revoked') {
    return c.json({
      error: 'Agent is suspended or revoked — attestation unavailable',
      status: agent.status,
    }, 403);
  }

  // Normalise public key to hex string
  let pubKeyHex: string;
  if (typeof agent.public_key === 'string') {
    pubKeyHex = agent.public_key;
  } else {
    const raw = agent.public_key instanceof Uint8Array
      ? agent.public_key
      : new Uint8Array(Object.values(agent.public_key as Record<string, number>));
    pubKeyHex = Array.from(raw).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const pubKeyB58 = base58Encode(hexToBytes(pubKeyHex as string) as Uint8Array);

  const capabilities: string[] = agent.capabilities
    ? JSON.parse(agent.capabilities as string)
    : [];
  const protocols: string[] = agent.protocols
    ? JSON.parse(agent.protocols as string)
    : [];

  const reputation = agent.reputation_override ?? agent.reputation_score;
  const reputationTier =
    reputation >= 0.8 ? 'trusted' :
    reputation >= 0.5 ? 'established' :
    reputation >= 0.2 ? 'emerging' : 'new';

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ATTESTATION_TTL_SECONDS;

  const signingPrivKey = c.env.REGISTRY_SIGNING_KEY;
  if (!signingPrivKey) {
    return c.json({ error: 'Registry signing key not configured' }, 500);
  }

  // Payload to sign (all fields except signature)
  const payload = {
    version: '1',
    issuer: 'basedagents.ai',
    agent_id: agent.id,
    agent_name: agent.name,
    public_key_b58: pubKeyB58,
    capabilities,
    protocols,
    reputation: Math.round(reputation * 1000) / 1000,
    reputation_tier: reputationTier,
    verification_count: agent.verification_count,
    status: agent.status,
    issued_at: now,
    expires_at: expiresAt,
  };

  const signature = await signAttestation(payload, signingPrivKey);

  return c.json({
    ...payload,
    signature,
    _verify: 'GET https://api.basedagents.ai/v1/attestation/public-key',
  });
});
