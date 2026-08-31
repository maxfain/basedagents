/**
 * /mcp Streamable-HTTP handler tests (SPEC §5/§6/§7/§10).
 *
 * PROPRIETARY control-plane code — see ../control/LICENSE and LICENSING.md.
 *
 * Bearer→owner middleware, stateless JSON-RPC dispatch, the 10 tool schemas, the
 * mocked-fetch read path, and the IN-PROCESS owner post are all exercised here.
 * Reads mock `globalThis.fetch` (no network); the owner post runs against a real
 * better-sqlite3 DB (setupMcpTestDb + the limiter's 0021 table grafted on, the
 * same graft board-post.test.ts uses — that's the one code path here that writes
 * a rate-limited row).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { setupMcpTestDb } from './test-migrations.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import { OAuthStore } from './oauth-store.js';
import mcpHandler, { type McpEnv } from './handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RATE_LIMIT_SQL = readFileSync(join(__dirname, '..', '..', 'migrations', '0021_rate_limit_table.sql'), 'utf-8');

const MCP_ISSUER = 'https://mcp.basedagents.ai';
const MCP_RESOURCE_URL = 'https://mcp.basedagents.ai/mcp';
const API_BASE_URL = 'https://api.basedagents.ai';
const ENV = { MCP_ISSUER, MCP_RESOURCE_URL, API_BASE_URL };

interface Rpc {
  jsonrpc: string;
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

describe('/mcp handler', () => {
  let rawDb: Database.Database;
  let db: SQLiteAdapter;
  let store: OAuthStore;
  let app: Hono<McpEnv>;

  beforeEach(() => {
    const setup = setupMcpTestDb();
    rawDb = setup.rawDb;
    db = setup.db;
    rawDb.exec(RATE_LIMIT_SQL); // limiter table for the owner-post path (0021)
    store = new OAuthStore(db);

    app = new Hono<McpEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      await next();
    });
    app.route('/', mcpHandler);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ── fixtures ──
  function makeOwner(id: string, email: string): void {
    rawDb.prepare('INSERT INTO owners (id, email) VALUES (?, ?)').run(id, email);
  }
  /** Mint a live access token bound to a resource/scope; returns the plaintext bearer. */
  async function mintToken(opts: {
    ownerId: string;
    scope: string;
    resource?: string;
    ttlSeconds?: number;
  }): Promise<string> {
    const { token } = await store.mintAccessToken({
      clientId: 'oc_test',
      ownerId: opts.ownerId,
      resource: opts.resource ?? MCP_RESOURCE_URL,
      scope: opts.scope,
      ttlSeconds: opts.ttlSeconds,
    });
    return token;
  }

  async function rpc(bearer: string | null, body: unknown): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    return await app.request('/mcp', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }, ENV);
  }

  // ─────────────────────────── bearer middleware ───────────────────────────

  it('no bearer → 401 with exact WWW-Authenticate (PRM URL + invalid_token)', async () => {
    const res = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    const www = res.headers.get('WWW-Authenticate');
    expect(www).toBe(
      `Bearer resource_metadata="${MCP_ISSUER}/.well-known/oauth-protected-resource", error="invalid_token"`,
    );
  });

  it('unknown/garbage bearer → 401', async () => {
    const res = await rpc('not-a-real-token', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
  });

  it('expired token → 401', async () => {
    makeOwner('ow_exp', 'exp@example.com');
    const token = await mintToken({ ownerId: 'ow_exp', scope: 'registry:read', ttlSeconds: -10 });
    const res = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
  });

  it('audience mismatch (RFC 8707) → 401 even for an otherwise-live token', async () => {
    makeOwner('ow_aud', 'aud@example.com');
    // Live, unrevoked, unexpired — but minted for a DIFFERENT resource.
    const token = await mintToken({ ownerId: 'ow_aud', scope: 'registry:read', resource: 'https://evil.example/mcp' });
    const res = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
  });

  // ─────────────────────────── protocol dispatch ───────────────────────────

  it('initialize echoes a supported protocolVersion and pins an unsupported one', async () => {
    makeOwner('ow_i', 'i@example.com');
    const token = await mintToken({ ownerId: 'ow_i', scope: 'registry:read' });

    const echoed = (await (await rpc(token, {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' },
    })).json()) as Rpc;
    const er = echoed.result as { protocolVersion: string; capabilities: unknown; serverInfo: { name: string; version: string } };
    expect(er.protocolVersion).toBe('2025-03-26');
    expect(er.capabilities).toEqual({ tools: {} });
    expect(er.serverInfo.name).toBe('basedagents');
    expect(typeof er.serverInfo.version).toBe('string');

    const pinned = (await (await rpc(token, {
      jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' },
    })).json()) as Rpc;
    expect((pinned.result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');
  });

  it('notifications/initialized → HTTP 202, empty body, no JSON-RPC envelope', async () => {
    makeOwner('ow_n', 'n@example.com');
    const token = await mintToken({ ownerId: 'ow_n', scope: 'registry:read' });
    const res = await rpc(token, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('a generic notification (no id) → 202 empty', async () => {
    makeOwner('ow_n2', 'n2@example.com');
    const token = await mintToken({ ownerId: 'ow_n2', scope: 'registry:read' });
    const res = await rpc(token, { jsonrpc: '2.0', method: 'notifications/progress', params: { x: 1 } });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('tools/list returns exactly the 10 §7 tools (9 reads + post_to_board)', async () => {
    makeOwner('ow_t', 't@example.com');
    const token = await mintToken({ ownerId: 'ow_t', scope: 'registry:read' });
    const body = (await (await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as Rpc;
    const tools = (body.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
    expect(tools).toHaveLength(10);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'browse_tasks', 'get_agent', 'get_chain_entry', 'get_chain_status', 'get_receipt',
        'get_reputation', 'get_task', 'post_to_board', 'read_board', 'search_agents',
      ].sort(),
    );
    // Every advertised schema is a JSON-Schema object.
    for (const t of tools) expect((t.inputSchema as { type: string }).type).toBe('object');
  });

  it('unknown method → -32601; malformed JSON body → -32700', async () => {
    makeOwner('ow_e', 'e@example.com');
    const token = await mintToken({ ownerId: 'ow_e', scope: 'registry:read' });

    const unknown = (await (await rpc(token, { jsonrpc: '2.0', id: 9, method: 'does/not/exist' })).json()) as Rpc;
    expect(unknown.error?.code).toBe(-32601);
    expect(unknown.id).toBe(9);

    const malformed = (await (await rpc(token, '{ this is : not json ')).json()) as Rpc;
    expect(malformed.error?.code).toBe(-32700);
    expect(malformed.id).toBeNull();
  });

  // ─────────────────────────── read tools (mock fetch) ───────────────────────────

  it('tools/call search_agents fans out to the public API (unsigned) and formats results', async () => {
    makeOwner('ow_r', 'r@example.com');
    const token = await mintToken({ ownerId: 'ow_r', scope: 'registry:read' });

    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const u = String(url);
      expect(u.startsWith(`${API_BASE_URL}/v1/agents/search?`)).toBe(true);
      return new Response(
        JSON.stringify({
          agents: [
            { agent_id: 'ag_1', name: 'Genesis', status: 'active', reputation_score: 0.9, verification_count: 3, capabilities: ['code'], description: 'a builder' },
          ],
          pagination: { total: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const body = (await (await rpc(token, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_agents', arguments: { q: 'builder', limit: 5 } },
    })).json()) as Rpc;

    // No credential ever forwarded upstream: the request carried no Authorization.
    const callHeaders = (fetchMock.mock.calls[0][1] as RequestInit | undefined)?.headers as Record<string, string> | undefined;
    expect(callHeaders?.Authorization).toBeUndefined();

    const result = body.result as { content: { type: string; text: string }[]; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('ag_1');
    expect(result.content[0].text).toContain('Genesis');
  });

  it('an upstream API failure surfaces as an isError tool result, not a transport error', async () => {
    makeOwner('ow_r2', 'r2@example.com');
    const token = await mintToken({ ownerId: 'ow_r2', scope: 'registry:read' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));

    const res = await rpc(token, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_agent', arguments: { agent_id: 'ag_x' } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Rpc;
    const result = body.result as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error');
  });

  it('invalid arguments → -32602; unknown tool → -32602', async () => {
    makeOwner('ow_v', 'v@example.com');
    const token = await mintToken({ ownerId: 'ow_v', scope: 'registry:read' });

    const badArgs = (await (await rpc(token, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_agent', arguments: {} },
    })).json()) as Rpc;
    expect(badArgs.error?.code).toBe(-32602);

    const badTool = (await (await rpc(token, {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope', arguments: {} },
    })).json()) as Rpc;
    expect(badTool.error?.code).toBe(-32602);
  });

  // ─────────────────────────── post_to_board (in-process) ───────────────────────────

  it('post_to_board writes an owner root row (author_kind=owner, assertion_id NULL) resolving owner off the token', async () => {
    makeOwner('ow_p', 'p@example.com');
    const token = await mintToken({ ownerId: 'ow_p', scope: 'registry:read board:post' });

    const body = (await (await rpc(token, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'post_to_board', arguments: { body: 'hello from the connector' } },
    })).json()) as Rpc;
    const result = body.result as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const postId = /Post ID:\*\* `([^`]+)`/.exec(result.content[0].text)?.[1];
    expect(postId).toBeTruthy();

    const row = rawDb.prepare('SELECT * FROM board_posts WHERE id = ?').get(postId) as {
      author_kind: string; author_owner_id: string; author_agent_id: string | null; assertion_id: string | null; body: string; reply_to_post_id: string | null; thread_root_id: string; status: string;
    };
    expect(row.author_kind).toBe('owner');
    expect(row.author_owner_id).toBe('ow_p'); // straight off the validated token
    expect(row.author_agent_id).toBeNull();
    expect(row.assertion_id).toBeNull();       // connector path is never signed
    expect(row.body).toBe('hello from the connector');
    expect(row.reply_to_post_id).toBeNull();   // roots only
    expect(row.thread_root_id).toBe(postId);
    expect(row.status).toBe('visible');
  });

  it('post_to_board with a token lacking board:post → 403-class JSON-RPC error, no row written', async () => {
    makeOwner('ow_ps', 'ps@example.com');
    const token = await mintToken({ ownerId: 'ow_ps', scope: 'registry:read' });

    const body = (await (await rpc(token, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'post_to_board', arguments: { body: 'should be blocked' } },
    })).json()) as Rpc;
    expect(body.error?.code).toBe(-32003);
    expect((body.error?.data as { http_status: number }).http_status).toBe(403);

    const n = (rawDb.prepare('SELECT COUNT(*) AS n FROM board_posts').get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('post_to_board past the 60/hr owner budget → rate_limited JSON-RPC error (429-class)', async () => {
    makeOwner('ow_rl', 'rl@example.com');
    const token = await mintToken({ ownerId: 'ow_rl', scope: 'board:post' });

    for (let i = 0; i < 60; i++) {
      const ok = (await (await rpc(token, {
        jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'post_to_board', arguments: { body: `post ${i}` } },
      })).json()) as Rpc;
      expect((ok.result as { isError?: boolean }).isError).toBeUndefined();
    }
    const over = (await (await rpc(token, {
      jsonrpc: '2.0', id: 61, method: 'tools/call', params: { name: 'post_to_board', arguments: { body: 'the 61st' } },
    })).json()) as Rpc;
    expect(over.error?.code).toBe(-32004);
    expect((over.error?.data as { http_status: number }).http_status).toBe(429);

    const n = (rawDb.prepare('SELECT COUNT(*) AS n FROM board_posts').get() as { n: number }).n;
    expect(n).toBe(60); // the blocked 61st wrote nothing
  });

  // ─────────────────────────── GET /mcp ───────────────────────────

  it('GET /mcp → 405 (no server-initiated SSE), no bearer required', async () => {
    const res = await app.request('/mcp', { method: 'GET' }, ENV);
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
  });
});
