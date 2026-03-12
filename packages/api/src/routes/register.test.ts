import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { getPublicKey, sign, utils } from '@noble/ed25519';
import {
  setupTestDb,
  createTestApp,
  createTestKeypair,
} from '../test-helpers.js';
import {
  base58Encode,
  publicKeyToAgentId,
  DEFAULT_DIFFICULTY,
} from '../crypto/index.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';

// Mock twitter so registration doesn't try to tweet
vi.mock('../lib/twitter.js', () => ({
  postTweet: vi.fn(),
  registrationTweet: vi.fn(() => 'mock tweet'),
  firstVerificationTweet: vi.fn(() => 'mock tweet'),
}));

// Mock verifyProofOfWork so we don't have to solve at difficulty=22 in tests.
// The crypto/index.test.ts already tests the real PoW logic.
vi.mock('../crypto/index.js', async () => {
  const actual = await vi.importActual<typeof import('../crypto/index.js')>('../crypto/index.js');
  return {
    ...actual,
    verifyProofOfWork: vi.fn(() => true),
  };
});

// Mock fetch for webhooks
const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
vi.stubGlobal('fetch', mockFetch);

async function doFullRegistration(
  app: ReturnType<typeof createTestApp>,
  options: {
    name?: string;
  } = {}
) {
  const privateKey = utils.randomPrivateKey();
  const publicKey = await getPublicKey(privateKey);
  const publicKeyB58 = base58Encode(publicKey);

  // Step 1: init
  const initRes = await app.request('/v1/register/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_key: publicKeyB58 }),
  });
  expect(initRes.status).toBe(200);
  const initData = await initRes.json() as {
    challenge_id: string;
    challenge: string;
    difficulty: number;
    previous_hash: string;
  };

  // Step 2: sign the challenge bytes
  const challengeData = new TextEncoder().encode(initData.challenge);
  const sigBytes = await sign(challengeData, privateKey);
  const signature = btoa(String.fromCharCode(...sigBytes));

  // Step 3: use a dummy nonce — verifyProofOfWork is mocked to return true in these tests
  const nonce = 'deadbeefdeadbeef';

  // Step 4: complete
  const profile = {
    name: options.name ?? `TestBot-${Date.now()}`,
    description: 'A test bot for automated testing',
    capabilities: ['test', 'code-generation'],
    protocols: ['http', 'mcp'],
  };

  const completeRes = await app.request('/v1/register/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challenge_id: initData.challenge_id,
      public_key: publicKeyB58,
      signature,
      nonce,
      profile,
    }),
  });

  return { completeRes, publicKey, privateKey, publicKeyB58, agentId: publicKeyToAgentId(publicKey), profile };
}

