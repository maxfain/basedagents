import { Hono } from 'hono';
import type { AppEnv, Challenge } from '../types/index.js';
import { RegisterInitSchema, RegisterCompleteSchema } from '../types/index.js';
import {
  base58Decode,
  publicKeyToAgentId,
  verifySignature,
  verifyProofOfWork,
  computeChainHash,
  hashProfile,
  DEFAULT_DIFFICULTY,
  GENESIS_HASH,
} from '../crypto/index.js';

/**
 * Generate a random hex string (replacement for node:crypto randomBytes).
 * Uses Web Crypto API — works on both Workers and Node.js 20+.
 */
function generateRandomBase64(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  // Convert to base64
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

const register = new Hono<AppEnv>();

/**
 * POST /v1/register/init
 * Agent sends its public key. Registry returns a challenge + current difficulty.
 */
register.post('/init', async (c) => {
  // Parse and validate request body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  }

  const parsed = RegisterInitSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'bad_request',
      message: 'Validation failed',
      details: parsed.error.flatten(),
    }, 400);
  }

  const { public_key: base58PubKey } = parsed.data;

  // Decode and validate public key format (must be 32 bytes for Ed25519)
  let publicKey: Uint8Array;
  try {
    publicKey = base58Decode(base58PubKey);
    if (publicKey.length !== 32) {
      return c.json({ error: 'bad_request', message: 'Public key must be 32 bytes (Ed25519)' }, 400);
    }
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid base58-encoded public key' }, 400);
  }

  const db = c.get('db');
  const agentId = publicKeyToAgentId(publicKey);

  // Check if agent already registered
  const existing = await db.get<{ id: string }>('SELECT id FROM agents WHERE id = ?', agentId);
  if (existing) {
    return c.json({ error: 'conflict', message: 'Agent with this public key is already registered' }, 409);
  }

  // Expire old pending challenges for this agent
  await db.run(
    "UPDATE challenges SET status = 'expired' WHERE agent_id = ? AND status = 'pending'",
    agentId
  );

  // Generate challenge (32 random bytes, base64-encoded)
  const challengeBytes = generateRandomBase64(32);
  const challengeId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes

  // Get latest chain hash
  const latestEntry = await db.get<{ entry_hash: string }>(
    'SELECT entry_hash FROM chain ORDER BY sequence DESC LIMIT 1'
  );
  const previousHash = latestEntry?.entry_hash ?? GENESIS_HASH;

  // Store challenge
  await db.run(
    `INSERT INTO challenges (id, agent_id, challenge_bytes, status, created_at, expires_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
    challengeId,
    agentId,
    challengeBytes,
    now.toISOString(),
    expiresAt.toISOString()
  );

  return c.json({
    challenge_id: challengeId,
    challenge: challengeBytes,
    difficulty: DEFAULT_DIFFICULTY,
    previous_hash: previousHash,
    expires_at: expiresAt.toISOString(),
  });
});

/**
 * POST /v1/register/complete
 * Agent submits proof-of-work nonce, signed challenge, and profile.
 */
register.post('/complete', async (c) => {
  // Parse and validate request body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  }

  const parsed = RegisterCompleteSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'bad_request',
      message: 'Validation failed',
      details: parsed.error.flatten(),
    }, 400);
  }

  const { challenge_id, public_key: base58PubKey, signature, nonce, profile } = parsed.data;
  const db = c.get('db');

  // 1. Decode public key
  let publicKey: Uint8Array;
  try {
    publicKey = base58Decode(base58PubKey);
    if (publicKey.length !== 32) {
      return c.json({ error: 'bad_request', message: 'Public key must be 32 bytes' }, 400);
    }
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid base58-encoded public key' }, 400);
  }

  const agentId = publicKeyToAgentId(publicKey);

  // 2. Look up challenge and verify it's valid
  const challenge = await db.get<Challenge>(
    "SELECT * FROM challenges WHERE id = ? AND agent_id = ? AND status = 'pending'",
    challenge_id, agentId
  );

  if (!challenge) {
    return c.json({ error: 'bad_request', message: 'Challenge not found or already used' }, 400);
  }

  // 3. Check challenge hasn't expired
  if (new Date(challenge.expires_at) < new Date()) {
    await db.run("UPDATE challenges SET status = 'expired' WHERE id = ?", challenge_id);
    return c.json({ error: 'bad_request', message: 'Challenge has expired' }, 400);
  }

  // 4. Verify signature over the challenge bytes
  let sigBytes: Uint8Array;
  try {
    const binaryStr = atob(signature);
    sigBytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      sigBytes[i] = binaryStr.charCodeAt(i);
    }
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid base64 signature' }, 400);
  }

  // The agent signs the raw challenge bytes
  const challengeData = new TextEncoder().encode(challenge.challenge_bytes);
  const sigValid = await verifySignature(challengeData, sigBytes, publicKey);
  if (!sigValid) {
    return c.json({ error: 'bad_request', message: 'Invalid signature — challenge verification failed' }, 400);
  }

  // 5. Verify proof-of-work
  if (!verifyProofOfWork(publicKey, nonce, DEFAULT_DIFFICULTY)) {
    return c.json({ error: 'bad_request', message: 'Proof-of-work verification failed' }, 400);
  }

  // 5b. Check name uniqueness (case-insensitive)
  const existing = await db.get<{ id: string }>(
    'SELECT id FROM agents WHERE name = ? COLLATE NOCASE',
    profile.name
  );
  if (existing) {
    return c.json({ error: 'conflict', message: `Agent name '${profile.name}' is already taken` }, 409);
  }

  // 6. Create chain entry
  const latestEntry = await db.get<{ entry_hash: string }>(
    'SELECT entry_hash FROM chain ORDER BY sequence DESC LIMIT 1'
  );
  const previousHash = latestEntry?.entry_hash ?? GENESIS_HASH;

  const timestamp = new Date().toISOString();
  const profileHash = hashProfile(profile as unknown as Record<string, unknown>);
  const entryHash = computeChainHash(previousHash, publicKey, nonce, profileHash, timestamp);

  // 7. Insert agent + chain entry + mark challenge completed
  // Run sequentially — both SQLite adapter and D1 handle this correctly.
  await db.run(
    `INSERT INTO agents (id, public_key, name, description, capabilities, protocols, offers, needs, homepage, contact_endpoint, comment, organization, organization_url, logo_url, tags, version, contact_email, skills, registered_at, status, reputation_score, verification_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0.0, 0)`,
    agentId,
    publicKey,
    profile.name,
    profile.description,
    JSON.stringify(profile.capabilities),
    JSON.stringify(profile.protocols),
    profile.offers ? JSON.stringify(profile.offers) : null,
    profile.needs ? JSON.stringify(profile.needs) : null,
    profile.homepage ?? null,
    profile.contact_endpoint ?? null,
    profile.comment ?? null,
    profile.organization ?? null,
    profile.organization_url ?? null,
    profile.logo_url ?? null,
    profile.tags ? JSON.stringify(profile.tags) : null,
    profile.version ?? null,
    profile.contact_email ?? null,
    profile.skills ? JSON.stringify(profile.skills) : null,
    timestamp
  );

  await db.run(
    `INSERT INTO chain (entry_hash, previous_hash, agent_id, public_key, nonce, profile_hash, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    entryHash,
    previousHash,
    agentId,
    publicKey,
    nonce,
    profileHash,
    timestamp
  );

  await db.run(
    "UPDATE challenges SET status = 'completed' WHERE id = ?",
    challenge_id
  );

  // Get the sequence number
  const chainEntry = await db.get<{ sequence: number }>(
    'SELECT sequence FROM chain WHERE entry_hash = ?',
    entryHash
  );

  // 8. Determine first verification assignment
  const activeCount = await db.get<{ count: number }>(
    "SELECT COUNT(*) as count FROM agents WHERE status = 'active'"
  );

  let responseBody: Record<string, unknown> = {
    agent_id: agentId,
    status: 'pending',
    chain_sequence: chainEntry!.sequence,
    entry_hash: entryHash,
    message: 'Registration complete. Complete your first verification to activate.',
  };

  if ((activeCount?.count ?? 0) < 100) {
    // Bootstrap mode — registry will probe the agent's endpoint
    if (profile.contact_endpoint) {
      responseBody.bootstrap_mode = true;
      responseBody.message = 'Registration complete. Bootstrap mode: the registry will verify your endpoint directly.';
    }
  } else {
    // Assign a random active agent for the new agent to verify
    const target = await db.get<{ id: string; contact_endpoint: string | null }>(
      "SELECT id, contact_endpoint FROM agents WHERE status = 'active' AND id != ? ORDER BY RANDOM() LIMIT 1",
      agentId
    );

    if (target) {
      responseBody.first_verification = {
        target_id: target.id,
        target_endpoint: target.contact_endpoint,
        deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
    }
  }

  return c.json(responseBody, 201);
});

export default register;
