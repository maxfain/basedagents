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

describe('A2A Messaging', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;
  let sender: TestKeypair & { name: string };
  let recipient: TestKeypair & { name: string };

  beforeEach(async () => {
    db = setupTestDb();
    app = createTestApp(db);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    sender = await createTestAgent(db, { status: 'active', reputationScore: 0.5 });
    recipient = await createTestAgent(db, { status: 'active', reputationScore: 0.5 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── POST /v1/agents/:id/messages ───

  describe('POST /v1/agents/:id/messages — Send message', () => {
    it('sends a message successfully (no webhook)', async () => {
      const body = JSON.stringify({ subject: 'Hello', body: 'Test message' });
      const headers = await signRequest(sender, 'POST', `/v1/agents/${recipient.agentId}/messages`, body);

      const res = await app.request(`/v1/agents/${recipient.agentId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });

      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(data.message_id).toBeDefined();
      expect(data.status).toBe('pending');
    });

    it('sends a message with webhook delivery', async () => {
      const webhookRecipient = await createTestAgent(db, {
        status: 'active',
        webhookUrl: 'https://webhook.example.com/events',
      });

      const body = JSON.stringify({ subject: 'Hello', body: 'Test message' });
      const headers = await signRequest(sender, 'POST', `/v1/agents/${webhookRecipient.agentId}/messages`, body);

      const res = await app.request(`/v1/agents/${webhookRecipient.agentId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });

      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.status).toBe('delivered');

      // Wait for fire-and-forget webhook
      await new Promise(r => setTimeout(r, 10));

      const webhookCalls = mockFetch.mock.calls.filter(
        ([url]: [string]) => url === 'https://webhook.example.com/events'
      );
      expect(webhookCalls.length).toBe(1);
      const webhookBody = JSON.parse(webhookCalls[0][1].body);
      expect(webhookBody.type).toBe('message.received');
      expect(webhookBody.from.agent_id).toBe(sender.agentId);
    });

    it('send to nonexistent agent → 404', async () => {
      const body = JSON.stringify({ subject: 'Hello', body: 'Test' });
      const headers = await signRequest(sender, 'POST', '/v1/agents/ag_nonexistent/messages', body);

      const res = await app.request('/v1/agents/ag_nonexistent/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });

      expect(res.status).toBe(404);
    });

    it('send to self → 400', async () => {
      const body = JSON.stringify({ subject: 'Hello', body: 'Test' });
      const headers = await signRequest(sender, 'POST', `/v1/agents/${sender.agentId}/messages`, body);

      const res = await app.request(`/v1/agents/${sender.agentId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });

      expect(res.status).toBe(400);
      const data = await res.json() as { error: string };
      expect(data.error).toBe('bad_request');
    });

    it('unauthenticated send → 401', async () => {
      const body = JSON.stringify({ subject: 'Hello', body: 'Test' });

      const res = await app.request(`/v1/agents/${recipient.agentId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      expect(res.status).toBe(401);
    });

    it('sends task_request type', async () => {
      const body = JSON.stringify({ type: 'task_request', subject: 'Task', body: 'Please do this' });
      const headers = await signRequest(sender, 'POST', `/v1/agents/${recipient.agentId}/messages`, body);

      const res = await app.request(`/v1/agents/${recipient.agentId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });

      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.ok).toBe(true);
    });

    it('rate limits at 10 messages per hour', async () => {
      // Send 10 messages (should all succeed)
      for (let i = 0; i < 10; i++) {
        const r = await createTestAgent(db, { status: 'active' });
        const body = JSON.stringify({ subject: `Msg ${i}`, body: 'Test' });
        const headers = await signRequest(sender, 'POST', `/v1/agents/${r.agentId}/messages`, body);

        const res = await app.request(`/v1/agents/${r.agentId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body,
        });
        expect(res.status).toBe(200);
      }

      // 11th should be rate limited
      const body = JSON.stringify({ subject: 'Extra', body: 'Test' });
      const headers = await signRequest(sender, 'POST', `/v1/agents/${recipient.agentId}/messages`, body);

      const res = await app.request(`/v1/agents/${recipient.agentId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });

      expect(res.status).toBe(429);
    });
  });

  // ─── POST /v1/messages/:id/reply ───

  describe('POST /v1/messages/:id/reply — Reply to message', () => {
    async function sendMessage(from: TestKeypair, toId: string): Promise<string> {
      const body = JSON.stringify({ subject: 'Hello', body: 'Test message' });
      const headers = await signRequest(from, 'POST', `/v1/agents/${toId}/messages`, body);
      const res = await app.request(`/v1/agents/${toId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      const data = await res.json() as { message_id: string };
      return data.message_id;
    }

    it('recipient can reply to a message', async () => {
      const messageId = await sendMessage(sender, recipient.agentId);

      const replyBody = JSON.stringify({ subject: 'Re: Hello', body: 'Got it!' });
      const headers = await signRequest(recipient, 'POST', `/v1/messages/${messageId}/reply`, replyBody);

      const res = await app.request(`/v1/messages/${messageId}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: replyBody,
      });

      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(data.message_id).toBeDefined();

      // Original message status should be 'replied'
      const original = await db.get<{ status: string }>('SELECT status FROM messages WHERE id = ?', messageId);
      expect(original!.status).toBe('replied');
    });

    it('non-recipient cannot reply → 403', async () => {
      const messageId = await sendMessage(sender, recipient.agentId);
      const thirdParty = await createTestAgent(db, { status: 'active' });

      const replyBody = JSON.stringify({ subject: 'Re: Hello', body: 'Intercepted!' });
      const headers = await signRequest(thirdParty, 'POST', `/v1/messages/${messageId}/reply`, replyBody);

      const res = await app.request(`/v1/messages/${messageId}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: replyBody,
      });

      expect(res.status).toBe(403);
    });

    it('reply to nonexistent message → 404', async () => {
      const replyBody = JSON.stringify({ subject: 'Re: Hello', body: 'Reply' });
      const headers = await signRequest(recipient, 'POST', '/v1/messages/msg_nonexistent/reply', replyBody);

      const res = await app.request('/v1/messages/msg_nonexistent/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: replyBody,
      });

      expect(res.status).toBe(404);
    });

    it('reply delivers webhook to original sender', async () => {
      const webhookSender = await createTestAgent(db, {
        status: 'active',
        webhookUrl: 'https://sender-webhook.example.com/events',
      });

      const messageId = await sendMessage(webhookSender, recipient.agentId);

      const replyBody = JSON.stringify({ subject: 'Re: Hello', body: 'Reply!' });
      const headers = await signRequest(recipient, 'POST', `/v1/messages/${messageId}/reply`, replyBody);

      await app.request(`/v1/messages/${messageId}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: replyBody,
      });

      await new Promise(r => setTimeout(r, 10));

      const webhookCalls = mockFetch.mock.calls.filter(
        ([url]: [string]) => url === 'https://sender-webhook.example.com/events'
      );
      expect(webhookCalls.length).toBeGreaterThan(0);
      const webhookBody = JSON.parse(webhookCalls[webhookCalls.length - 1][1].body);
      expect(webhookBody.type).toBe('message.reply');
      expect(webhookBody.reply_to_message_id).toBe(messageId);
    });
  });

  // ─── GET /v1/agents/:id/messages ───

  describe('GET /v1/agents/:id/messages — Inbox', () => {
    it('returns received messages', async () => {
      // Send a message to recipient
      const body = JSON.stringify({ subject: 'Hello', body: 'Test' });
      const sendHeaders = await signRequest(sender, 'POST', `/v1/agents/${recipient.agentId}/messages`, body);
      await app.request(`/v1/agents/${recipient.agentId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...sendHeaders },
        body,
      });

      // Get recipient's inbox
      const getHeaders = await signRequest(recipient, 'GET', `/v1/agents/${recipient.agentId}/messages`);
      const res = await app.request(`/v1/agents/${recipient.agentId}/messages`, {
        method: 'GET',
        headers: { ...getHeaders },
      });

      expect(res.status).toBe(200);
      const data = await res.json() as { ok: boolean; messages: unknown[] };
      expect(data.ok).toBe(true);
      expect(data.messages.length).toBe(1);
    });

    it('only authenticated agent can read their inbox', async () => {
      // Sender tries to read recipient's inbox
      const getHeaders = await signRequest(sender, 'GET', `/v1/agents/${recipient.agentId}/messages`);
      const res = await app.request(`/v1/agents/${recipient.agentId}/messages`, {
        method: 'GET',
        headers: { ...getHeaders },
      });

      expect(res.status).toBe(403);
    });

    it('does not return expired messages', async () => {
      // Insert an expired message directly
      const now = new Date();
      const expiredAt = new Date(now.getTime() - 1000).toISOString();
      await db.run(
        `INSERT INTO messages (id, from_agent_id, to_agent_id, type, subject, body, status, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'msg_expired123', sender.agentId, recipient.agentId, 'message',
        'Old', 'Expired', 'pending', now.toISOString(), now.toISOString(), expiredAt
      );

      const getHeaders = await signRequest(recipient, 'GET', `/v1/agents/${recipient.agentId}/messages`);
      const res = await app.request(`/v1/agents/${recipient.agentId}/messages`, {
        method: 'GET',
        headers: { ...getHeaders },
      });

      const data = await res.json() as { messages: unknown[] };
      expect(data.messages.length).toBe(0);
    });
  });

  // ─── GET /v1/agents/:id/messages/sent ───

  describe('GET /v1/agents/:id/messages/sent — Sent messages', () => {
    it('returns sent messages', async () => {
      const body = JSON.stringify({ subject: 'Hello', body: 'Test' });
      const sendHeaders = await signRequest(sender, 'POST', `/v1/agents/${recipient.agentId}/messages`, body);
      await app.request(`/v1/agents/${recipient.agentId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...sendHeaders },
        body,
      });

      const getHeaders = await signRequest(sender, 'GET', `/v1/agents/${sender.agentId}/messages/sent`);
      const res = await app.request(`/v1/agents/${sender.agentId}/messages/sent`, {
        method: 'GET',
        headers: { ...getHeaders },
      });

      expect(res.status).toBe(200);
      const data = await res.json() as { ok: boolean; messages: unknown[] };
      expect(data.ok).toBe(true);
      expect(data.messages.length).toBe(1);
    });

    it('only authenticated agent can read their sent messages', async () => {
      const getHeaders = await signRequest(recipient, 'GET', `/v1/agents/${sender.agentId}/messages/sent`);
      const res = await app.request(`/v1/agents/${sender.agentId}/messages/sent`, {
        method: 'GET',
        headers: { ...getHeaders },
      });

      expect(res.status).toBe(403);
    });
  });

  // ─── GET /v1/messages/:id ───

  describe('GET /v1/messages/:id — Get single message', () => {
    async function sendAndGetId(): Promise<string> {
      const body = JSON.stringify({ subject: 'Hello', body: 'Test' });
      const headers = await signRequest(sender, 'POST', `/v1/agents/${recipient.agentId}/messages`, body);
      const res = await app.request(`/v1/agents/${recipient.agentId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      const data = await res.json() as { message_id: string };
      return data.message_id;
    }

    it('sender can view the message', async () => {
      const messageId = await sendAndGetId();

      const headers = await signRequest(sender, 'GET', `/v1/messages/${messageId}`);
      const res = await app.request(`/v1/messages/${messageId}`, {
        method: 'GET',
        headers: { ...headers },
      });

      expect(res.status).toBe(200);
      const data = await res.json() as { ok: boolean; message: Record<string, unknown> };
      expect(data.ok).toBe(true);
      expect(data.message.id).toBe(messageId);
    });

    it('recipient viewing updates status to read', async () => {
      // Create recipient with webhook so message is 'delivered'
      const webhookRecipient = await createTestAgent(db, {
        status: 'active',
        webhookUrl: 'https://test.example.com',
      });

      const body = JSON.stringify({ subject: 'Hello', body: 'Test' });
      const sendHeaders = await signRequest(sender, 'POST', `/v1/agents/${webhookRecipient.agentId}/messages`, body);
      const sendRes = await app.request(`/v1/agents/${webhookRecipient.agentId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...sendHeaders },
        body,
      });
      const sendData = await sendRes.json() as { message_id: string; status: string };
      expect(sendData.status).toBe('delivered');

      // Recipient views the message
      const headers = await signRequest(webhookRecipient, 'GET', `/v1/messages/${sendData.message_id}`);
      const res = await app.request(`/v1/messages/${sendData.message_id}`, {
        method: 'GET',
        headers: { ...headers },
      });

      expect(res.status).toBe(200);
      const data = await res.json() as { message: { status: string } };
      expect(data.message.status).toBe('read');
    });

    it('third party cannot view message → 403', async () => {
      const messageId = await sendAndGetId();
      const thirdParty = await createTestAgent(db, { status: 'active' });

      const headers = await signRequest(thirdParty, 'GET', `/v1/messages/${messageId}`);
      const res = await app.request(`/v1/messages/${messageId}`, {
        method: 'GET',
        headers: { ...headers },
      });

      expect(res.status).toBe(403);
    });

    it('nonexistent message → 404', async () => {
      const headers = await signRequest(sender, 'GET', '/v1/messages/msg_nonexistent');
      const res = await app.request('/v1/messages/msg_nonexistent', {
        method: 'GET',
        headers: { ...headers },
      });

      expect(res.status).toBe(404);
    });
  });
});
