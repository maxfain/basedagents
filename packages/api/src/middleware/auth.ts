import type { Context, Next } from 'hono';
import { sha256, bytesToHex, verifySignature, base58Decode, publicKeyToAgentId } from '../crypto/index.js';
import type { DBAdapter } from '../db/adapter.js';

/**
 * AgentSig authentication middleware.
 *
 * Expects header: Authorization: AgentSig <base58_pubkey>:<base64_signature>
 * Also requires header: X-Timestamp: <unix_timestamp_seconds>
 * Optional header: X-Nonce: <random_string> (makes signatures non-deterministic)
 *
 * Signature is over: "<method>:<path>:<timestamp>:<body_hash>:<nonce>"
 * where body_hash = sha256(body) or sha256("") for GET requests.
 * If X-Nonce is absent, falls back to legacy format without the nonce suffix.
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

  // Verify timestamp is within 30 seconds
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(now - ts) > 30) {
    return c.json({ error: 'unauthorized', message: 'Timestamp out of range (must be within 30 seconds)' }, 401);
  }

  // Compute body hash
  const body = await c.req.text();
  const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body)));

  // Reconstruct the signed message.
  // New format: "<method>:<path>:<timestamp>:<body_hash>:<nonce>"
  // Legacy (no X-Nonce header): "<method>:<path>:<timestamp>:<body_hash>"
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  const nonce = c.req.header('X-Nonce');
  const message = nonce
    ? `${method}:${path}:${timestamp}:${bodyHash}:${nonce}`
    : `${method}:${path}:${timestamp}:${bodyHash}`;
  const messageBytes = new TextEncoder().encode(message);

  // Verify signature
  const valid = await verifySignature(messageBytes, signature, publicKey);
  if (!valid) {
    return c.json({ error: 'unauthorized', message: 'Invalid signature' }, 401);
  }

  // Replay protection: check if this signature has been used before
  const db = c.get('db') as DBAdapter;
  const sigHash = bytesToHex(sha256(signature));

  // Cleanup expired signatures
  await db.run('DELETE FROM used_signatures WHERE expires_at < ?', now);

  const existing = await db.get<{ signature_hash: string }>(
    'SELECT signature_hash FROM used_signatures WHERE signature_hash = ?', sigHash
  );
  if (existing) {
    return c.json({ error: 'unauthorized', message: 'Signature already used (replay protection)' }, 401);
  }

  // Store signature with 120-second expiry
  await db.run(
    'INSERT INTO used_signatures (signature_hash, expires_at) VALUES (?, ?)',
    sigHash, now + 120
  );

  // Check agent exists in database
  const agentId = publicKeyToAgentId(publicKey);
  const agent = await db.get<{ id: string; status: string }>('SELECT id, status FROM agents WHERE id = ?', agentId);

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
 * Optional auth — sets agent context ONLY if signature fully verifies.
 * Never sets context from an unverified public key.
 * If header is present but invalid, silently skips (does not set context, does not reject).
 */
export async function optionalAuth(c: Context, next: Next): Promise<void> {
  const authHeader = c.req.header('Authorization');

  if (authHeader?.startsWith('AgentSig ')) {
    try {
      const credentials = authHeader.slice('AgentSig '.length);
      const colonIdx = credentials.indexOf(':');
      if (colonIdx === -1) { await next(); return; }

      const base58PubKey = credentials.slice(0, colonIdx);
      const base64Sig = credentials.slice(colonIdx + 1);

      const publicKey = base58Decode(base58PubKey);
      if (publicKey.length !== 32) { await next(); return; }

      const binStr = atob(base64Sig);
      const signature = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) signature[i] = binStr.charCodeAt(i);
      if (signature.length !== 64) { await next(); return; }

      const timestamp = c.req.header('X-Timestamp');
      if (!timestamp) { await next(); return; }
      const ts = parseInt(timestamp, 10);
      const now = Math.floor(Date.now() / 1000);
      if (isNaN(ts) || Math.abs(now - ts) > 30) { await next(); return; }

      const body = await c.req.text();
      const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body)));
      const method = c.req.method;
      const path = new URL(c.req.url).pathname;
      const nonce = c.req.header('X-Nonce');
      const message = nonce
        ? `${method}:${path}:${timestamp}:${bodyHash}:${nonce}`
        : `${method}:${path}:${timestamp}:${bodyHash}`;
      const valid = await verifySignature(new TextEncoder().encode(message), signature, publicKey);
      if (!valid) { await next(); return; }

      // Only set context after full verification
      const agentId = publicKeyToAgentId(publicKey);
      const db = c.get('db') as DBAdapter;
      if (db) {
        const agent = await db.get<{ id: string; status: string }>('SELECT id, status FROM agents WHERE id = ?', agentId);
        if (agent) {
          c.set('agentId', agentId);
          c.set('publicKey', publicKey);
          c.set('agentStatus', agent.status);
        }
      }
    } catch {
      // Invalid header format — continue without auth context
    }
  }

  await next();
}
