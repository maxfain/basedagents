import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  setupTestDb,
  createTestApp,
  createTestAgent,
  signRequest,
} from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import type { TestKeypair } from '../test-helpers.js';
import { encryptPaymentSignature, decryptPaymentSignature } from './crypto.js';

// Mock twitter
vi.mock('../lib/twitter.js', () => ({
  postTweet: vi.fn(),
  registrationTweet: vi.fn(() => 'mock tweet'),
  firstVerificationTweet: vi.fn(() => 'mock tweet'),
}));

// Mock skills resolver
vi.mock('../skills/resolver.js', () => ({
  resolveAllAgentSkills: vi.fn().mockResolvedValue({ updated: 0 }),
  computeSkillReputations: vi.fn().mockResolvedValue(undefined),
}));

// Mock CDP provider — we don't actually call the CDP API in tests
vi.mock('./cdp-provider.js', () => {
  return {
    CdpPaymentProvider: vi.fn().mockImplementation(() => ({
      name: 'cdp',
      verify: vi.fn().mockResolvedValue({
        valid: true,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      settle: vi.fn().mockResolvedValue({
        success: true,
        tx_hash: '0xmocktxhash123456789abcdef',
      }),
    })),
  };
});

const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

// Test encryption key (64 hex chars = 32 bytes)
const TEST_ENC_KEY = 'a'.repeat(64);

describe('x402 Payment Integration', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;
  let creator: TestKeypair & { name: string };
  let claimer: TestKeypair & { name: string };

  beforeEach(async () => {
    db = setupTestDb();
    app = createTestApp(db);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    creator = await createTestAgent(db, { status: 'active', capabilities: ['research', 'code'] });
    claimer = await createTestAgent(db, { status: 'active', capabilities: ['code', 'data'] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── Encryption Tests ───

  describe('AES-256-GCM encryption', () => {
    it('encrypts and decrypts a payment signature', async () => {
      const original = 'x402-signed-payment-authorization-data-base64';
      const encrypted = await encryptPaymentSignature(original, TEST_ENC_KEY);
      expect(encrypted).not.toBe(original);

      const decrypted = await decryptPaymentSignature(encrypted, TEST_ENC_KEY);
      expect(decrypted).toBe(original);
    });

    it('produces different ciphertexts for same plaintext (random IV)', async () => {
      const original = 'same-payment-signature';
      const enc1 = await encryptPaymentSignature(original, TEST_ENC_KEY);
      const enc2 = await encryptPaymentSignature(original, TEST_ENC_KEY);
      expect(enc1).not.toBe(enc2);

      // But both decrypt to the same thing
      expect(await decryptPaymentSignature(enc1, TEST_ENC_KEY)).toBe(original);
      expect(await decryptPaymentSignature(enc2, TEST_ENC_KEY)).toBe(original);
    });

    it('fails to decrypt with wrong key', async () => {
      const original = 'secret-payment';
      const encrypted = await encryptPaymentSignature(original, TEST_ENC_KEY);
      const wrongKey = 'b'.repeat(64);

      await expect(decryptPaymentSignature(encrypted, wrongKey)).rejects.toThrow();
    });
  });

  // ─── Wallet Endpoints ───

  describe('Wallet Identity', () => {
    it('GET /v1/agents/:id/wallet returns null wallet by default', async () => {
      const res = await app.request(`/v1/agents/${creator.agentId}/wallet`);
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.agent_id).toBe(creator.agentId);
      expect(data.wallet_address).toBeNull();
      expect(data.wallet_network).toBe('eip155:8453');
    });

    it('PATCH /v1/agents/:id/wallet updates wallet address', async () => {
      const body = JSON.stringify({
        wallet_address: '0x1234567890abcdef1234567890abcdef12345678',
      });
      const headers = await signRequest(creator, 'PATCH', `/v1/agents/${creator.agentId}/wallet`, body);

      const res = await app.request(`/v1/agents/${creator.agentId}/wallet`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.wallet_address).toBe('0x1234567890abcdef1234567890abcdef12345678');
    });

    it('PATCH /v1/agents/:id/wallet rejects invalid address', async () => {
      const body = JSON.stringify({ wallet_address: 'not-an-address' });
      const headers = await signRequest(creator, 'PATCH', `/v1/agents/${creator.agentId}/wallet`, body);

      const res = await app.request(`/v1/agents/${creator.agentId}/wallet`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      expect(res.status).toBe(400);
    });

    it('PATCH /v1/agents/:id/wallet rejects other agent → 403', async () => {
      const body = JSON.stringify({
        wallet_address: '0x1234567890abcdef1234567890abcdef12345678',
      });
      const headers = await signRequest(claimer, 'PATCH', `/v1/agents/${creator.agentId}/wallet`, body);

      const res = await app.request(`/v1/agents/${creator.agentId}/wallet`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      expect(res.status).toBe(403);
    });

    it('wallet_address shows in agent profile', async () => {
      await db.run(
        'UPDATE agents SET wallet_address = ? WHERE id = ?',
        '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', creator.agentId
      );

      const res = await app.request(`/v1/agents/${creator.agentId}`);
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.wallet_address).toBe('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    });
  });

  // ─── Task with Bounty ───

  describe('Paid Task Creation', () => {
    it('creates task with bounty when payment signature provided', async () => {
      const body = JSON.stringify({
        title: 'Paid Research Task',
        description: 'Research AI safety for $5',
        category: 'research',
        bounty: { amount: '$5.00', token: 'USDC', network: 'eip155:8453' },
      });
      const headers = await signRequest(creator, 'POST', '/v1/tasks', body);

      const res = await app.request('/v1/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-PAYMENT-SIGNATURE': 'mock-x402-payment-signature',
          ...headers,
        },
        body,
      });

      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(data.payment_status).toBe('authorized');

      // Verify DB state
      const task = await db.get<{ bounty_amount: string; payment_status: string; payment_verified: number }>(
        'SELECT bounty_amount, payment_status, payment_verified FROM tasks WHERE task_id = ?', data.task_id
      );
      expect(task!.bounty_amount).toBe('$5.00');
      expect(task!.payment_status).toBe('authorized');
      expect(task!.payment_verified).toBe(1);
    });

    it('rejects bounty without X-PAYMENT-SIGNATURE header → 402', async () => {
      const body = JSON.stringify({
        title: 'Missing Payment',
        description: 'Has bounty but no signature',
        bounty: { amount: '$5.00', token: 'USDC', network: 'eip155:8453' },
      });
      const headers = await signRequest(creator, 'POST', '/v1/tasks', body);

      const res = await app.request('/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });

      expect(res.status).toBe(402);
      const data = await res.json() as Record<string, unknown>;
      expect(data.error).toBe('payment_required');
      expect(data.payment_docs).toBeDefined();
      expect(data.help).toBeDefined();
    });

    it('creates task without bounty normally (backward compat)', async () => {
      const body = JSON.stringify({
        title: 'Free Task',
        description: 'No bounty',
      });
      const headers = await signRequest(creator, 'POST', '/v1/tasks', body);

      const res = await app.request('/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });

      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.payment_status).toBeUndefined(); // no payment fields in response for free tasks
    });
  });

  // ─── Payment Status Endpoint ───

  describe('GET /v1/tasks/:id/payment', () => {
    it('returns payment status for a paid task', async () => {
      // Create paid task directly in DB
      const taskId = 'task_payment_test_1';
      const now = new Date().toISOString();
      await db.run(
        `INSERT INTO tasks (task_id, creator_agent_id, title, description, status, created_at, bounty_amount, bounty_token, bounty_network, payment_status)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
        taskId, creator.agentId, 'Test', 'Test', now, '$10.00', 'USDC', 'eip155:8453', 'authorized'
      );
      await db.run(
        `INSERT INTO payment_events (id, task_id, event_type, details, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        'pev_test1', taskId, 'authorized', JSON.stringify({ amount: '$10.00' }), now
      );

      const res = await app.request(`/v1/tasks/${taskId}/payment`);
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.ok).toBe(true);
      const payment = data.payment as Record<string, unknown>;
      expect(payment.status).toBe('authorized');
      expect((payment.bounty as Record<string, unknown>).amount).toBe('$10.00');
      const events = data.events as Array<Record<string, unknown>>;
      expect(events.length).toBe(1);
      expect(events[0].event_type).toBe('authorized');
    });

    it('returns payment_status=none for non-paid task', async () => {
      const taskId = 'task_nopay_test';
      const now = new Date().toISOString();
      await db.run(
        `INSERT INTO tasks (task_id, creator_agent_id, title, description, status, created_at)
         VALUES (?, ?, ?, ?, 'open', ?)`,
        taskId, creator.agentId, 'Free', 'Free task', now
      );

      const res = await app.request(`/v1/tasks/${taskId}/payment`);
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      const payment = data.payment as Record<string, unknown>;
      expect(payment.status).toBe('none');
      expect(payment.bounty).toBeNull();
    });
  });

  // ─── Dispute Flow ───

  describe('POST /v1/tasks/:id/dispute', () => {
    async function createPaidTask(): Promise<string> {
      const body = JSON.stringify({
        title: 'Disputed Task',
        description: 'Will be disputed',
        bounty: { amount: '$5.00', token: 'USDC', network: 'eip155:8453' },
      });
      const headers = await signRequest(creator, 'POST', '/v1/tasks', body);
      const res = await app.request('/v1/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-PAYMENT-SIGNATURE': 'mock-payment',
          ...headers,
        },
        body,
      });
      const data = await res.json() as { task_id: string };
      return data.task_id;
    }

    it('creator can dispute a submitted task', async () => {
      const taskId = await createPaidTask();

      // Claim
      let headers = await signRequest(claimer, 'POST', `/v1/tasks/${taskId}/claim`);
      await app.request(`/v1/tasks/${taskId}/claim`, { method: 'POST', headers });

      // Submit
      const submitBody = JSON.stringify({
        submission_type: 'json',
        content: '{"result": "bad work"}',
        summary: 'Half-done',
      });
      headers = await signRequest(claimer, 'POST', `/v1/tasks/${taskId}/submit`, submitBody);
      await app.request(`/v1/tasks/${taskId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: submitBody,
      });

      // Dispute
      const disputeBody = JSON.stringify({ reason: 'Work was incomplete' });
      headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/dispute`, disputeBody);
      const res = await app.request(`/v1/tasks/${taskId}/dispute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: disputeBody,
      });

      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(data.payment_status).toBe('disputed');

      // Verify auto_release_at is cleared
      const task = await db.get<{ payment_status: string; auto_release_at: string | null }>(
        'SELECT payment_status, auto_release_at FROM tasks WHERE task_id = ?', taskId
      );
      expect(task!.payment_status).toBe('disputed');
      expect(task!.auto_release_at).toBeNull();

      // Verify payment event logged
      const events = await db.all<{ event_type: string }>(
        'SELECT event_type FROM payment_events WHERE task_id = ?', taskId
      );
      const disputeEvents = events.filter(e => e.event_type === 'disputed');
      expect(disputeEvents.length).toBe(1);
    });

    it('only creator can dispute → 403', async () => {
      const taskId = await createPaidTask();

      let headers = await signRequest(claimer, 'POST', `/v1/tasks/${taskId}/claim`);
      await app.request(`/v1/tasks/${taskId}/claim`, { method: 'POST', headers });

      const submitBody = JSON.stringify({
        submission_type: 'json',
        content: '{}',
        summary: 'done',
      });
      headers = await signRequest(claimer, 'POST', `/v1/tasks/${taskId}/submit`, submitBody);
      await app.request(`/v1/tasks/${taskId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: submitBody,
      });

      // Claimer tries to dispute — should fail
      headers = await signRequest(claimer, 'POST', `/v1/tasks/${taskId}/dispute`);
      const res = await app.request(`/v1/tasks/${taskId}/dispute`, {
        method: 'POST',
        headers,
      });
      expect(res.status).toBe(403);
    });

    it('cannot dispute non-submitted task → 400', async () => {
      const taskId = await createPaidTask();

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/dispute`);
      const res = await app.request(`/v1/tasks/${taskId}/dispute`, {
        method: 'POST',
        headers,
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── Settlement on Verify ───

  describe('Settlement on verify', () => {
    it('settles payment when creator verifies a paid task', async () => {
      // Create paid task
      const createBody = JSON.stringify({
        title: 'Settlement Test',
        description: 'Should settle on verify',
        bounty: { amount: '$5.00', token: 'USDC', network: 'eip155:8453' },
      });
      let headers = await signRequest(creator, 'POST', '/v1/tasks', createBody);
      const createRes = await app.request('/v1/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-PAYMENT-SIGNATURE': 'mock-x402-sig',
          ...headers,
        },
        body: createBody,
      });
      const { task_id: taskId } = await createRes.json() as { task_id: string };

      // Claim
      headers = await signRequest(claimer, 'POST', `/v1/tasks/${taskId}/claim`);
      await app.request(`/v1/tasks/${taskId}/claim`, { method: 'POST', headers });

      // Submit
      const submitBody = JSON.stringify({
        submission_type: 'json',
        content: '{"result": "done"}',
        summary: 'All done',
      });
      headers = await signRequest(claimer, 'POST', `/v1/tasks/${taskId}/submit`, submitBody);
      await app.request(`/v1/tasks/${taskId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: submitBody,
      });

      // Verify (triggers settlement)
      headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/verify`);
      const verifyRes = await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers,
      });

      expect(verifyRes.status).toBe(200);
      const data = await verifyRes.json() as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(data.status).toBe('verified');
      expect(data.payment_status).toBe('settled');
      expect(data.payment_tx_hash).toBe('0xmocktxhash123456789abcdef');

      // Verify DB state
      const task = await db.get<{ payment_status: string; payment_settled: number; payment_tx_hash: string }>(
        'SELECT payment_status, payment_settled, payment_tx_hash FROM tasks WHERE task_id = ?', taskId
      );
      expect(task!.payment_status).toBe('settled');
      expect(task!.payment_settled).toBe(1);
      expect(task!.payment_tx_hash).toBe('0xmocktxhash123456789abcdef');

      // Verify payment events
      const events = await db.all<{ event_type: string }>(
        'SELECT event_type FROM payment_events WHERE task_id = ? ORDER BY created_at ASC', taskId
      );
      expect(events.map(e => e.event_type)).toContain('authorized');
      expect(events.map(e => e.event_type)).toContain('settled');
    });
  });

  // ─── Cancel with Payment ───

  describe('Cancel with payment', () => {
    it('marks payment as expired when task with bounty is cancelled', async () => {
      const createBody = JSON.stringify({
        title: 'Cancel Payment Test',
        description: 'Will be cancelled',
        bounty: { amount: '$3.00', token: 'USDC', network: 'eip155:8453' },
      });
      let headers = await signRequest(creator, 'POST', '/v1/tasks', createBody);
      const createRes = await app.request('/v1/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-PAYMENT-SIGNATURE': 'mock-sig',
          ...headers,
        },
        body: createBody,
      });
      const { task_id: taskId } = await createRes.json() as { task_id: string };

      // Cancel
      headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/cancel`);
      const res = await app.request(`/v1/tasks/${taskId}/cancel`, {
        method: 'POST',
        headers,
      });
      expect(res.status).toBe(200);

      // Verify payment_status = expired
      const task = await db.get<{ payment_status: string }>(
        'SELECT payment_status FROM tasks WHERE task_id = ?', taskId
      );
      expect(task!.payment_status).toBe('expired');

      // Verify payment event logged
      const events = await db.all<{ event_type: string }>(
        'SELECT event_type FROM payment_events WHERE task_id = ?', taskId
      );
      expect(events.map(e => e.event_type)).toContain('expired');
    });
  });

  // ─── Task detail strips payment_signature ───

  describe('Task detail security', () => {
    it('GET /v1/tasks/:id never exposes encrypted payment_signature', async () => {
      const createBody = JSON.stringify({
        title: 'Sig Strip Test',
        description: 'Test',
        bounty: { amount: '$1.00', token: 'USDC', network: 'eip155:8453' },
      });
      const headers = await signRequest(creator, 'POST', '/v1/tasks', createBody);
      const createRes = await app.request('/v1/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-PAYMENT-SIGNATURE': 'secret-sig',
          ...headers,
        },
        body: createBody,
      });
      const { task_id: taskId } = await createRes.json() as { task_id: string };

      const res = await app.request(`/v1/tasks/${taskId}`);
      expect(res.status).toBe(200);
      const data = await res.json() as { task: Record<string, unknown> };
      expect(data.task.payment_signature).toBeUndefined();
      expect(data.task.payment_status).toBe('authorized');
      expect(data.task.bounty_amount).toBe('$1.00');
    });
  });

  // ─── Auto-release timer ───

  describe('Auto-release timer', () => {
    it('sets auto_release_at when a paid task is submitted', async () => {
      const createBody = JSON.stringify({
        title: 'Auto Release Test',
        description: 'Test auto-release',
        bounty: { amount: '$2.00', token: 'USDC', network: 'eip155:8453' },
      });
      let headers = await signRequest(creator, 'POST', '/v1/tasks', createBody);
      const createRes = await app.request('/v1/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-PAYMENT-SIGNATURE': 'mock-sig',
          ...headers,
        },
        body: createBody,
      });
      const { task_id: taskId } = await createRes.json() as { task_id: string };

      // Claim
      headers = await signRequest(claimer, 'POST', `/v1/tasks/${taskId}/claim`);
      await app.request(`/v1/tasks/${taskId}/claim`, { method: 'POST', headers });

      // Submit
      const submitBody = JSON.stringify({
        submission_type: 'json',
        content: '{"done": true}',
        summary: 'Done',
      });
      headers = await signRequest(claimer, 'POST', `/v1/tasks/${taskId}/submit`, submitBody);
      await app.request(`/v1/tasks/${taskId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: submitBody,
      });

      const task = await db.get<{ auto_release_at: string | null }>(
        'SELECT auto_release_at FROM tasks WHERE task_id = ?', taskId
      );
      expect(task!.auto_release_at).not.toBeNull();
      // Should be ~7 days from now
      const releaseDate = new Date(task!.auto_release_at!);
      const expectedMin = new Date(Date.now() + 6.9 * 24 * 60 * 60 * 1000);
      const expectedMax = new Date(Date.now() + 7.1 * 24 * 60 * 60 * 1000);
      expect(releaseDate.getTime()).toBeGreaterThan(expectedMin.getTime());
      expect(releaseDate.getTime()).toBeLessThan(expectedMax.getTime());
    });
  });
});
