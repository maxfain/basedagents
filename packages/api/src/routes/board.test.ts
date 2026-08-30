/**
 * Board core tests (board spec §5 + §9, test plan §12.3): post/read/thread
 * round-trip, seq cursors, depth cap, dedupe, write tiers (bucket isolation,
 * per-owner pooling), and the global uncertified valve with its
 * first-ever-post bypass.
 *
 * setupTestDb builds the OSS shape (no control-plane tables); tests that need
 * certification graft 0023 + 0025 on and reset the probe, exactly like
 * messages.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
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

/** Pins the wire format: cursor = base64url(decimal seq). */
function cur(seq: number): string {
  return btoa(String(seq)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bodyHash(body: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(body)));
}

type Json = Record<string, unknown>;
type PostJson = Json & { id: string; body: string };

describe('Board', () => {
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

  async function post(kp: TestKeypair, payload: Json, useApp = app): Promise<{ status: number; data: Json }> {
    const body = JSON.stringify(payload);
    const headers = await signRequest(kp, 'POST', '/v1/board/posts', body);
    const res = await useApp.request('/v1/board/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    return { status: res.status, data: await res.json() as Json };
  }

  async function list(queryString = ''): Promise<{ status: number; data: Json & { posts?: PostJson[] } }> {
    const res = await app.request(`/v1/board/posts${queryString}`, { method: 'GET' });
    return { status: res.status, data: await res.json() as Json };
  }

  /** Direct insert — controlled seq/created_at/status without burning write tiers. */
  async function insertPost(
    id: string,
    authorAgentId: string,
    opts: { body?: string; replyTo?: string; threadRoot?: string; createdAt?: string; status?: string; deletedAt?: string } = {}
  ): Promise<number> {
    const body = opts.body ?? `body of ${id}`;
    await db.run(
      `INSERT INTO board_posts (id, author_agent_id, author_owner_id, author_kind, body, body_sha256, reply_to_post_id, thread_root_id, status, created_at, deleted_at)
       VALUES (?, ?, NULL, 'agent', ?, ?, ?, ?, ?, ?, ?)`,
      id, authorAgentId, body, bodyHash(body),
      opts.replyTo ?? null, opts.threadRoot ?? id,
      opts.status ?? 'visible', opts.createdAt ?? new Date().toISOString(),
      opts.deletedAt ?? null
    );
    const row = await db.get<{ seq: number }>('SELECT seq FROM board_posts WHERE id = ?', id);
    return row!.seq;
  }

  async function seedRateRows(key: string, n: number): Promise<void> {
    const now = new Date().toISOString();
    for (let i = 0; i < n; i++) {
      await db.run('INSERT INTO rate_limit_log (id, key, created_at) VALUES (?, ?, ?)', crypto.randomUUID(), key, now);
    }
  }

  beforeEach(async () => {
    db = setupTestDb();
    app = createTestApp(db);
    // The probe memoizes per isolate; a stale answer from the previous test's
    // DB must not leak forward.
    resetCertificationProbeForTests();
    agent = await createTestAgent(db, { status: 'active' });
  });

  // ─── POST /v1/board/posts ───

  describe('POST /v1/board/posts', () => {
    it('creates a root post: thread_root_id = own id, visible on the public list', async () => {
      const { status, data } = await post(agent, { body: 'hello board' });
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.post_id).toMatch(/^post_[0-9A-Za-z]{21}$/);
      expect(data.created_at).toBeDefined();

      const { data: page } = await list();
      expect(page.posts!.length).toBe(1);
      const p = page.posts![0];
      expect(p.id).toBe(data.post_id);
      expect(p.body).toBe('hello board');
      expect(p.thread_root_id).toBe(data.post_id);
      expect(p.reply_to_post_id).toBeNull();
      expect(p.author_kind).toBe('agent');
      expect(p.author_id).toBe(agent.agentId);
      expect(p.author_name).toBe(agent.name);
      expect(p.author_cert).toBe('none'); // OSS DB — nobody is certified
      expect(p.author_short_id).toBe(`${agent.agentId.slice(0, 12)}…`);
      // The seq spine stays internal; only the opaque cursor travels.
      expect('seq' in (p as Json)).toBe(false);
    });

    it('reply inherits the parent thread root (reply-to-reply included)', async () => {
      const root = (await post(agent, { body: 'root' })).data.post_id as string;
      const r1 = (await post(agent, { body: 'reply 1', reply_to_post_id: root })).data.post_id as string;
      const r2res = await post(agent, { body: 'reply 2', reply_to_post_id: r1 });
      expect(r2res.status).toBe(200);

      const row = await db.get<{ thread_root_id: string; reply_to_post_id: string }>(
        'SELECT thread_root_id, reply_to_post_id FROM board_posts WHERE id = ?', r2res.data.post_id
      );
      expect(row!.thread_root_id).toBe(root);
      expect(row!.reply_to_post_id).toBe(r1);
    });

    it('unauthenticated post → 401', async () => {
      const res = await app.request('/v1/board/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'anon' }),
      });
      expect(res.status).toBe(401);
    });

    it('non-active sender → 403', async () => {
      const pending = await createTestAgent(db, { status: 'pending' });
      const { status } = await post(pending, { body: 'not yet' });
      expect(status).toBe(403);
    });

    it('empty and oversize bodies → 400', async () => {
      expect((await post(agent, { body: '' })).status).toBe(400);
      expect((await post(agent, { body: 'x'.repeat(10001) })).status).toBe(400);
    });

    it('reply to nonexistent / held / deleted parent → 404 (no held-status oracle)', async () => {
      expect((await post(agent, { body: 'a', reply_to_post_id: 'post_missing' })).status).toBe(404);

      await insertPost('post_held1', agent.agentId, { status: 'held' });
      expect((await post(agent, { body: 'b', reply_to_post_id: 'post_held1' })).status).toBe(404);

      await insertPost('post_gone1', agent.agentId, { deletedAt: new Date().toISOString() });
      expect((await post(agent, { body: 'c', reply_to_post_id: 'post_gone1' })).status).toBe(404);
    });
  });

  // ─── Thread depth ───

  describe('thread depth cap', () => {
    it('allows depth 50, rejects depth 51', async () => {
      // Seed a root (depth 0) + chain down to depth 49 directly — dated
      // outside the 24h window so the seeding doesn't eat the author's own
      // 30/day budget before the replies under test.
      const yesterday = new Date(Date.now() - 25 * 3_600_000).toISOString();
      await insertPost('post_d0', agent.agentId, { createdAt: yesterday });
      for (let d = 1; d <= 49; d++) {
        await insertPost(`post_d${d}`, agent.agentId, { replyTo: `post_d${d - 1}`, threadRoot: 'post_d0', createdAt: yesterday });
      }

      // Reply to depth-49 → new post at depth 50: the last legal rung.
      const ok = await post(agent, { body: 'depth 50', reply_to_post_id: 'post_d49' });
      expect(ok.status).toBe(200);

      // Reply to that (depth 51) → rejected.
      const over = await post(agent, { body: 'depth 51', reply_to_post_id: ok.data.post_id as string });
      expect(over.status).toBe(400);
      expect((over.data.message as string)).toContain('depth');
    });
  });

  // ─── Dedupe ───

  describe('dedupe (author + body_sha256, 10 min)', () => {
    it('identical repost within 10 minutes → 409 carrying the original post_id', async () => {
      const first = await post(agent, { body: 'same words' });
      const dupe = await post(agent, { body: 'same words' });
      expect(dupe.status).toBe(409);
      expect(dupe.data.error).toBe('conflict');
      expect(dupe.data.post_id).toBe(first.data.post_id);

      // Different body, and the same body from a different author, both pass.
      expect((await post(agent, { body: 'different words' })).status).toBe(200);
      const other = await createTestAgent(db, { status: 'active' });
      expect((await post(other, { body: 'same words' })).status).toBe(200);
    });

    it('an identical post older than the window is not a duplicate', async () => {
      await insertPost('post_old1', agent.agentId, {
        body: 'echoes',
        createdAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      });
      expect((await post(agent, { body: 'echoes' })).status).toBe(200);
    });
  });

  // ─── Write tiers ───

  describe('write tiers', () => {
    it('uncertified: 6th post inside the hour → 429', async () => {
      for (let i = 0; i < 5; i++) {
        expect((await post(agent, { body: `post number ${i}` })).status).toBe(200);
      }
      const sixth = await post(agent, { body: 'one too many' });
      expect(sixth.status).toBe(429);
      expect((sixth.data.message as string)).toContain('per hour');
    });

    it('board bucket full does not starve DMs (board: ≠ msg:)', async () => {
      await seedRateRows(`board:${agent.agentId}`, 5);
      expect((await post(agent, { body: 'nope' })).status).toBe(429);

      const recipient = await createTestAgent(db, { status: 'active' });
      const dm = JSON.stringify({ subject: 'still works', body: 'dm body' });
      const headers = await signRequest(agent, 'POST', `/v1/agents/${recipient.agentId}/messages`, dm);
      const res = await app.request(`/v1/agents/${recipient.agentId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: dm,
      });
      expect(res.status).toBe(200);
    });

    it('msg bucket full does not starve the board (msg: ≠ board:)', async () => {
      await seedRateRows(`msg:${agent.agentId}`, 10);
      const recipient = await createTestAgent(db, { status: 'active' });
      const dm = JSON.stringify({ subject: 'blocked', body: 'dm body' });
      const headers = await signRequest(agent, 'POST', `/v1/agents/${recipient.agentId}/messages`, dm);
      const res = await app.request(`/v1/agents/${recipient.agentId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: dm,
      });
      expect(res.status).toBe(429);

      expect((await post(agent, { body: 'board unaffected' })).status).toBe(200);
    });

    it('uncertified daily cap: 30 posts today → 429 even with an empty hourly bucket', async () => {
      // Direct inserts never wrote rate_limit_log rows — only the durable
      // board_posts count can refuse this one.
      for (let i = 0; i < 30; i++) {
        await insertPost(`post_day${i}`, agent.agentId, {
          body: `daily ${i}`,
          createdAt: new Date(Date.now() - i * 60_000 - 2 * 3_600_000).toISOString(),
        });
      }
      const capped = await post(agent, { body: 'the 31st' });
      expect(capped.status).toBe(429);
      expect((capped.data.message as string)).toContain('per day');
    });

    it('certified: draws from the per-owner pool, not the per-agent bucket', async () => {
      await installControlTables();
      const ownerId = await createOwner();
      await delegate(ownerId, agent.agentId);

      // A full per-agent bucket (would 429 any uncertified agent) is ignored…
      await seedRateRows(`board:${agent.agentId}`, 5);
      expect((await post(agent, { body: 'certified lane' })).status).toBe(200);

      // …but a full owner pool refuses.
      await seedRateRows(`board:ow:${ownerId}`, 30);
      const blocked = await post(agent, { body: 'pool exhausted' });
      expect(blocked.status).toBe(429);
      expect((blocked.data.message as string)).toContain('owner');
    });

    it('the owner pool is shared across two delegated agents', async () => {
      await installControlTables();
      const ownerId = await createOwner();
      const agentB = await createTestAgent(db, { status: 'active' });
      await delegate(ownerId, agent.agentId);
      await delegate(ownerId, agentB.agentId);

      // 29 pool slots burnt; agent A takes the 30th, agent B finds it empty —
      // minting more certified agents never mints more budget.
      await seedRateRows(`board:ow:${ownerId}`, 29);
      expect((await post(agent, { body: 'slot thirty' })).status).toBe(200);
      expect((await post(agentB, { body: 'slot thirty-one' })).status).toBe(429);
    });
  });

  // ─── Global uncertified valve ───

  describe('uncertified class valve', () => {
    it('429s only non-first uncertified posts; certified traffic never touched', async () => {
      // Threshold 1/hr so two agents can exercise every branch.
      const valveApp = createTestApp(db, { BOARD_UNCERT_VALVE_HOURLY: '1' });
      const p = (kp: TestKeypair, body: string) => post(kp, { body }, valveApp);

      const agentB = await createTestAgent(db, { status: 'active' });

      // A's first-ever post bypasses the valve (and does not consume it).
      expect((await p(agent, 'A first')).status).toBe(200);
      // A's second post takes the single valve slot.
      expect((await p(agent, 'A second')).status).toBe(200);
      // A's third finds the valve full.
      expect((await p(agent, 'A third')).status).toBe(429);

      // B's FIRST post still lands — the bypass is what keeps a griefer from
      // locking newcomers out of the board entirely.
      expect((await p(agentB, 'B first')).status).toBe(200);
      // B's second is uncertified non-first traffic: valved.
      expect((await p(agentB, 'B second')).status).toBe(429);

      // A certified agent posts straight through the closed valve.
      await installControlTables();
      const agentC = await createTestAgent(db, { status: 'active' });
      await delegate(await createOwner(), agentC.agentId);
      expect((await p(agentC, 'C first')).status).toBe(200);
      expect((await p(agentC, 'C second')).status).toBe(200);
    });
  });

  // ─── GET /v1/board/posts ───

  describe('GET /v1/board/posts — cursors and filters', () => {
    it('pages newest-first by default and scrolls backward with ?before=', async () => {
      const seqs: number[] = [];
      for (let i = 1; i <= 5; i++) seqs.push(await insertPost(`post_p${i}`, agent.agentId));

      const page1 = await list('?limit=2');
      expect(page1.data.posts!.map((p) => p.id)).toEqual(['post_p5', 'post_p4']);
      expect(page1.data.has_more).toBe(true);
      expect(page1.data.next_cursor).toBe(cur(seqs[3]));

      const page2 = await list(`?limit=2&before=${page1.data.next_cursor}`);
      expect(page2.data.posts!.map((p) => p.id)).toEqual(['post_p3', 'post_p2']);

      const page3 = await list(`?limit=2&before=${page2.data.next_cursor}`);
      expect(page3.data.posts!.map((p) => p.id)).toEqual(['post_p1']);
      expect(page3.data.has_more).toBe(false);
    });

    it('?after= returns strictly-after posts oldest-first — the RSS contract', async () => {
      const seqs: number[] = [];
      for (let i = 1; i <= 5; i++) seqs.push(await insertPost(`post_f${i}`, agent.agentId));

      const { data } = await list(`?after=${cur(seqs[2])}`);
      expect(data.posts!.map((p) => p.id)).toEqual(['post_f4', 'post_f5']);
      expect(data.has_more).toBe(false);
      expect(data.next_cursor).toBe(cur(seqs[4]));

      // Caught-up poller: empty page, null cursor (keep the old one).
      const tail = await list(`?after=${cur(seqs[4])}`);
      expect(tail.data.posts).toEqual([]);
      expect(tail.data.next_cursor).toBeNull();
      expect(tail.data.has_more).toBe(false);
    });

    it('rejects forged cursors, after+before together, and limit > 50', async () => {
      expect((await list('?after=%21%21%21')).status).toBe(400);
      expect((await list(`?after=${btoa('12; DROP TABLE')}`)).status).toBe(400);
      expect((await list(`?after=${cur(1)}&before=${cur(2)}`)).status).toBe(400);
      expect((await list('?limit=51')).status).toBe(400);
    });

    it('filters by author and by thread', async () => {
      const other = await createTestAgent(db, { status: 'active' });
      await insertPost('post_mineA', agent.agentId);
      await insertPost('post_theirs', other.agentId);
      await insertPost('post_mineB', agent.agentId, { replyTo: 'post_mineA', threadRoot: 'post_mineA' });

      const byAuthor = await list(`?author=${agent.agentId}`);
      expect(byAuthor.data.posts!.map((p) => p.id).sort()).toEqual(['post_mineA', 'post_mineB']);

      const byThread = await list('?thread=post_mineA');
      expect(byThread.data.posts!.map((p) => p.id)).toEqual(['post_mineB', 'post_mineA']);
    });

    it('excludes held, removed, and author-deleted rows from the list', async () => {
      await insertPost('post_vis', agent.agentId);
      await insertPost('post_hld', agent.agentId, { status: 'held' });
      await insertPost('post_rmv', agent.agentId, { status: 'removed' });
      await insertPost('post_del', agent.agentId, { deletedAt: new Date().toISOString() });

      const { data } = await list();
      expect(data.posts!.map((p) => p.id)).toEqual(['post_vis']);
    });

    it('certified_only: honest empty on OSS, live-filtered with control tables', async () => {
      await insertPost('post_plain', agent.agentId);
      expect((await list('?certified_only=true')).data.posts).toEqual([]);

      await installControlTables();
      const certAgent = await createTestAgent(db, { status: 'active' });
      const delegationId = await delegate(await createOwner(), certAgent.agentId);
      await insertPost('post_badged', certAgent.agentId);

      const certified = await list('?certified_only=true');
      expect(certified.data.posts!.map((p) => p.id)).toEqual(['post_badged']);
      expect(certified.data.posts![0].author_cert).toBe('certified_agent');

      // Live, not snapshotted: revoking the delegation drops the post from
      // the certified view on the very next read.
      await db.run(`UPDATE delegations SET status = 'revoked' WHERE id = ?`, delegationId);
      expect((await list('?certified_only=true')).data.posts).toEqual([]);
    });
  });

  // ─── GET /v1/board/posts/:id ───

  describe('GET /v1/board/posts/:id — post + thread', () => {
    it('returns the post and its full thread in seq order', async () => {
      const root = (await post(agent, { body: 'root post' })).data.post_id as string;
      const r1 = (await post(agent, { body: 'first reply', reply_to_post_id: root })).data.post_id as string;
      const r2 = (await post(agent, { body: 'second reply', reply_to_post_id: r1 })).data.post_id as string;

      const res = await app.request(`/v1/board/posts/${r1}`);
      expect(res.status).toBe(200);
      const data = await res.json() as { post: PostJson; thread: PostJson[] };
      expect(data.post.id).toBe(r1);
      expect(data.thread.map((p) => p.id)).toEqual([root, r1, r2]);
    });

    it('404s for unknown, held, and removed posts alike', async () => {
      expect((await app.request('/v1/board/posts/post_missing')).status).toBe(404);
      await insertPost('post_h2', agent.agentId, { status: 'held' });
      expect((await app.request('/v1/board/posts/post_h2')).status).toBe(404);
      await insertPost('post_r2', agent.agentId, { status: 'removed' });
      expect((await app.request('/v1/board/posts/post_r2')).status).toBe(404);
    });

    it('a soft-deleted post still anchors its thread, body blanked', async () => {
      await insertPost('post_root9', agent.agentId, { body: 'secret', deletedAt: new Date().toISOString() });
      await insertPost('post_reply9', agent.agentId, { body: 'reply stays', replyTo: 'post_root9', threadRoot: 'post_root9' });

      const res = await app.request('/v1/board/posts/post_root9');
      expect(res.status).toBe(200);
      const data = await res.json() as { post: PostJson; thread: PostJson[] };
      expect(data.post.body).toBe('');
      expect(data.post.deleted).toBe(true);
      expect(data.thread.map((p) => [p.id, p.body])).toEqual([
        ['post_root9', ''],
        ['post_reply9', 'reply stays'],
      ]);
    });
  });

  // ─── DELETE /v1/board/posts/:id ───

  describe('DELETE /v1/board/posts/:id — author soft delete', () => {
    async function del(kp: TestKeypair, postId: string): Promise<number> {
      const headers = await signRequest(kp, 'DELETE', `/v1/board/posts/${postId}`);
      const res = await app.request(`/v1/board/posts/${postId}`, { method: 'DELETE', headers: { ...headers } });
      return res.status;
    }

    it('author deletes: row leaves the list, thread keeps a blanked slot, idempotent', async () => {
      const postId = (await post(agent, { body: 'regrets' })).data.post_id as string;
      expect(await del(agent, postId)).toBe(200);

      expect((await list()).data.posts).toEqual([]);
      const row = await db.get<{ deleted_at: string }>('SELECT deleted_at FROM board_posts WHERE id = ?', postId);
      expect(row!.deleted_at).toBeTruthy();

      // Retried delete answers ok without moving the original deleted_at.
      expect(await del(agent, postId)).toBe(200);
      const again = await db.get<{ deleted_at: string }>('SELECT deleted_at FROM board_posts WHERE id = ?', postId);
      expect(again!.deleted_at).toBe(row!.deleted_at);
    });

    it('non-author → 403, unauthenticated → 401, unknown → 404', async () => {
      const postId = (await post(agent, { body: 'mine alone' })).data.post_id as string;

      const other = await createTestAgent(db, { status: 'active' });
      expect(await del(other, postId)).toBe(403);

      const anon = await app.request(`/v1/board/posts/${postId}`, { method: 'DELETE' });
      expect(anon.status).toBe(401);

      expect(await del(agent, 'post_missing')).toBe(404);
    });
  });

  // ─── Cert-badge forgery via display name (review fix, spec §4) ───

  describe('display-name cannot forge the cert badge', () => {
    it('strips the ✓ glyph an uncertified author put in their name', async () => {
      // An uncertified agent named "✓ Genesis" would otherwise render
      // byte-for-byte like a certified author on every surface.
      const spoof = await createTestAgent(db, { status: 'active', name: '✓ Genesis' });
      const { data } = await post(spoof, { body: 'trust me' });
      const { data: page } = await list(`?author=${encodeURIComponent(spoof.agentId)}`);
      const p = page.posts![0];
      expect(p.id).toBe(data.post_id);
      // The glyph is gone from the name, and the structured badge says none.
      expect(p.author_name).toBe('Genesis');
      expect(p.author_name).not.toContain('✓');
      expect(p.author_cert).toBe('none');
    });

    it('strips a bracketed "[✓ certified]" marker baked into the name', async () => {
      const spoof = await createTestAgent(db, { status: 'active', name: '[✓ certified] Bob' });
      await post(spoof, { body: 'hi' });
      const { data: page } = await list(`?author=${encodeURIComponent(spoof.agentId)}`);
      expect(page.posts![0].author_name).not.toContain('✓');
    });
  });
});
