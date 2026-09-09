import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setupTestDb, createTestApp, createTestAgent, signRequest, type TestKeypair } from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import { recordEvent, drainOutbox } from '../events/service.js';
import { claimGate } from '../tasks/service.js';
import type { WebhookEvent } from '../lib/webhooks.js';

let db: SQLiteAdapter;
let app: ReturnType<typeof createTestApp>;

const NOW = '2026-09-08T12:00:00.000Z';

function taskAvailable(agentId: string): WebhookEvent {
  return {
    type: 'task.available', agent_id: agentId,
    task: { task_id: 'task_x', title: 'T', description: 'D', category: 'code', required_capabilities: ['code'], output_format: 'json', bounty: null },
  };
}

async function seedOpenTask(creatorId: string): Promise<string> {
  const taskId = 'task_seed1';
  await db.run(
    `INSERT INTO tasks (task_id, creator_agent_id, creator_kind, title, description, status, created_at)
     VALUES (?, ?, 'agent', 'Seed', 'Seed task', 'open', ?)`,
    taskId, creatorId, NOW,
  );
  return taskId;
}

async function getEvents(kp: TestKeypair, query = ''): Promise<{ status: number; body: Record<string, unknown> }> {
  // AgentSig signs the pathname only (auth verifies new URL(...).pathname), so
  // sign the base path and append the query to the request URL.
  const path = `/v1/agents/${kp.agentId}/events`;
  const headers = await signRequest(kp, 'GET', path);
  const res = await app.request(path + query, { method: 'GET', headers });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('Agent Inbox (agent_events)', () => {
  beforeEach(() => {
    db = setupTestDb();
    app = createTestApp(db);
  });

  describe('GET /v1/agents/:id/events — auth', () => {
    it('rejects reading another agent inbox with 403', async () => {
      const a = await createTestAgent(db, { status: 'active' });
      const b = await createTestAgent(db, { status: 'active' });
      const path = `/v1/agents/${a.agentId}/events`;
      const headers = await signRequest(b, 'GET', path); // b signs for a's inbox
      const res = await app.request(path, { method: 'GET', headers });
      expect(res.status).toBe(403);
    });
  });

  describe('pull', () => {
    it('returns persisted events newest-first with a parsed payload', async () => {
      const a = await createTestAgent(db, { status: 'active' });
      await recordEvent(db, a.agentId, taskAvailable(a.agentId), NOW);
      await recordEvent(db, a.agentId, { type: 'task.claimed', agent_id: a.agentId, task_id: 'task_x', claimed_by: { agent_id: 'ag_z', name: 'Z' } }, NOW);

      const { status, body } = await getEvents(a);
      expect(status).toBe(200);
      const events = body.events as Array<Record<string, unknown>>;
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('task.claimed'); // newest first
      expect((events[0].payload as Record<string, unknown>).type).toBe('task.claimed');
      expect(body.unread_count).toBe(2);
      expect(body.next_cursor).toBeTruthy();
    });

    it('after=<cursor> returns only newer events (poll loop)', async () => {
      const a = await createTestAgent(db, { status: 'active' });
      await recordEvent(db, a.agentId, taskAvailable(a.agentId), NOW);
      const first = await getEvents(a);
      const cursor = first.body.next_cursor as string;

      // Nothing new yet
      const empty = await getEvents(a, `?after=${encodeURIComponent(cursor)}`);
      expect((empty.body.events as unknown[]).length).toBe(0);

      // A new event arrives
      await recordEvent(db, a.agentId, { type: 'task.claimed', agent_id: a.agentId, task_id: 'task_y', claimed_by: { agent_id: 'ag_z', name: 'Z' } }, NOW);
      const next = await getEvents(a, `?after=${encodeURIComponent(cursor)}`);
      const rows = next.body.events as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('task.claimed');
    });

    it('rejects a forged cursor with 400', async () => {
      const a = await createTestAgent(db, { status: 'active' });
      const { status } = await getEvents(a, '?after=not-a-cursor!!');
      expect(status).toBe(400);
    });
  });

  describe('read-state', () => {
    it('marks events read up to a cursor and drops the unread count', async () => {
      const a = await createTestAgent(db, { status: 'active' });
      await recordEvent(db, a.agentId, taskAvailable(a.agentId), NOW);
      await recordEvent(db, a.agentId, taskAvailable(a.agentId), NOW);
      const page = await getEvents(a);
      expect(page.body.unread_count).toBe(2);

      const path = `/v1/agents/${a.agentId}/events/read`;
      const body = JSON.stringify({ up_to_cursor: page.body.next_cursor });
      const headers = await signRequest(a, 'POST', path, body);
      const res = await app.request(path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body });
      expect(res.status).toBe(200);
      expect((await res.json() as { marked: number }).marked).toBe(2);

      const after = await getEvents(a);
      expect(after.body.unread_count).toBe(0);
    });
  });

  describe('transactional outbox — gateWithEvent', () => {
    it('writes the event iff the gate wins (atomic)', async () => {
      const creator = await createTestAgent(db, { status: 'active' });
      const claimer = await createTestAgent(db, { status: 'active' });
      const taskId = await seedOpenTask(creator.agentId);

      const evt: WebhookEvent = { type: 'task.claimed', agent_id: creator.agentId, task_id: taskId, claimed_by: { agent_id: claimer.agentId, name: 'C' } };

      const won = await claimGate(db, taskId, claimer.agentId, null, NOW, { recipientAgentId: creator.agentId, event: evt });
      expect(won).toBe(true);
      const one = await getEvents(creator);
      expect((one.body.events as unknown[]).length).toBe(1);

      // Second claim loses the race (task no longer open) → NO duplicate event.
      const wonAgain = await claimGate(db, taskId, claimer.agentId, null, NOW, { recipientAgentId: creator.agentId, event: evt });
      expect(wonAgain).toBe(false);
      const still = await getEvents(creator);
      expect((still.body.events as unknown[]).length).toBe(1);
    });
  });

  describe('fan-out matches webhook-less agents (the bug fix)', () => {
    it('a matching agent with NO webhook_url still gets task.available in its inbox', async () => {
      // Poster and a would-be deliverer that has NO webhook_url.
      const poster = await createTestAgent(db, { status: 'active', capabilities: ['research'] });
      const worker = await createTestAgent(db, { status: 'active', capabilities: ['code'], webhookUrl: null });

      const path = '/v1/tasks';
      const body = JSON.stringify({ title: 'Add CI', description: 'Add a CI workflow', category: 'automation', required_capabilities: ['code'], output_format: 'link' });
      const headers = await signRequest(poster, 'POST', path, body);
      const res = await app.request(path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body });
      expect(res.status).toBe(200);

      const inbox = await getEvents(worker);
      const rows = inbox.body.events as Array<Record<string, unknown>>;
      expect(rows.some((e) => e.type === 'task.available')).toBe(true);
    });
  });

  describe('outbox drainer', () => {
    let mockFetch: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', mockFetch);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('pushes to a recipient with a webhook_url (HMAC-signed) and marks it sent', async () => {
      const a = await createTestAgent(db, { status: 'active', webhookUrl: 'https://a.example.com/hook' });
      await db.run('UPDATE agents SET webhook_secret = ? WHERE id = ?', 'test-secret', a.agentId);
      await recordEvent(db, a.agentId, taskAvailable(a.agentId), NOW);

      const stats = await drainOutbox(db, NOW);
      expect(stats.sent).toBe(1);
      const call = mockFetch.mock.calls[0];
      expect(call[0]).toBe('https://a.example.com/hook');
      expect(call[1].headers['X-BasedAgents-Signature']).toMatch(/^sha256=/);

      // Idempotent: a second drain sends nothing (row is 'sent').
      const again = await drainOutbox(db, NOW);
      expect(again.sent).toBe(0);
    });

    it('skips a recipient with no webhook_url (pull-only) without calling fetch', async () => {
      const a = await createTestAgent(db, { status: 'active', webhookUrl: null });
      await recordEvent(db, a.agentId, taskAvailable(a.agentId), NOW);

      const stats = await drainOutbox(db, NOW);
      expect(stats.skipped).toBe(1);
      expect(stats.sent).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
