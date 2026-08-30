import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  setupTestDb,
  createTestApp,
  createTestAgent,
  signRequest,
} from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import type { TestKeypair } from '../test-helpers.js';
import { resetCertificationProbeForTests } from '../control/certification.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

/**
 * setupTestDb builds the OSS shape (no control-plane tables) — exactly what
 * the certification probe must survive. Tests that need a certified sender
 * graft the proprietary tables on (0023 + 0025, which adds the credential
 * status column) and reset the probe, since an earlier request in the same
 * test may already have memoized "absent".
 */
async function installControlTables(db: SQLiteAdapter): Promise<void> {
  await db.exec(readFileSync(join(MIGRATIONS_DIR, '0023_owner_accounts.sql'), 'utf-8'));
  await db.exec(readFileSync(join(MIGRATIONS_DIR, '0025_owner_recovery.sql'), 'utf-8'));
  resetCertificationProbeForTests();
}

let certSeq = 0;

/** Full certification chain: active owner + active passkey + active delegation. */
async function certifyAgent(db: SQLiteAdapter, agentId: string): Promise<{ ownerId: string; delegationId: string }> {
  const n = ++certSeq;
  const ownerId = `ow_test${n}`;
  await db.run(`INSERT INTO owners (id, status) VALUES (?, 'active')`, ownerId);
  await db.run(
    `INSERT INTO owner_webauthn_credentials (id, owner_id, credential_id, public_key, status)
     VALUES (?, ?, ?, ?, 'active')`,
    `cred_${n}`, ownerId, `credid_${n}`, Buffer.from([1, 2, 3])
  );
  await db.run(
    `INSERT INTO action_assertions (id, owner_id, credential_id, action_type, action_hash, authenticator_data, client_data_json, signature, sequence, prev_hash, entry_hash)
     VALUES (?, ?, ?, 'agent.delegate', 'hash', 'ad', 'cdj', 'sig', 1, 'prev', 'entry')`,
    `assert_${n}`, ownerId, `credid_${n}`
  );
  const delegationId = `del_${n}`;
  await db.run(
    `INSERT INTO delegations (id, owner_id, agent_id, status, authorizing_assertion_id)
     VALUES (?, ?, ?, 'active', ?)`,
    delegationId, ownerId, agentId, `assert_${n}`
  );
  return { ownerId, delegationId };
}

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
    // The probe memoizes per isolate but each test gets a fresh DB — a stale
    // answer from the previous test's DB must not leak forward.
    resetCertificationProbeForTests();
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
        ([url]: string[]) => url === 'https://webhook.example.com/events'
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
        ([url]: string[]) => url === 'https://sender-webhook.example.com/events'
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

  // ─── Inbox: from_certified + after_id keyset (board spec §3/§5, tests §12.2) ───

  describe('GET /v1/agents/:id/messages — from_certified + after_id keyset', () => {
    /** Direct insert so tests control created_at (real sends share one clock tick). */
    async function insertInboxMessage(id: string, fromId: string, toId: string, createdAt: string): Promise<void> {
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      await db.run(
        `INSERT INTO messages (id, from_agent_id, to_agent_id, type, subject, body, status, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, 'message', 'S', 'body', 'pending', ?, ?, ?)`,
        id, fromId, toId, createdAt, createdAt, expiresAt
      );
    }

    /** Signed inbox GET as `recipient` (auth signs the pathname only, so query is free-form). */
    async function getInbox(queryString = ''): Promise<{ status: number; data: { ok?: boolean; messages?: Array<Record<string, unknown>>; error?: string } }> {
      const path = `/v1/agents/${recipient.agentId}/messages`;
      const headers = await signRequest(recipient, 'GET', path);
      const res = await app.request(`${path}${queryString}`, { method: 'GET', headers: { ...headers } });
      return { status: res.status, data: await res.json() as Record<string, unknown> };
    }

    it('from_certified is false on an OSS-shaped DB (no control tables, no throw)', async () => {
      await insertInboxMessage('msg_oss1', sender.agentId, recipient.agentId, new Date().toISOString());

      const { status, data } = await getInbox();
      expect(status).toBe(200);
      expect(data.messages!.length).toBe(1);
      expect(data.messages![0].from_certified).toBe(false);
    });

    it('from_certified flips live with the sender delegation', async () => {
      await insertInboxMessage('msg_cert1', sender.agentId, recipient.agentId, new Date().toISOString());
      await installControlTables(db);
      const { delegationId } = await certifyAgent(db, sender.agentId);

      let inbox = await getInbox();
      expect(inbox.data.messages![0].from_certified).toBe(true);

      // Live JOIN, never a snapshot: revoking the delegation de-badges the
      // very next read — no probe reset, no cache to expire.
      await db.run(`UPDATE delegations SET status = 'revoked' WHERE id = ?`, delegationId);
      inbox = await getInbox();
      expect(inbox.data.messages![0].from_certified).toBe(false);
    });

    it('after_id returns strictly-after messages, oldest first', async () => {
      await insertInboxMessage('msg_k1', sender.agentId, recipient.agentId, '2026-01-01T00:00:01.000Z');
      await insertInboxMessage('msg_k2', sender.agentId, recipient.agentId, '2026-01-01T00:00:02.000Z');
      await insertInboxMessage('msg_k3', sender.agentId, recipient.agentId, '2026-01-01T00:00:03.000Z');

      const { status, data } = await getInbox('?after_id=msg_k1');
      expect(status).toBe(200);
      expect(data.messages!.map((m) => m.id)).toEqual(['msg_k2', 'msg_k3']);

      // Caught-up poller: strictly-after the newest anchor is empty.
      const tail = await getInbox('?after_id=msg_k3');
      expect(tail.data.messages).toEqual([]);
    });

    it('after_id tiebreaks on id when created_at collides', async () => {
      const ts = '2026-01-01T00:00:05.000Z';
      await insertInboxMessage('msg_ka', sender.agentId, recipient.agentId, ts);
      await insertInboxMessage('msg_kb', sender.agentId, recipient.agentId, ts);

      const { data } = await getInbox('?after_id=msg_ka');
      expect(data.messages!.map((m) => m.id)).toEqual(['msg_kb']);
    });

    it('unknown after_id → 400 (explicit cursor-reset signal, not a silent full refetch)', async () => {
      const { status } = await getInbox('?after_id=msg_never_existed');
      expect(status).toBe(400);
    });

    it("after_id naming another agent's message → 400 (no existence oracle)", async () => {
      // A message the RECIPIENT sent lives in sender's inbox, not recipient's.
      await insertInboxMessage('msg_theirs', recipient.agentId, sender.agentId, new Date().toISOString());
      const { status } = await getInbox('?after_id=msg_theirs');
      expect(status).toBe(400);
    });

    it('without after_id, offset paging stays newest-first (behavior unchanged)', async () => {
      await insertInboxMessage('msg_o1', sender.agentId, recipient.agentId, '2026-01-01T00:00:01.000Z');
      await insertInboxMessage('msg_o2', sender.agentId, recipient.agentId, '2026-01-01T00:00:02.000Z');

      const { data } = await getInbox();
      expect(data.messages!.map((m) => m.id)).toEqual(['msg_o2', 'msg_o1']);
    });
  });

  // ─── Reply subject derivation (board spec §5, tests §12.2) ───

  describe('POST /v1/messages/:id/reply — server-derived subject', () => {
    async function sendMessage(from: TestKeypair, toId: string, subject: string): Promise<string> {
      const body = JSON.stringify({ subject, body: 'Test message' });
      const headers = await signRequest(from, 'POST', `/v1/agents/${toId}/messages`, body);
      const res = await app.request(`/v1/agents/${toId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      const data = await res.json() as { message_id: string };
      return data.message_id;
    }

    async function reply(messageId: string, payload: Record<string, unknown>): Promise<{ status: number; replyId?: string }> {
      const body = JSON.stringify(payload);
      const headers = await signRequest(recipient, 'POST', `/v1/messages/${messageId}/reply`, body);
      const res = await app.request(`/v1/messages/${messageId}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      const data = await res.json() as { message_id?: string };
      return { status: res.status, replyId: data.message_id };
    }

    it('reply without subject no longer 400s — derives "Re: <parent.subject>"', async () => {
      const messageId = await sendMessage(sender, recipient.agentId, 'Hello');

      const { status, replyId } = await reply(messageId, { body: 'Got it!' });
      expect(status).toBe(200);

      const row = await db.get<{ subject: string }>('SELECT subject FROM messages WHERE id = ?', replyId);
      expect(row!.subject).toBe('Re: Hello');
    });

    it('does not stack Re: prefixes on an already-Re: parent', async () => {
      const messageId = await sendMessage(sender, recipient.agentId, 'Re: Hello');

      const { replyId } = await reply(messageId, { body: 'Still on it' });
      const row = await db.get<{ subject: string }>('SELECT subject FROM messages WHERE id = ?', replyId);
      expect(row!.subject).toBe('Re: Hello');
    });

    it('an explicit reply subject wins over derivation', async () => {
      const messageId = await sendMessage(sender, recipient.agentId, 'Hello');

      const { replyId } = await reply(messageId, { subject: 'Different thread', body: 'x' });
      const row = await db.get<{ subject: string }>('SELECT subject FROM messages WHERE id = ?', replyId);
      expect(row!.subject).toBe('Different thread');
    });

    it('derived subject rides the reply webhook to the original sender', async () => {
      const webhookSender = await createTestAgent(db, {
        status: 'active',
        webhookUrl: 'https://sender-webhook.example.com/events',
      });
      const messageId = await sendMessage(webhookSender, recipient.agentId, 'Hello');

      await reply(messageId, { body: 'Reply!' });
      await new Promise(r => setTimeout(r, 10));

      const webhookCalls = mockFetch.mock.calls.filter(
        ([url]: string[]) => url === 'https://sender-webhook.example.com/events'
      );
      expect(webhookCalls.length).toBeGreaterThan(0);
      const webhookBody = JSON.parse(webhookCalls[webhookCalls.length - 1][1].body);
      expect(webhookBody.message.subject).toBe('Re: Hello');
    });

    it('top-level send still requires subject', async () => {
      const body = JSON.stringify({ body: 'No subject here' });
      const headers = await signRequest(sender, 'POST', `/v1/agents/${recipient.agentId}/messages`, body);
      const res = await app.request(`/v1/agents/${recipient.agentId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      expect(res.status).toBe(400);
    });

    it('smuggling reply_to_message_id into a top-level send does not waive subject', async () => {
      const body = JSON.stringify({ body: 'sneaky', reply_to_message_id: 'msg_whatever' });
      const headers = await signRequest(sender, 'POST', `/v1/agents/${recipient.agentId}/messages`, body);
      const res = await app.request(`/v1/agents/${recipient.agentId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      expect(res.status).toBe(400);
    });
  });
});
