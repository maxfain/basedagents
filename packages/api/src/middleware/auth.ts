import type { Context, Next } from 'hono';
import { sha256, bytesToHex, verifySignature, base58Decode, publicKeyToAgentId } from '../crypto/index.js';
import { getDatabase } from '../db/index.js';

/**
 * AgentSig authentication middleware.
 *
 * Expects header: Authorization: AgentSig <base58_pubkey>:<base64_signature>
 * Also requires header: X-Timestamp: <unix_timestamp_seconds>
 *
 * Signature is over: "<method>:<path>:<timestamp>:<body_hash>"
 * where body_hash = sha256(body) or sha256("") for GET requests.
 *
 * Sets c.set('agentId', ...) and c.set('publicKey', ...) on success.
 */
export async function agentAuth(c: Context, next: Next): Promise<Response | void> {
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('AgentSig ')) {
    return c.json({ error: 'unauthorized', message: 'Missing AgentSig authorization header' }, 401);
  }

  const credentials = authHeader.slice('AgentSig '.length);
  const colonIdx = credentials.indexOf(':');
  if (colonIdx === -1) {
    return c.json({ error: 'unauthorized', message: 'Malformed AgentSig header — expected <pubkey>:<signature>' }, 401);
  }

  const base58PubKey = credentials.slice(0, colonIdx);
  const base64Signature = credentials.slice(colonIdx + 1);

  // Decode public key
  let publicKey: Uint8Array;
  try {
    publicKey = base58Decode(base58PubKey);
    if (publicKey.length !== 32) {
      return c.json({ error: 'unauthorized', message: 'Invalid public key length' }, 401);
    }
  } catch {
    return c.json({ error: 'unauthorized', message: 'Invalid base58 public key' }, 401);
  }

  // Decode signature
  let signature: Uint8Array;
  try {
    const binaryStr = atob(base64Signature);
    signature = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      signature[i] = binaryStr.charCodeAt(i);
    }
    if (signature.length !== 64) {
      return c.json({ error: 'unauthorized', message: 'Invalid signature length' }, 401);
    }
  } catch {
    return c.json({ error: 'unauthorized', message: 'Invalid base64 signature' }, 401);
  }

  // Get timestamp from header
  const timestamp = c.req.header('X-Timestamp');
  if (!timestamp) {
    return c.json({ error: 'unauthorized', message: 'Missing X-Timestamp header' }, 401);
  }

  // Verify timestamp is within 60 seconds
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(now - ts) > 60) {
    return c.json({ error: 'unauthorized', message: 'Timestamp out of range (must be within 60 seconds)' }, 401);
  }

  // Compute body hash
  const body = await c.req.text();
  const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body)));

  // Reconstruct the signed message: "<method>:<path>:<timestamp>:<body_hash>"
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  const message = `${method}:${path}:${timestamp}:${bodyHash}`;
  const messageBytes = new TextEncoder().encode(message);

  // Verify signature
  const valid = await verifySignature(messageBytes, signature, publicKey);
  if (!valid) {
    return c.json({ error: 'unauthorized', message: 'Invalid signature' }, 401);
  }

  // Check agent exists in database
  const agentId = publicKeyToAgentId(publicKey);
  const db = getDatabase();
  const agent = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(agentId) as { id: string; status: string } | undefined;

  if (!agent) {
    return c.json({ error: 'unauthorized', message: 'Agent not registered' }, 401);
  }

  // Set context
  c.set('agentId', agentId);
  c.set('publicKey', publicKey);
  c.set('agentStatus', agent.status);

  await next();
}

/**
 * Optional auth — sets agent context if header present, continues regardless.
 */
export async function optionalAuth(c: Context, next: Next): Promise<void> {
  const authHeader = c.req.header('Authorization');

  if (authHeader?.startsWith('AgentSig ')) {
    try {
      // Try to parse and verify, but don't fail if it doesn't work
      const credentials = authHeader.slice('AgentSig '.length);
      const colonIdx = credentials.indexOf(':');
      if (colonIdx !== -1) {
        const base58PubKey = credentials.slice(0, colonIdx);
        const publicKey = base58Decode(base58PubKey);
        if (publicKey.length === 32) {
          const agentId = publicKeyToAgentId(publicKey);
          c.set('agentId', agentId);
          c.set('publicKey', publicKey);
        }
      }
    } catch {
      // Silently ignore auth errors in optional mode
    }
  }

  await next();
}
