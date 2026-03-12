/**
 * Test helpers for in-memory SQLite database setup and agent creation.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPublicKey, sign, utils } from '@noble/ed25519';
import { Hono } from 'hono';
import type { AppEnv } from './types/index.js';
import { SQLiteAdapter } from './db/sqlite-adapter.js';
import {
  base58Encode,
  publicKeyToAgentId,
  verifyProofOfWork,
  sha256,
  bytesToHex,
} from './crypto/index.js';

import registerRoutes from './routes/register.js';
import agentRoutes from './routes/agents.js';
import verifyRoutes from './routes/verify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXTRA_ALTER_STATEMENTS = `
ALTER TABLE agents ADD COLUMN comment TEXT;
ALTER TABLE agents ADD COLUMN organization TEXT;
ALTER TABLE agents ADD COLUMN organization_url TEXT;
ALTER TABLE agents ADD COLUMN logo_url TEXT;
ALTER TABLE agents ADD COLUMN tags TEXT;
ALTER TABLE agents ADD COLUMN version TEXT;
ALTER TABLE agents ADD COLUMN contact_email TEXT;
ALTER TABLE agents ADD COLUMN x_handle TEXT;
ALTER TABLE agents ADD COLUMN skills TEXT;
ALTER TABLE agents ADD COLUMN profile_version INTEGER DEFAULT 1;
ALTER TABLE agents ADD COLUMN safety_flags INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN penalty_score REAL DEFAULT 0.0;
ALTER TABLE agents ADD COLUMN reputation_override REAL;
ALTER TABLE agents ADD COLUMN probe_attempts INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN last_probe_result TEXT;
ALTER TABLE agents ADD COLUMN webhook_url TEXT;
ALTER TABLE verifications ADD COLUMN structured_report TEXT;
ALTER TABLE verifications ADD COLUMN nonce TEXT;
ALTER TABLE chain ADD COLUMN entry_type TEXT DEFAULT 'registration';
`.trim();

/**
 * Create an in-memory SQLite database and return a SQLiteAdapter.
 */
export function setupTestDb(): SQLiteAdapter {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  // Run base schema
  const schemaPath = join(__dirname, 'db', 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  // Run ALTER TABLE statements for columns added after initial schema.
  // Each is wrapped in a try/catch at DB level — we run them one by one.
  for (const stmt of EXTRA_ALTER_STATEMENTS.split('\n')) {
    const s = stmt.trim();
    if (!s) continue;
    try {
      db.exec(s);
    } catch {
      // Column already exists — ignore
    }
  }

  return new SQLiteAdapter(db);
}

export interface TestKeypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  agentId: string;
  publicKeyB58: string;
}

/**
 * Generate an Ed25519 keypair for testing.
 */
export async function createTestKeypair(): Promise<TestKeypair> {
  const privateKey = utils.randomPrivateKey();
  const publicKey = await getPublicKey(privateKey);
  const publicKeyB58 = base58Encode(publicKey);
  const agentId = publicKeyToAgentId(publicKey);
  return { publicKey, privateKey, agentId, publicKeyB58 };
}

export interface TestAgentOptions {
  name?: string;
  status?: 'pending' | 'active' | 'suspended';
  reputationScore?: number;
  reputationOverride?: number | null;
  webhookUrl?: string | null;
  capabilities?: string[];
  protocols?: string[];
}

/**
 * Insert a test agent into the database and return the agent ID + keypair.
 */
export async function createTestAgent(
  db: SQLiteAdapter,
  options: TestAgentOptions = {}
): Promise<TestKeypair & { name: string }> {
  const kp = await createTestKeypair();
  const name = options.name ?? `TestAgent-${kp.agentId.slice(3, 10)}`;
  const status = options.status ?? 'active';
  const reputationScore = options.reputationScore ?? 0.5;
  const capabilities = options.capabilities ?? ['code-generation'];
  const protocols = options.protocols ?? ['http'];

  await db.run(
    `INSERT INTO agents (
      id, public_key, name, description, capabilities, protocols,
      offers, needs, homepage, contact_endpoint,
      comment, organization, organization_url, logo_url, tags, version,
      contact_email, x_handle, skills, webhook_url,
      profile_version, safety_flags, penalty_score,
      reputation_override, probe_attempts, last_probe_result,
      registered_at, status, reputation_score, verification_count
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, ?,
      1, 0, 0.0,
      ?, 0, NULL,
      ?, ?, ?, 0
    )`,
    kp.agentId,
    kp.publicKey,
    name,
    'A test agent',
    JSON.stringify(capabilities),
    JSON.stringify(protocols),
    options.webhookUrl ?? null,
    options.reputationOverride ?? null,
    new Date().toISOString(),
    status,
    reputationScore
  );

  return { ...kp, name };
}

/**
 * Create a properly signed AgentSig request.
 * Returns headers { Authorization, 'X-Timestamp' }.
 */
export async function signRequest(
  keypair: TestKeypair,
  method: string,
  path: string,
  body: string = ''
): Promise<{ Authorization: string; 'X-Timestamp': string }> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body)));
  const message = `${method}:${path}:${timestamp}:${bodyHash}`;
  const messageBytes = new TextEncoder().encode(message);
  const sigBytes = await sign(messageBytes, keypair.privateKey);
  const base64Sig = btoa(String.fromCharCode(...sigBytes));
  return {
    Authorization: `AgentSig ${keypair.publicKeyB58}:${base64Sig}`,
    'X-Timestamp': timestamp,
  };
}

/**
 * Solve proof-of-work for a public key at given difficulty.
 */
export function solvePoW(publicKey: Uint8Array, difficulty: number): string {
  let nonce = 0n;
  while (true) {
    // Convert nonce to hex string
    const hexNonce = nonce.toString(16).padStart(16, '0');
    if (verifyProofOfWork(publicKey, hexNonce, difficulty)) {
      return hexNonce;
    }
    nonce++;
  }
}

/**
 * Create a Hono app for testing with an injected in-memory DB.
 */
export function createTestApp(db: SQLiteAdapter) {
  const app = new Hono<AppEnv>();

  // Inject DB + empty env bindings via middleware
  app.use('*', async (c, next) => {
    c.set('db', db);
    // Provide empty env bindings so c.env.* doesn't crash
    (c.env as Record<string, string>) = c.env ?? {};
    await next();
  });

  app.route('/v1/register', registerRoutes);
  app.route('/v1/agents', agentRoutes);
  app.route('/v1/verify', verifyRoutes);

  return app;
}
