import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  setupTestDb,
  createTestApp,
  createTestAgent,
  signRequest,
} from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import type { TestKeypair } from '../test-helpers.js';

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

const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

describe('Task Marketplace', () => {
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

  // ─── Helper ───

  async function createTask(agent: TestKeypair, overrides: Record<string, unknown> = {}): Promise<string> {
    const body = JSON.stringify({
      title: 'Test Task',
      description: 'Do something useful',
      category: 'code',
      required_capabilities: ['code'],
      ...overrides,
    });
    const headers = await signRequest(agent, 'POST', '/v1/tasks', body);
    const res = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    const data = await res.json() as { task_id: string };
    return data.task_id;
  }

  async function claimTask(agent: TestKeypair, taskId: string): Promise<Response> {
    const headers = await signRequest(agent, 'POST', `/v1/tasks/${taskId}/claim`);
    return app.request(`/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: { ...headers },
    });
  }

  async function submitDeliverable(agent: TestKeypair, taskId: string, overrides: Record<string, unknown> = {}): Promise<Response> {
    const body = JSON.stringify({
      submission_type: 'json',
      content: '{"result": "done"}',
      summary: 'Task completed successfully',
      ...overrides,
    });
    const headers = await signRequest(agent, 'POST', `/v1/tasks/${taskId}/submit`, body);
    return app.request(`/v1/tasks/${taskId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
  }

  async function deliverTask(agent: TestKeypair, taskId: string, overrides: Record<string, unknown> = {}): Promise<Response> {
    const body = JSON.stringify({
      summary: 'Delivered the work',
      submission_type: 'json',
      submission_content: '{"result": "done"}',
      ...overrides,
    });
    const headers = await signRequest(agent, 'POST', `/v1/tasks/${taskId}/deliver`, body);
    return app.request(`/v1/tasks/${taskId}/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
  }

  // ─── POST /v1/tasks — Create task ───

  describe('POST /v1/tasks — Create task', () => {
    it('creates a task successfully', async () => {
      const body = JSON.stringify({
        title: 'Research AI Safety',
        description: 'Write a report on AI safety best practices',
        category: 'research',
        required_capabilities: ['research'],
      });
      const headers = await signRequest(creator, 'POST', '/v1/tasks', body);

      const res = await app.request('/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });

      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(data.task_id).toBeDefined();
      expect((data.task_id as string).startsWith('task_')).toBe(true);
      expect(data.status).toBe('open');
    });

    it('creates a task with minimal fields', async () => {
      const body = JSON.stringify({
        title: 'Simple Task',
        description: 'Do this thing',
      });
      const headers = await signRequest(creator, 'POST', '/v1/tasks', body);

      const res = await app.request('/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });

      expect(res.status).toBe(200);
    });

    it('unauthenticated create → 401', async () => {
      const body = JSON.stringify({ title: 'Test', description: 'Test' });
      const res = await app.request('/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status).toBe(401);
    });

    it('invalid body → 400', async () => {
      const body = JSON.stringify({ title: '' });
      const headers = await signRequest(creator, 'POST', '/v1/tasks', body);

      const res = await app.request('/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });

      expect(res.status).toBe(400);
    });

    it('notifies matching agents via webhook on create', async () => {
      const matchingAgent = await createTestAgent(db, {
        status: 'active',
        capabilities: ['research'],
        webhookUrl: 'https://webhook.example.com/tasks',
      });

      const body = JSON.stringify({
        title: 'Research Task',
        description: 'Need research help',
        required_capabilities: ['research'],
      });
      const headers = await signRequest(creator, 'POST', '/v1/tasks', body);

      await app.request('/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });

      await new Promise(r => setTimeout(r, 10));

      const webhookCalls = mockFetch.mock.calls.filter(
        ([url]: [string]) => url === 'https://webhook.example.com/tasks'
      );
      expect(webhookCalls.length).toBe(1);
      const webhookBody = JSON.parse(webhookCalls[0][1].body);
      expect(webhookBody.type).toBe('task.available');
      expect(webhookBody.task.title).toBe('Research Task');
    });

    it('pending agent cannot create tasks → 403', async () => {
      const pendingAgent = await createTestAgent(db, { status: 'pending' });
      const body = JSON.stringify({ title: 'Test', description: 'Test' });
      const headers = await signRequest(pendingAgent, 'POST', '/v1/tasks', body);

      const res = await app.request('/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      expect(res.status).toBe(403);
    });
  });

  // ─── GET /v1/tasks — Browse tasks ───

  describe('GET /v1/tasks — Browse tasks', () => {
    it('lists open tasks by default (no auth needed)', async () => {
      await createTask(creator);
      await createTask(creator, { title: 'Second Task' });

      const res = await app.request('/v1/tasks');
      expect(res.status).toBe(200);
      const data = await res.json() as { ok: boolean; tasks: unknown[] };
      expect(data.ok).toBe(true);
      expect(data.tasks.length).toBe(2);
    });

    it('filters by status', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      // Default (no filter) returns all non-cancelled tasks — includes claimed
      const res = await app.request('/v1/tasks');
      const data = await res.json() as { tasks: unknown[] };
      expect(data.tasks.length).toBe(1);

      // Explicit status=open should exclude claimed
      const resOpen = await app.request('/v1/tasks?status=open');
      const dataOpen = await resOpen.json() as { tasks: unknown[] };
      expect(dataOpen.tasks.length).toBe(0);

      // Explicit status=claimed
      const res2 = await app.request('/v1/tasks?status=claimed');
      const data2 = await res2.json() as { tasks: unknown[] };
      expect(data2.tasks.length).toBe(1);
    });

    it('filters by category', async () => {
      await createTask(creator, { category: 'research' });
      await createTask(creator, { category: 'code' });

      const res = await app.request('/v1/tasks?category=research');
      const data = await res.json() as { tasks: Record<string, unknown>[] };
      expect(data.tasks.length).toBe(1);
      expect(data.tasks[0].category).toBe('research');
    });

    it('filters by capability', async () => {
      await createTask(creator, { required_capabilities: ['research'] });
      await createTask(creator, { required_capabilities: ['code'] });

      const res = await app.request('/v1/tasks?capability=research');
      const data = await res.json() as { tasks: Record<string, unknown>[] };
      expect(data.tasks.length).toBe(1);
    });

    it('respects limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await createTask(creator, { title: `Task ${i}` });
      }

      const res = await app.request('/v1/tasks?limit=2&offset=1');
      const data = await res.json() as { tasks: unknown[] };
      expect(data.tasks.length).toBe(2);
    });
  });

  // ─── GET /v1/tasks/:id — Get task detail ───

  describe('GET /v1/tasks/:id — Get task detail', () => {
    it('returns full task details (no auth needed)', async () => {
      const taskId = await createTask(creator);

      const res = await app.request(`/v1/tasks/${taskId}`);
      expect(res.status).toBe(200);
      const data = await res.json() as { ok: boolean; task: Record<string, unknown>; submission: unknown };
      expect(data.ok).toBe(true);
      expect(data.task.task_id).toBe(taskId);
      expect(data.task.title).toBe('Test Task');
      expect(data.submission).toBeNull();
    });

    it('includes submission when submitted', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await submitDeliverable(claimer, taskId);

      const res = await app.request(`/v1/tasks/${taskId}`);
      const data = await res.json() as { task: Record<string, unknown>; submission: Record<string, unknown> };
      expect(data.task.status).toBe('submitted');
      expect(data.submission).not.toBeNull();
      expect(data.submission.summary).toBe('Task completed successfully');
    });

    it('nonexistent task → 404', async () => {
      const res = await app.request('/v1/tasks/task_nonexistent');
      expect(res.status).toBe(404);
    });
  });

  // ─── POST /v1/tasks/:id/claim — Claim task ───

  describe('POST /v1/tasks/:id/claim — Claim task', () => {
    it('claims an open task successfully', async () => {
      const taskId = await createTask(creator);

      const res = await claimTask(claimer, taskId);
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(data.task_id).toBe(taskId);
      expect(data.status).toBe('claimed');

      // Verify DB state
      const task = await db.get<{ status: string; claimed_by_agent_id: string }>(
        'SELECT status, claimed_by_agent_id FROM tasks WHERE task_id = ?', taskId
      );
      expect(task!.status).toBe('claimed');
      expect(task!.claimed_by_agent_id).toBe(claimer.agentId);
    });

    it('cannot claim your own task → 400', async () => {
      const taskId = await createTask(creator);

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/claim`);
      const res = await app.request(`/v1/tasks/${taskId}/claim`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(400);
    });

    it('claim already-claimed task → 409', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      const thirdAgent = await createTestAgent(db, { status: 'active' });
      const headers = await signRequest(thirdAgent, 'POST', `/v1/tasks/${taskId}/claim`);
      const res = await app.request(`/v1/tasks/${taskId}/claim`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(409);
    });

    it('claim nonexistent task → 404', async () => {
      const headers = await signRequest(claimer, 'POST', '/v1/tasks/task_nonexistent/claim');
      const res = await app.request('/v1/tasks/task_nonexistent/claim', {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(404);
    });

    it('unauthenticated claim → 401', async () => {
      const taskId = await createTask(creator);
      const res = await app.request(`/v1/tasks/${taskId}/claim`, { method: 'POST' });
      expect(res.status).toBe(401);
    });

    it('notifies creator via webhook on claim', async () => {
      const webhookCreator = await createTestAgent(db, {
        status: 'active',
        webhookUrl: 'https://creator-webhook.example.com/events',
      });
      const taskId = await createTask(webhookCreator);
      await claimTask(claimer, taskId);

      await new Promise(r => setTimeout(r, 10));

      const webhookCalls = mockFetch.mock.calls.filter(
        ([url]: [string]) => url === 'https://creator-webhook.example.com/events'
      );
      expect(webhookCalls.length).toBeGreaterThan(0);
      const lastCall = webhookCalls[webhookCalls.length - 1];
      const webhookBody = JSON.parse(lastCall[1].body);
      expect(webhookBody.type).toBe('task.claimed');
      expect(webhookBody.claimed_by.agent_id).toBe(claimer.agentId);
    });
  });

  // ─── POST /v1/tasks/:id/submit — Submit deliverable ───

  describe('POST /v1/tasks/:id/submit — Submit deliverable', () => {
    it('submits deliverable successfully', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      const res = await submitDeliverable(claimer, taskId);
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(data.submission_id).toBeDefined();
      expect((data.submission_id as string).startsWith('sub_')).toBe(true);
      expect(data.status).toBe('submitted');
    });

    it('only claimer can submit → 403', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      const thirdAgent = await createTestAgent(db, { status: 'active' });
      const res = await submitDeliverable(thirdAgent, taskId);
      expect(res.status).toBe(403);
    });

    it('cannot submit for unclaimed task → 403', async () => {
      const taskId = await createTask(creator);
      const res = await submitDeliverable(claimer, taskId);
      expect(res.status).toBe(403);
    });

    it('cannot submit for already submitted task → rejected', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await submitDeliverable(claimer, taskId);

      const res = await submitDeliverable(claimer, taskId);
      // 401 (replay protection) or 400 (wrong state) — both are valid rejections
      expect([400, 401]).toContain(res.status);
    });

    it('invalid body → 400', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      const body = JSON.stringify({ submission_type: 'invalid' });
      const headers = await signRequest(claimer, 'POST', `/v1/tasks/${taskId}/submit`, body);
      const res = await app.request(`/v1/tasks/${taskId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      expect(res.status).toBe(400);
    });

    it('notifies creator via webhook on submit', async () => {
      const webhookCreator = await createTestAgent(db, {
        status: 'active',
        webhookUrl: 'https://creator-webhook.example.com/events',
      });
      const taskId = await createTask(webhookCreator);
      await claimTask(claimer, taskId);
      await submitDeliverable(claimer, taskId);

      await new Promise(r => setTimeout(r, 10));

      const webhookCalls = mockFetch.mock.calls.filter(
        ([url]: [string]) => url === 'https://creator-webhook.example.com/events'
      );
      const submitCalls = webhookCalls.filter(([, opts]: [string, { body: string }]) => {
        const b = JSON.parse(opts.body);
        return b.type === 'task.submitted';
      });
      expect(submitCalls.length).toBe(1);
      const webhookBody = JSON.parse(submitCalls[0][1].body);
      expect(webhookBody.summary).toBe('Task completed successfully');
    });
  });

  // ─── POST /v1/tasks/:id/verify — Verify deliverable ───

  describe('POST /v1/tasks/:id/verify — Verify deliverable', () => {
    it('verifies deliverable successfully', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await submitDeliverable(claimer, taskId);

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/verify`);
      const res = await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(data.status).toBe('verified');

      // Verify DB state
      const task = await db.get<{ status: string; verified_at: string }>(
        'SELECT status, verified_at FROM tasks WHERE task_id = ?', taskId
      );
      expect(task!.status).toBe('verified');
      expect(task!.verified_at).toBeDefined();
    });

    it('only creator can verify → 403', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await submitDeliverable(claimer, taskId);

      const headers = await signRequest(claimer, 'POST', `/v1/tasks/${taskId}/verify`);
      const res = await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(403);
    });

    it('cannot verify non-submitted task → 400', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/verify`);
      const res = await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(400);
    });

    it('notifies claimer via webhook on verify', async () => {
      const webhookClaimer = await createTestAgent(db, {
        status: 'active',
        webhookUrl: 'https://claimer-webhook.example.com/events',
      });
      const taskId = await createTask(creator);
      await claimTask(webhookClaimer, taskId);
      await submitDeliverable(webhookClaimer, taskId);

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/verify`);
      await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...headers },
      });

      await new Promise(r => setTimeout(r, 10));

      const webhookCalls = mockFetch.mock.calls.filter(
        ([url]: [string]) => url === 'https://claimer-webhook.example.com/events'
      );
      const verifyCalls = webhookCalls.filter(([, opts]: [string, { body: string }]) => {
        const b = JSON.parse(opts.body);
        return b.type === 'task.verified';
      });
      expect(verifyCalls.length).toBe(1);
    });
  });

  // ─── POST /v1/tasks/:id/cancel — Cancel task ───

  describe('POST /v1/tasks/:id/cancel — Cancel task', () => {
    it('cancels an open task', async () => {
      const taskId = await createTask(creator);

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/cancel`);
      const res = await app.request(`/v1/tasks/${taskId}/cancel`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.status).toBe('cancelled');
    });

    it('cancels a claimed task', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/cancel`);
      const res = await app.request(`/v1/tasks/${taskId}/cancel`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(200);
    });

    it('only creator can cancel → 403', async () => {
      const taskId = await createTask(creator);

      const headers = await signRequest(claimer, 'POST', `/v1/tasks/${taskId}/cancel`);
      const res = await app.request(`/v1/tasks/${taskId}/cancel`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(403);
    });

    it('can cancel submitted task (soft-cancel for cleanup)', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await submitDeliverable(claimer, taskId);

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/cancel`);
      const res = await app.request(`/v1/tasks/${taskId}/cancel`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(200);
    });

    it('notifies claimer via webhook on cancel', async () => {
      const webhookClaimer = await createTestAgent(db, {
        status: 'active',
        webhookUrl: 'https://claimer-webhook.example.com/events',
      });
      const taskId = await createTask(creator);
      await claimTask(webhookClaimer, taskId);

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/cancel`);
      await app.request(`/v1/tasks/${taskId}/cancel`, {
        method: 'POST',
        headers: { ...headers },
      });

      await new Promise(r => setTimeout(r, 10));

      const webhookCalls = mockFetch.mock.calls.filter(
        ([url]: [string]) => url === 'https://claimer-webhook.example.com/events'
      );
      const cancelCalls = webhookCalls.filter(([, opts]: [string, { body: string }]) => {
        const b = JSON.parse(opts.body);
        return b.type === 'task.cancelled';
      });
      expect(cancelCalls.length).toBe(1);
    });
  });

  // ─── Invalid state transitions ───

  describe('Invalid state transitions', () => {
    it('cannot claim a cancelled task → 409', async () => {
      const taskId = await createTask(creator);
      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/cancel`);
      await app.request(`/v1/tasks/${taskId}/cancel`, {
        method: 'POST',
        headers: { ...headers },
      });

      const res = await claimTask(claimer, taskId);
      expect(res.status).toBe(409);
    });

    it('cannot verify an open task → 400', async () => {
      const taskId = await createTask(creator);
      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/verify`);
      const res = await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(400);
    });

    it('can cancel a verified task (soft-cancel for cleanup)', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await submitDeliverable(claimer, taskId);

      let headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/verify`);
      await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...headers },
      });

      headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/cancel`);
      const res = await app.request(`/v1/tasks/${taskId}/cancel`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(200);
    });
  });

  // ─── Full lifecycle ───

  describe('Full lifecycle: open → claimed → submitted → verified', () => {
    it('completes the full task lifecycle', async () => {
      // 1. Create
      const taskId = await createTask(creator);

      // 2. Browse and find it
      const browseRes = await app.request('/v1/tasks');
      const browseData = await browseRes.json() as { tasks: Record<string, unknown>[] };
      expect(browseData.tasks.some(t => t.task_id === taskId)).toBe(true);

      // 3. Claim
      const claimRes = await claimTask(claimer, taskId);
      expect(claimRes.status).toBe(200);

      // 4. Submit
      const submitRes = await submitDeliverable(claimer, taskId);
      expect(submitRes.status).toBe(200);

      // 5. Verify
      const verifyHeaders = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/verify`);
      const verifyRes = await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...verifyHeaders },
      });
      expect(verifyRes.status).toBe(200);

      // 6. Check final state
      const detailRes = await app.request(`/v1/tasks/${taskId}`);
      const detailData = await detailRes.json() as { task: Record<string, unknown>; submission: Record<string, unknown> };
      expect(detailData.task.status).toBe('verified');
      expect(detailData.submission).not.toBeNull();
    });
  });

  // ─── Delivery Protocol ───

  describe('POST /v1/tasks/:id/deliver — Deliver with receipt', () => {
    it('delivers with receipt and creates chain entry', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      const res = await deliverTask(claimer, taskId);
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(data.receipt_id).toBeDefined();
      expect((data.receipt_id as string).startsWith('rcpt_')).toBe(true);
      expect(data.status).toBe('submitted');
      expect(data.chain_sequence).toBeDefined();
      expect(data.chain_entry_hash).toBeDefined();
    });

    it('delivery receipt includes chain_sequence and chain_entry_hash', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      const res = await deliverTask(claimer, taskId);
      const data = await res.json() as Record<string, unknown>;
      expect(typeof data.chain_sequence).toBe('number');
      expect(typeof data.chain_entry_hash).toBe('string');
      expect((data.chain_entry_hash as string).length).toBe(64); // sha256 hex
    });

    it('delivers with artifact_urls and commit_hash', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      const res = await deliverTask(claimer, taskId, {
        artifact_urls: ['https://example.com/artifact1.zip'],
        commit_hash: 'a'.repeat(40),
        pr_url: 'https://github.com/org/repo/pull/1',
        submission_type: 'pr',
      });
      expect(res.status).toBe(200);
    });

    it('cannot deliver if not claimed agent → 403', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      const thirdAgent = await createTestAgent(db, { status: 'active' });
      const res = await deliverTask(thirdAgent, taskId);
      expect(res.status).toBe(403);
    });

    it('cannot deliver if wrong status (open) → 403', async () => {
      const taskId = await createTask(creator);
      // Not claimed, so claimer is not assigned
      const res = await deliverTask(claimer, taskId);
      expect(res.status).toBe(403);
    });

    it('cannot deliver if already submitted → rejected', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await deliverTask(claimer, taskId);

      const res = await deliverTask(claimer, taskId);
      // 401 (replay protection) or 400 (wrong state) — both are valid rejections
      expect([400, 401]).toContain(res.status);
    });

    it('notifies creator via webhook on deliver', async () => {
      const webhookCreator = await createTestAgent(db, {
        status: 'active',
        webhookUrl: 'https://creator-webhook.example.com/events',
      });
      const taskId = await createTask(webhookCreator);
      await claimTask(claimer, taskId);
      await deliverTask(claimer, taskId);

      await new Promise(r => setTimeout(r, 10));

      const webhookCalls = mockFetch.mock.calls.filter(
        ([url]: [string]) => url === 'https://creator-webhook.example.com/events'
      );
      const deliverCalls = webhookCalls.filter(([, opts]: [string, { body: string }]) => {
        const b = JSON.parse(opts.body);
        return b.type === 'task.delivered';
      });
      expect(deliverCalls.length).toBe(1);
      const webhookBody = JSON.parse(deliverCalls[0][1].body);
      expect(webhookBody.summary).toBe('Delivered the work');
      expect(webhookBody.receipt_id).toBeDefined();
    });
  });

  describe('GET /v1/tasks/:id — includes delivery_receipt', () => {
    it('includes receipt after delivery', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await deliverTask(claimer, taskId);

      const res = await app.request(`/v1/tasks/${taskId}`);
      const data = await res.json() as { task: Record<string, unknown>; delivery_receipt: Record<string, unknown> | null };
      expect(data.task.status).toBe('submitted');
      expect(data.delivery_receipt).not.toBeNull();
      expect(data.delivery_receipt!.receipt_id).toBeDefined();
      expect(data.delivery_receipt!.chain_sequence).toBeDefined();
    });
  });

  describe('GET /v1/tasks/:id/receipt — Get delivery receipt', () => {
    it('returns full receipt with agent public key', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await deliverTask(claimer, taskId);

      const res = await app.request(`/v1/tasks/${taskId}/receipt`);
      expect(res.status).toBe(200);
      const data = await res.json() as { ok: boolean; receipt: Record<string, unknown> };
      expect(data.ok).toBe(true);
      expect(data.receipt.receipt_id).toBeDefined();
      expect(data.receipt.task_id).toBe(taskId);
      expect(data.receipt.agent_id).toBe(claimer.agentId);
      expect(data.receipt.summary).toBe('Delivered the work');
      expect(data.receipt.agent_public_key).toBeDefined();
      expect(data.receipt.chain_sequence).toBeDefined();
      expect(data.receipt.chain_entry_hash).toBeDefined();
      expect(data.receipt.signature).toBeDefined();
    });

    it('returns 404 for task with no receipt', async () => {
      const taskId = await createTask(creator);
      const res = await app.request(`/v1/tasks/${taskId}/receipt`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /v1/tasks/:id/verify — chain entry + reputation', () => {
    it('verify creates chain entry', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await deliverTask(claimer, taskId);

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/verify`);
      const res = await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(data.status).toBe('verified');
      expect(data.chain_sequence).toBeDefined();
      expect(data.chain_entry_hash).toBeDefined();
      expect(typeof data.chain_sequence).toBe('number');
    });

    it('verify notifies deliverer with chain info', async () => {
      const webhookClaimer = await createTestAgent(db, {
        status: 'active',
        webhookUrl: 'https://claimer-webhook.example.com/events',
      });
      const taskId = await createTask(creator);
      await claimTask(webhookClaimer, taskId);
      await deliverTask(webhookClaimer, taskId);

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/verify`);
      await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...headers },
      });

      await new Promise(r => setTimeout(r, 10));

      const webhookCalls = mockFetch.mock.calls.filter(
        ([url]: [string]) => url === 'https://claimer-webhook.example.com/events'
      );
      const verifyCalls = webhookCalls.filter(([, opts]: [string, { body: string }]) => {
        const b = JSON.parse(opts.body);
        return b.type === 'task.verified';
      });
      expect(verifyCalls.length).toBe(1);
      const webhookBody = JSON.parse(verifyCalls[0][1].body);
      expect(webhookBody.chain_sequence).toBeDefined();
      expect(webhookBody.chain_entry_hash).toBeDefined();
    });
  });

  // ─── Full lifecycle with delivery protocol ───

  describe('Full lifecycle with delivery protocol', () => {
    it('open → claimed → delivered → verified with chain entries', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      // Deliver
      const deliverRes = await deliverTask(claimer, taskId);
      expect(deliverRes.status).toBe(200);
      const deliverData = await deliverRes.json() as Record<string, unknown>;
      const deliverSeq = deliverData.chain_sequence as number;

      // Verify
      const verifyHeaders = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/verify`);
      const verifyRes = await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...verifyHeaders },
      });
      expect(verifyRes.status).toBe(200);
      const verifyData = await verifyRes.json() as Record<string, unknown>;
      const verifySeq = verifyData.chain_sequence as number;

      // Verify chain sequence increments
      expect(verifySeq).toBeGreaterThan(deliverSeq);

      // Check final state includes receipt
      const detailRes = await app.request(`/v1/tasks/${taskId}`);
      const detailData = await detailRes.json() as {
        task: Record<string, unknown>;
        submission: Record<string, unknown>;
        delivery_receipt: Record<string, unknown>;
      };
      expect(detailData.task.status).toBe('verified');
      expect(detailData.submission).not.toBeNull();
      expect(detailData.delivery_receipt).not.toBeNull();
    });
  });

  // ─── Payment-related behavior on standard endpoints ───

  describe('Payment fields in standard endpoints', () => {
    it('GET /v1/tasks list strips payment_signature from responses', async () => {
      // Insert a task with payment_signature directly in DB
      const taskId = 'task_sig_strip_list';
      const now = new Date().toISOString();
      await db.run(
        `INSERT INTO tasks (task_id, creator_agent_id, title, description, status, created_at, bounty_amount, bounty_token, bounty_network, payment_signature, payment_status)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
        taskId, creator.agentId, 'Sig Test', 'Test', now, '$5.00', 'USDC', 'eip155:8453', 'encrypted-secret-sig', 'authorized'
      );

      const res = await app.request('/v1/tasks?status=open');
      expect(res.status).toBe(200);
      const data = await res.json() as { tasks: Record<string, unknown>[] };
      const task = data.tasks.find(t => t.task_id === taskId);
      expect(task).toBeDefined();
      expect(task!.payment_signature).toBeUndefined();
      expect(task!.bounty_amount).toBe('$5.00');
      expect(task!.payment_status).toBe('authorized');
    });

    it('GET /v1/tasks/:id detail includes bounty fields but not payment_signature', async () => {
      const taskId = 'task_sig_strip_detail';
      const now = new Date().toISOString();
      await db.run(
        `INSERT INTO tasks (task_id, creator_agent_id, title, description, status, created_at, bounty_amount, bounty_token, bounty_network, payment_signature, payment_status)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
        taskId, creator.agentId, 'Detail Test', 'Test', now, '$10.00', 'USDC', 'eip155:8453', 'encrypted-secret', 'authorized'
      );

      const res = await app.request(`/v1/tasks/${taskId}`);
      expect(res.status).toBe(200);
      const data = await res.json() as { task: Record<string, unknown> };
      expect(data.task.payment_signature).toBeUndefined();
      expect(data.task.bounty_amount).toBe('$10.00');
      expect(data.task.bounty_token).toBe('USDC');
      expect(data.task.bounty_network).toBe('eip155:8453');
      expect(data.task.payment_status).toBe('authorized');
    });

    it('creating task without bounty still works (backward compat)', async () => {
      const taskId = await createTask(creator, {
        title: 'Free Task No Bounty',
        description: 'No bounty here',
      });

      const res = await app.request(`/v1/tasks/${taskId}`);
      expect(res.status).toBe(200);
      const data = await res.json() as { task: Record<string, unknown> };
      expect(data.task.bounty_amount).toBeNull();
      expect(data.task.payment_status).toBe('none');
    });

    it('verify endpoint works normally without payment (no settlement triggered)', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await submitDeliverable(claimer, taskId);

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/verify`);
      const res = await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(data.status).toBe('verified');
      // No payment fields in response for free tasks
      expect(data.payment_status).toBeUndefined();
      expect(data.payment_tx_hash).toBeUndefined();
    });
  });
});