describe('POST /v1/register/init', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = setupTestDb();
    app = createTestApp(db);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('returns challenge, difficulty, and previous_hash', async () => {
    const privateKey = utils.randomPrivateKey();
    const publicKey = await getPublicKey(privateKey);
    const publicKeyB58 = base58Encode(publicKey);

    const res = await app.request('/v1/register/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: publicKeyB58 }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.challenge_id).toBeDefined();
    expect(data.challenge).toBeDefined();
    expect(data.difficulty).toBe(DEFAULT_DIFFICULTY);
    expect(data.previous_hash).toBeDefined();
    expect(data.expires_at).toBeDefined();
  });

  it('returns 409 for already-registered agent', async () => {
    const { agentId, publicKeyB58, publicKey } = await doFullRegistration(app);

    // Now try to init again with the same key
    const res = await app.request('/v1/register/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: publicKeyB58 }),
    });

    expect(res.status).toBe(409);
    const data = await res.json() as { error: string };
    expect(data.error).toBe('conflict');
  });

  it('returns 400 for invalid JSON', async () => {
    const res = await app.request('/v1/register/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing public_key', async () => {
    const res = await app.request('/v1/register/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/register/complete', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = setupTestDb();
    app = createTestApp(db);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('full registration flow succeeds (201)', async () => {
    const { completeRes } = await doFullRegistration(app, { overrideDifficulty: true });
    expect(completeRes.status).toBe(201);
    const data = await completeRes.json() as Record<string, unknown>;
    expect(data.agent_id).toBeDefined();
    expect(data.status).toBe('pending');
    expect(data.chain_sequence).toBeDefined();
    expect(data.entry_hash).toBeDefined();
  });

  it('chain entry is created on registration', async () => {
    const { completeRes, agentId } = await doFullRegistration(app, { overrideDifficulty: true });
    expect(completeRes.status).toBe(201);

    const chainEntry = await db.get<{ agent_id: string }>(
      'SELECT agent_id FROM chain WHERE agent_id = ?', agentId
    );
    expect(chainEntry).not.toBeNull();
    expect(chainEntry!.agent_id).toBe(agentId);
  });

  it('expired challenge → 400', async () => {
    const privateKey = utils.randomPrivateKey();
    const publicKey = await getPublicKey(privateKey);
    const publicKeyB58 = base58Encode(publicKey);
    const agentId = publicKeyToAgentId(publicKey);

    // Manually insert an expired challenge
    const challengeId = crypto.randomUUID();
    const now = new Date();
    const expired = new Date(now.getTime() - 10 * 60 * 1000); // 10 minutes ago

    await db.run(
      `INSERT INTO challenges (id, agent_id, challenge_bytes, status, created_at, expires_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
      challengeId, agentId, 'somechallenge', now.toISOString(), expired.toISOString()
    );

    // Dummy nonce (PoW is mocked to always pass)
    const nonce = 'deadbeefdeadbeef';
    const challengeData = new TextEncoder().encode('somechallenge');
    const sigBytes = await sign(challengeData, privateKey);
    const signature = btoa(String.fromCharCode(...sigBytes));

    const res = await app.request('/v1/register/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge_id: challengeId,
        public_key: publicKeyB58,
        signature,
        nonce,
        profile: {
          name: 'ExpiredTest',
          description: 'test',
          capabilities: ['test'],
          protocols: ['http'],
        },
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json() as { message: string };
    expect(data.message).toContain('expired');
  });

  it('invalid signature → 400', async () => {
    const privateKey = utils.randomPrivateKey();
    const publicKey = await getPublicKey(privateKey);
    const publicKeyB58 = base58Encode(publicKey);
    const agentId = publicKeyToAgentId(publicKey);

    // Get a valid challenge
    const initRes = await app.request('/v1/register/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: publicKeyB58 }),
    });
    const { challenge_id } = await initRes.json() as { challenge_id: string };

    // Dummy nonce (PoW is mocked to always pass)
    const nonce = 'deadbeefdeadbeef';
    // Use wrong signature (sign something else)
    const wrongMsg = new TextEncoder().encode('wrong message');
    const sigBytes = await sign(wrongMsg, privateKey);
    const signature = btoa(String.fromCharCode(...sigBytes));

    const res = await app.request('/v1/register/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge_id,
        public_key: publicKeyB58,
        signature,
        nonce,
        profile: {
          name: 'InvalidSigTest',
          description: 'test',
          capabilities: ['test'],
          protocols: ['http'],
        },
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json() as { message: string };
    expect(data.message.toLowerCase()).toContain('signature');
  });

  it('duplicate name → 409', async () => {
    const sharedName = `UniqueName-${Date.now()}`;

    // First registration succeeds
    const { completeRes: first } = await doFullRegistration(app, {
      name: sharedName,
    });
    expect(first.status).toBe(201);

    // Second registration with same name → 409
    const privateKey2 = utils.randomPrivateKey();
    const publicKey2 = await getPublicKey(privateKey2);
    const publicKeyB58_2 = base58Encode(publicKey2);

    const initRes2 = await app.request('/v1/register/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: publicKeyB58_2 }),
    });
    const initData2 = await initRes2.json() as { challenge_id: string; challenge: string };

    const challengeData2 = new TextEncoder().encode(initData2.challenge);
    const sigBytes2 = await sign(challengeData2, privateKey2);
    const signature2 = btoa(String.fromCharCode(...sigBytes2));
    const nonce2 = 'deadbeefdeadbeef'; // PoW mocked to always pass

    const completeRes2 = await app.request('/v1/register/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge_id: initData2.challenge_id,
        public_key: publicKeyB58_2,
        signature: signature2,
        nonce: nonce2,
        profile: {
          name: sharedName, // same name!
          description: 'Another test bot',
          capabilities: ['test'],
          protocols: ['http'],
        },
      }),
    });

    expect(completeRes2.status).toBe(409);
  });
});
