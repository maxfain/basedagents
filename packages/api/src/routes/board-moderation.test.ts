/**
 * Board moderation + delivery tests (board spec §5 report row, §7.2/§7.3, §9;
 * test plan §12.4): report recording with report-time owner attribution, the
 * 3-distinct-owners auto-hold (sybil-agent-proof), held visibility (hidden
 * from list/feed/public GET, visible to the author), the board.reply webhook
 * (HMAC, unsafe-URL skip), and the Atom feed (envelope, escaping, exclusions,
 * cache header).
 *
 * setupTestDb builds the OSS shape (no control-plane tables); tests that need
 * certification graft 0023 + 0025 on and reset the probe, exactly like
 * board.test.ts / messages.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { sha256, bytesToHex } from '../crypto/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

function bodyHash(body: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(body)));
}

type Json = Record<string, unknown>;

const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

describe('Board moderation + delivery', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;
  let agent: TestKeypair & { name: string };

  /** Graft the proprietary tables (0023 + 0025 adds credential status) onto the OSS DB. */
  async function installControlTables(): Promise<void> {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, '0023_owner_accounts.sql'), 'utf-8'));
    await db.exec(readFileSync(join(MIGRATIONS_DIR, '0025_owner_recovery.sql'), 'utf-8'));
    resetCertificationProbeForTests();
  }

  let certSeq = 0;

  /** Active owner + one active passkey. */
  async function createOwner(): Promise<string> {
    const n = ++certSeq;
    const ownerId = `ow_test${n}`;
    await db.run(`INSERT INTO owners (id, status) VALUES (?, 'active')`, ownerId);
    await db.run(
      `INSERT INTO owner_webauthn_credentials (id, owner_id, credential_id, public_key, status)
       VALUES (?, ?, ?, ?, 'active')`,
      `cred_${n}`, ownerId, `credid_${n}`, Buffer.from([1, 2, 3])
    );
    return ownerId;
  }

  /** Active delegation from an existing owner — completes the cert chain. */
  async function delegate(ownerId: string, agentId: string): Promise<string> {
    const n = ++certSeq;
    await db.run(
      `INSERT INTO action_assertions (id, owner_id, credential_id, action_type, action_hash, authenticator_data, client_data_json, signature, sequence, prev_hash, entry_hash)
       VALUES (?, ?, ?, 'agent.delegate', 'hash', 'ad', 'cdj', 'sig', ?, 'prev', 'entry')`,
      `assert_${n}`, ownerId, `credid_x${n}`, n
    );
    const delegationId = `del_${n}`;
    await db.run(
      `INSERT INTO delegations (id, owner_id, agent_id, status, authorizing_assertion_id)
       VALUES (?, ?, ?, 'active', ?)`,
      delegationId, ownerId, agentId, `assert_${n}`
    );
    return delegationId;
  }

  /** A certified reporter: fresh agent + fresh owner, delegated. */
  async function certifiedReporter(): Promise<{ kp: TestKeypair & { name: string }; ownerId: string; delegationId: string }> {
    const kp = await createTestAgent(db, { status: 'active' });
    const ownerId = await createOwner();
    const delegationId = await delegate(ownerId, kp.agentId);
    return { kp, ownerId, delegationId };
  }

  async function post(kp: TestKeypair, payload: Json): Promise<{ status: number; data: Json }> {
    const body = JSON.stringify(payload);
    const headers = await signRequest(kp, 'POST', '/v1/board/posts', body);
    const res = await app.request('/v1/board/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    return { status: res.status, data: await res.json() as Json };
  }

  async function report(kp: TestKeypair, postId: string): Promise<{ status: number; data: Json }> {
    const path = `/v1/board/posts/${postId}/report`;
    const headers = await signRequest(kp, 'POST', path);
    const res = await app.request(path, { method: 'POST', headers: { ...headers } });
    return { status: res.status, data: await res.json() as Json };
  }

  /** Direct insert — controlled status/created_at without burning write tiers. */
  async function insertPost(
    id: string,
    authorAgentId: string,
    opts: { body?: string; replyTo?: string; threadRoot?: string; createdAt?: string; status?: string; deletedAt?: string } = {}
  ): Promise<void> {
    const body = opts.body ?? `body of ${id}`;
    await db.run(
      `INSERT INTO board_posts (id, author_agent_id, author_owner_id, author_kind, body, body_sha256, reply_to_post_id, thread_root_id, status, created_at, deleted_at)
       VALUES (?, ?, NULL, 'agent', ?, ?, ?, ?, ?, ?, ?)`,
      id, authorAgentId, body, bodyHash(body),
      opts.replyTo ?? null, opts.threadRoot ?? id,
      opts.status ?? 'visible', opts.createdAt ?? new Date().toISOString(),
      opts.deletedAt ?? null
    );
  }

  async function postStatus(id: string): Promise<string> {
    const row = await db.get<{ status: string }>('SELECT status FROM board_posts WHERE id = ?', id);
    return row!.status;
  }

  async function fetchFeed(): Promise<{ status: number; headers: Headers; xml: string }> {
    const res = await app.request('/v1/board/feed.atom');
    return { status: res.status, headers: res.headers, xml: await res.text() };
  }

  beforeEach(async () => {
    db = setupTestDb();
    app = createTestApp(db);
    // The probe memoizes per isolate; a stale answer from the previous test's
    // DB must not leak forward.
    resetCertificationProbeForTests();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);
    agent = await createTestAgent(db, { status: 'active' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── POST /v1/board/posts/:id/report ───

  describe('POST /v1/board/posts/:id/report', () => {
    it('records the report with the owner resolved AT REPORT TIME; uncertified rows carry NULL', async () => {
      await installControlTables();
      await insertPost('post_target1', agent.agentId);

      const { kp: certified, ownerId } = await certifiedReporter();
      expect((await report(certified, 'post_target1')).status).toBe(200);

      const uncert = await createTestAgent(db, { status: 'active' });
      expect((await report(uncert, 'post_target1')).status).toBe(200);

      const rows = await db.all<{ reporter_agent_id: string; reporter_owner_id: string | null }>(
        'SELECT reporter_agent_id, reporter_owner_id FROM board_reports WHERE post_id = ?', 'post_target1'
      );
      expect(rows.length).toBe(2);
      expect(rows.find((r) => r.reporter_agent_id === certified.agentId)!.reporter_owner_id).toBe(ownerId);
      expect(rows.find((r) => r.reporter_agent_id === uncert.agentId)!.reporter_owner_id).toBeNull();

      const counted = await db.get<{ report_count: number }>(
        'SELECT report_count FROM board_posts WHERE id = ?', 'post_target1'
      );
      expect(counted!.report_count).toBe(2);
    });

    it('duplicate report is idempotent: one row, one count bump, no extra budget burn', async () => {
      await insertPost('post_dup1', agent.agentId);
      const reporter = await createTestAgent(db, { status: 'active' });

      expect((await report(reporter, 'post_dup1')).status).toBe(200);
      expect((await report(reporter, 'post_dup1')).status).toBe(200);

      const rows = await db.all('SELECT 1 FROM board_reports WHERE post_id = ?', 'post_dup1');
      expect(rows.length).toBe(1);
      const counted = await db.get<{ report_count: number }>(
        'SELECT report_count FROM board_posts WHERE id = ?', 'post_dup1'
      );
      expect(counted!.report_count).toBe(1);
      // The retry consumed no rate budget — only the first report logged.
      const budget = await db.all(
        'SELECT 1 FROM rate_limit_log WHERE key = ?', `board:report:${reporter.agentId}`
      );
      expect(budget.length).toBe(1);
    });

    it('unknown, held, and deleted posts 404 alike (no status oracle)', async () => {
      const reporter = await createTestAgent(db, { status: 'active' });
      expect((await report(reporter, 'post_missing')).status).toBe(404);

      await insertPost('post_heldr', agent.agentId, { status: 'held' });
      expect((await report(reporter, 'post_heldr')).status).toBe(404);

      await insertPost('post_delr', agent.agentId, { deletedAt: new Date().toISOString() });
      expect((await report(reporter, 'post_delr')).status).toBe(404);
    });

    it('suspended reporter → 403', async () => {
      await insertPost('post_susp1', agent.agentId);
      const suspended = await createTestAgent(db, { status: 'suspended' });
      expect((await report(suspended, 'post_susp1')).status).toBe(403);
    });

    it('3 uncertified reports are recorded but never hold', async () => {
      await insertPost('post_uncert3', agent.agentId);
      for (let i = 0; i < 3; i++) {
        const reporter = await createTestAgent(db, { status: 'active' });
        expect((await report(reporter, 'post_uncert3')).status).toBe(200);
      }
      expect(await postStatus('post_uncert3')).toBe('visible');
      const rows = await db.all('SELECT 1 FROM board_reports WHERE post_id = ?', 'post_uncert3');
      expect(rows.length).toBe(3);
    });

    it('3 sybil agents of ONE owner do not hold — owners are counted, not agents', async () => {
      await installControlTables();
      await insertPost('post_sybil1', agent.agentId);

      const ownerId = await createOwner();
      for (let i = 0; i < 3; i++) {
        const sybil = await createTestAgent(db, { status: 'active' });
        await delegate(ownerId, sybil.agentId);
        expect((await report(sybil, 'post_sybil1')).status).toBe(200);
      }
      expect(await postStatus('post_sybil1')).toBe('visible');
    });

    it('3 DISTINCT owners hold the post: hidden from list/feed/public GET, visible to its author', async () => {
      await installControlTables();
      await insertPost('post_bad1', agent.agentId);

      const r1 = await certifiedReporter();
      const r2 = await certifiedReporter();
      await report(r1.kp, 'post_bad1');
      await report(r2.kp, 'post_bad1');
      // Two distinct owners: still one short of the threshold.
      expect(await postStatus('post_bad1')).toBe('visible');

      const r3 = await certifiedReporter();
      await report(r3.kp, 'post_bad1');
      expect(await postStatus('post_bad1')).toBe('held');

      // Hidden from the public list…
      const list = await app.request('/v1/board/posts');
      expect(((await list.json() as { posts: Json[] }).posts)).toEqual([]);
      // …from the feed…
      expect((await fetchFeed()).xml).not.toContain('post_bad1');
      // …and from the anonymous single-post read (404, same as nonexistent)…
      expect((await app.request('/v1/board/posts/post_bad1')).status).toBe(404);
      // …and from OTHER authenticated agents…
      const stranger = await createTestAgent(db, { status: 'active' });
      const sHeaders = await signRequest(stranger, 'GET', '/v1/board/posts/post_bad1');
      expect((await app.request('/v1/board/posts/post_bad1', { headers: { ...sHeaders } })).status).toBe(404);

      // …but the AUTHOR still sees it, with the status that explains why it
      // vanished from every list.
      const aHeaders = await signRequest(agent, 'GET', '/v1/board/posts/post_bad1');
      const mine = await app.request('/v1/board/posts/post_bad1', { headers: { ...aHeaders } });
      expect(mine.status).toBe(200);
      const data = await mine.json() as { post: Json; thread: Json[] };
      expect(data.post.id).toBe('post_bad1');
      expect(data.post.status).toBe('held');
      expect(data.thread.map((p) => p.id)).toEqual(['post_bad1']);
    });

    it('owner attribution survives later revocation — stored at report time, not recounted live', async () => {
      await installControlTables();
      await insertPost('post_rev1', agent.agentId);

      const r1 = await certifiedReporter();
      const r2 = await certifiedReporter();
      await report(r1.kp, 'post_rev1');
      await report(r2.kp, 'post_rev1');

      // r1's delegation dies AFTER their report; the stored owner still counts.
      await db.run(`UPDATE delegations SET status = 'revoked' WHERE id = ?`, r1.delegationId);

      const r3 = await certifiedReporter();
      await report(r3.kp, 'post_rev1');
      expect(await postStatus('post_rev1')).toBe('held');
    });

    it('11th report inside the hour → 429, nothing recorded', async () => {
      await insertPost('post_rl1', agent.agentId);
      const reporter = await createTestAgent(db, { status: 'active' });
      const now = new Date().toISOString();
      for (let i = 0; i < 10; i++) {
        await db.run(
          'INSERT INTO rate_limit_log (id, key, created_at) VALUES (?, ?, ?)',
          crypto.randomUUID(), `board:report:${reporter.agentId}`, now
        );
      }
      const { status, data } = await report(reporter, 'post_rl1');
      expect(status).toBe(429);
      expect(data.error).toBe('rate_limited');
      const rows = await db.all('SELECT 1 FROM board_reports WHERE post_id = ?', 'post_rl1');
      expect(rows.length).toBe(0);
    });
  });

  // ─── board.reply webhook ───

  describe('board.reply webhook', () => {
    it('fires to the parent author with HMAC signature and the full reply payload', async () => {
      const parentAuthor = await createTestAgent(db, {
        status: 'active',
        webhookUrl: 'https://hooks.example.com/board',
      });
      await db.run('UPDATE agents SET webhook_secret = ? WHERE id = ?', 'whsec_test', parentAuthor.agentId);
      await insertPost('post_root_wh', parentAuthor.agentId);

      const { status, data } = await post(agent, { body: 'a reply worth waking up for', reply_to_post_id: 'post_root_wh' });
      expect(status).toBe(200);

      // Fire-and-forget — give the un-awaited promise a tick to run.
      await new Promise((r) => setTimeout(r, 10));

      const calls = mockFetch.mock.calls.filter(([url]: string[]) => url === 'https://hooks.example.com/board');
      expect(calls.length).toBe(1);
      const [, opts] = calls[0];
      expect(opts.headers['X-BasedAgents-Event']).toBe('board.reply');
      expect(opts.headers['X-BasedAgents-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);

      const payload = JSON.parse(opts.body);
      expect(payload.type).toBe('board.reply');
      expect(payload.agent_id).toBe(parentAuthor.agentId);
      expect(payload.from).toEqual({ agent_id: agent.agentId, name: agent.name });
      expect(payload.post.id).toBe(data.post_id);
      expect(payload.post.body).toBe('a reply worth waking up for');
      expect(payload.post.thread_root_id).toBe('post_root_wh');
      expect(payload.reply_to_post_id).toBe('post_root_wh');
      expect(payload.thread_url).toBe('https://basedagents.ai/board/post_root_wh');
    });

    it('root posts and self-replies fire nothing', async () => {
      const author = await createTestAgent(db, {
        status: 'active',
        webhookUrl: 'https://hooks.example.com/self',
      });
      const root = await post(author, { body: 'talking to the void' });
      expect(root.status).toBe(200);
      const self = await post(author, { body: 'still just me', reply_to_post_id: root.data.post_id as string });
      expect(self.status).toBe(200);

      await new Promise((r) => setTimeout(r, 10));
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('unsafe webhook URL is skipped at fire time (SSRF re-check)', async () => {
      const parentAuthor = await createTestAgent(db, { status: 'active' });
      // Mutated out of band past registration-time validation — exactly the
      // row shape the fire-time isSafeUrl re-check exists for.
      await db.run(
        'UPDATE agents SET webhook_url = ? WHERE id = ?',
        'https://169.254.169.254/latest/meta-data', parentAuthor.agentId
      );
      await insertPost('post_root_ssrf', parentAuthor.agentId);

      expect((await post(agent, { body: 'reply', reply_to_post_id: 'post_root_ssrf' })).status).toBe(200);
      await new Promise((r) => setTimeout(r, 10));
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ─── GET /v1/board/feed.atom ───

  describe('GET /v1/board/feed.atom', () => {
    it('serves an Atom envelope with tag: entry ids, cache header, and newest-first order', async () => {
      await insertPost('post_feed_old', agent.agentId, { createdAt: '2026-08-29T00:00:00.000Z' });
      await insertPost('post_feed_new', agent.agentId, { createdAt: '2026-08-30T00:00:00.000Z' });

      const { status, headers, xml } = await fetchFeed();
      expect(status).toBe(200);
      expect(headers.get('Cache-Control')).toBe('public, max-age=60');
      expect(headers.get('Content-Type')).toContain('application/atom+xml');

      expect(xml).toContain('<?xml version="1.0" encoding="utf-8"?>');
      expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
      expect(xml).toContain('<id>tag:basedagents.ai,2026:post/post_feed_old</id>');
      expect(xml).toContain('<id>tag:basedagents.ai,2026:post/post_feed_new</id>');
      // Feed-level updated = newest entry; entries run newest-first.
      expect(xml).toContain('<updated>2026-08-30T00:00:00.000Z</updated>');
      expect(xml.indexOf('post_feed_new')).toBeLessThan(xml.indexOf('post_feed_old'));
      // Author line carries name + truncated id (spec §4's "every surface").
      expect(xml).toContain(`${agent.name} (${agent.agentId.slice(0, 12)}…)`);
    });

    it('escapes bodies and strips XML-illegal control characters', async () => {
      // BEL (0x07) is legal in a JS string and in SQLite, but ILLEGAL in XML
      // 1.0 even entity-encoded — it must vanish from the feed entirely.
      const bell = String.fromCharCode(7);
      await insertPost('post_xss1', agent.agentId, {
        body: `<script>alert("x")</script> & 'more'${bell}end`,
      });
      const { xml } = await fetchFeed();
      expect(xml).not.toContain('<script>');
      expect(xml).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;more&#39;end');
      expect(xml).not.toContain(bell);
    });

    it('caps at the 50 newest visible posts', async () => {
      // Feed order rides the seq spine (insert order), not created_at.
      for (let i = 1; i <= 52; i++) {
        await insertPost(`post_cap${i}`, agent.agentId);
      }
      const { xml } = await fetchFeed();
      expect((xml.match(/<entry>/g) ?? []).length).toBe(50);
      // seq order: the two OLDEST fall off the end.
      expect(xml).not.toContain('post/post_cap1<');
      expect(xml).not.toContain('post/post_cap2<');
      expect(xml).toContain('post/post_cap52<');
    });

    it('excludes held, removed, and author-deleted posts', async () => {
      await insertPost('post_fvis', agent.agentId);
      await insertPost('post_fheld', agent.agentId, { status: 'held' });
      await insertPost('post_frmv', agent.agentId, { status: 'removed' });
      await insertPost('post_fdel', agent.agentId, { deletedAt: new Date().toISOString() });

      const { xml } = await fetchFeed();
      expect(xml).toContain('post_fvis');
      expect(xml).not.toContain('post_fheld');
      expect(xml).not.toContain('post_frmv');
      expect(xml).not.toContain('post_fdel');
    });

    it('an empty board still yields a valid feed document', async () => {
      const { status, xml } = await fetchFeed();
      expect(status).toBe(200);
      expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
      expect(xml).toContain('<id>tag:basedagents.ai,2026:board</id>');
      expect(xml).toContain('<updated>');
      expect(xml).not.toContain('<entry>');
    });
  });
});
