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
import messageRoutes, { messageActions } from './routes/messages.js';
import taskRoutes from './routes/tasks.js';

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
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, from_agent_id TEXT NOT NULL, to_agent_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'message', subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', callback_url TEXT, reply_to_message_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL, FOREIGN KEY (from_agent_id) REFERENCES agents(id), FOREIGN KEY (to_agent_id) REFERENCES agents(id), FOREIGN KEY (reply_to_message_id) REFERENCES messages(id));
CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, creator_agent_id TEXT NOT NULL, claimed_by_agent_id TEXT, title TEXT NOT NULL, description TEXT NOT NULL, category TEXT, required_capabilities TEXT, expected_output TEXT, output_format TEXT DEFAULT 'json', status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','submitted','verified','closed','cancelled')), created_at TEXT NOT NULL, claimed_at TEXT, submitted_at TEXT, verified_at TEXT, FOREIGN KEY (creator_agent_id) REFERENCES agents(id), FOREIGN KEY (claimed_by_agent_id) REFERENCES agents(id));
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category);
CREATE INDEX IF NOT EXISTS idx_tasks_creator ON tasks(creator_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_claimer ON tasks(claimed_by_agent_id);
CREATE TABLE IF NOT EXISTS submissions (submission_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL, submission_type TEXT NOT NULL DEFAULT 'json' CHECK (submission_type IN ('json','link')), content TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY (task_id) REFERENCES tasks(task_id), FOREIGN KEY (agent_id) REFERENCES agents(id));
CREATE INDEX IF NOT EXISTS idx_submissions_task ON submissions(task_id);
ALTER TABLE tasks ADD COLUMN proposer_signature TEXT;
ALTER TABLE tasks ADD COLUMN acceptor_signature TEXT;
CREATE TABLE IF NOT EXISTS delivery_receipts (receipt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL, summary TEXT NOT NULL, artifact_urls TEXT, commit_hash TEXT, pr_url TEXT, submission_type TEXT NOT NULL DEFAULT 'json' CHECK (submission_type IN ('json','link','pr')), submission_content TEXT, completed_at TEXT NOT NULL, chain_sequence INTEGER, chain_entry_hash TEXT, signature TEXT NOT NULL, FOREIGN KEY (task_id) REFERENCES tasks(task_id), FOREIGN KEY (agent_id) REFERENCES agents(id));
CREATE INDEX IF NOT EXISTS idx_receipts_task ON delivery_receipts(task_id);
CREATE INDEX IF NOT EXISTS idx_receipts_agent ON delivery_receipts(agent_id);
CREATE TABLE IF NOT EXISTS used_signatures (signature_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_used_sigs_expires ON used_signatures(expires_at);
CREATE TABLE IF NOT EXISTS verification_assignments (assignment_id TEXT PRIMARY KEY, verifier_agent_id TEXT NOT NULL, target_agent_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, FOREIGN KEY (verifier_agent_id) REFERENCES agents(id), FOREIGN KEY (target_agent_id) REFERENCES agents(id));
CREATE INDEX IF NOT EXISTS idx_assignments_expires ON verification_assignments(expires_at);
ALTER TABLE agents ADD COLUMN wallet_address TEXT;
ALTER TABLE agents ADD COLUMN wallet_network TEXT DEFAULT 'eip155:8453';
ALTER TABLE tasks ADD COLUMN bounty_amount TEXT;
ALTER TABLE tasks ADD COLUMN bounty_token TEXT;
ALTER TABLE tasks ADD COLUMN bounty_network TEXT;
ALTER TABLE tasks ADD COLUMN payment_signature TEXT;
ALTER TABLE tasks ADD COLUMN payment_verified INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN payment_settled INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN payment_tx_hash TEXT;
ALTER TABLE tasks ADD COLUMN payment_expires_at TEXT;
ALTER TABLE tasks ADD COLUMN auto_release_at TEXT;
ALTER TABLE tasks ADD COLUMN payment_status TEXT DEFAULT 'none';
CREATE TABLE IF NOT EXISTS payment_events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, event_type TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL, FOREIGN KEY (task_id) REFERENCES tasks(task_id));
CREATE INDEX IF NOT EXISTS idx_payment_events_task ON payment_events(task_id);
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
  /** Override registered_at timestamp (ISO string). Defaults to now. */
  registeredAt?: string;
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
  const registeredAt = options.registeredAt ?? new Date().toISOString();

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
    registeredAt,
    status,
    reputationScore
  );

  return { ...kp, name };
}

/**
 * Make a test agent eligible to be a verifier by satisfying sybil guards:
 * - Set registered_at to 25 hours ago
 * - Insert a dummy received verification (FK disabled for bootstrap verifier)
 */
export async function makeEligibleVerifier(db: SQLiteAdapter, agentId: string): Promise<void> {
  const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  await db.run('UPDATE agents SET registered_at = ? WHERE id = ?', twentyFiveHoursAgo, agentId);
  // Temporarily disable FK to insert a bootstrap verification from a non-existent verifier
  await db.exec('PRAGMA foreign_keys = OFF');
  await db.run(
    `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, nonce, created_at)
     VALUES (?, ?, ?, 'pass', 0.9, NULL, 'bootstrap-sig', ?, ?)`,
    `bootstrap-${agentId}`, 'ag_bootstrap', agentId, `bootstrap-nonce-${agentId}`, twentyFiveHoursAgo
  );
  await db.exec('PRAGMA foreign_keys = ON');
}

/**
 * Create a properly signed AgentSig request.
 * Returns headers { Authorization, 'X-Timestamp', 'X-Nonce' }.
 * Includes a random nonce to make signatures non-deterministic (L1).
 */
export async function signRequest(
  keypair: TestKeypair,
  method: string,
  path: string,
  body: string = ''
): Promise<{ Authorization: string; 'X-Timestamp': string; 'X-Nonce': string }> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body)));
  const message = `${method}:${path}:${timestamp}:${bodyHash}:${nonce}`;
  const messageBytes = new TextEncoder().encode(message);
  const sigBytes = await sign(messageBytes, keypair.privateKey);
  const base64Sig = btoa(String.fromCharCode(...sigBytes));
  return {
    Authorization: `AgentSig ${keypair.publicKeyB58}:${base64Sig}`,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
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

  // Inject DB + env bindings via middleware
  app.use('*', async (c, next) => {
    c.set('db', db);
    // Provide env bindings so c.env.* doesn't crash
    (c.env as Record<string, string>) = {
      ...(c.env ?? {}),
      PAYMENT_ENCRYPTION_KEY: 'a'.repeat(64), // test key for payment encryption
    };
    await next();
  });

  app.route('/v1/register', registerRoutes);
  app.route('/v1/agents', agentRoutes);
  app.route('/v1/verify', verifyRoutes);
  app.route('/v1/agents', messageRoutes);
  app.route('/v1/messages', messageActions);
  app.route('/v1/tasks', taskRoutes);

  return app;
}
