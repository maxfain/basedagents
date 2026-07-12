/**
 * Targeted tests for security audit fixes (commit 6e53b1e + LOW-9/HIGH-4).
 * Covers: MED-1, MED-4, MED-6, MED-8, LOW-1, LOW-9, HIGH-4
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from './types/index.js';
import { setupTestDb, createTestAgent, createTestApp, signRequest } from './test-helpers.js';
import type { SQLiteAdapter } from './db/sqlite-adapter.js';
import { fireWebhook } from './lib/webhooks.js';
import scanRoutes from './routes/scan.js';

// ── MED-1: Clock skew tightened to ±15s ──────────────────────────────

describe('MED-1: Clock skew ±15s', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;
  let agent: Awaited<ReturnType<typeof createTestAgent>>;

  beforeEach(async () => {
    db = setupTestDb();
    app = createTestApp(db);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    agent = await createTestAgent(db);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects timestamp 20s in the past via agentAuth (PATCH profile)', async () => {
    // Craft a request with a stale timestamp (20s old)
    const body = JSON.stringify({ description: 'test' });
    const headers = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/profile`, body);
    // Override the timestamp to be 20s old
    headers['X-Timestamp'] = String(Math.floor(Date.now() / 1000) - 20);

    const res = await app.request(`/v1/agents/${agent.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    expect(res.status).toBe(401);
    const data = await res.json() as { message: string };
    expect(data.message).toContain('15 seconds');
  });

  it('rejects timestamp 16s in the future via agentAuth', async () => {
    const body = JSON.stringify({ description: 'test' });
    const headers = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/profile`, body);
    headers['X-Timestamp'] = String(Math.floor(Date.now() / 1000) + 16);

    const res = await app.request(`/v1/agents/${agent.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    expect(res.status).toBe(401);
    const data = await res.json() as { message: string };
    expect(data.message).toContain('15 seconds');
  });

  it('accepts timestamp within ±14s', async () => {
    // signRequest uses current timestamp so it's within window
    const body = JSON.stringify({ description: 'still valid' });
    const headers = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/profile`, body);
    const res = await app.request(`/v1/agents/${agent.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    expect(res.status).toBe(200);
  });
});

// ── MED-4: json_each() prevents cross-JSON-boundary matches ──────────

describe('MED-4: json_each() search filters', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = setupTestDb();
    app = createTestApp(db);
  });

  it('exact match: finds agent with capability "code-generation"', async () => {
    await createTestAgent(db, { name: 'A', status: 'active', capabilities: ['code-generation'] });
    const res = await app.request('/v1/agents/search?capabilities=code-generation');
    expect(res.status).toBe(200);
    const data = await res.json() as { agents: Array<{ name: string }> };
    expect(data.agents.some(a => a.name === 'A')).toBe(true);
  });

  it('no cross-boundary match: "generation" does not match "code-generation"', async () => {
    await createTestAgent(db, { name: 'B', status: 'active', capabilities: ['code-generation'] });
    const res = await app.request('/v1/agents/search?capabilities=generation');
    expect(res.status).toBe(200);
    const data = await res.json() as { agents: Array<{ name: string }> };
    // json_each does exact value match, so partial should NOT match
    expect(data.agents.every(a => a.name !== 'B')).toBe(true);
  });

  it('no injection via crafted capability search', async () => {
    await createTestAgent(db, { name: 'Safe', status: 'active', capabilities: ['code'] });
    // This string would break LIKE-based matching but json_each handles it safely
    const crafted = encodeURIComponent('"code","evil":"x');
    const res = await app.request(`/v1/agents/search?capabilities=${crafted}`);
    expect(res.status).toBe(200);
    const data = await res.json() as { agents: Array<{ name: string }> };
    expect(data.agents.every(a => a.name !== 'Safe')).toBe(true);
  });

  it('exact match works for protocols filter', async () => {
    await createTestAgent(db, { name: 'P1', status: 'active', protocols: ['a2a'] });
    await createTestAgent(db, { name: 'P2', status: 'active', protocols: ['http'] });
    const res = await app.request('/v1/agents/search?protocols=a2a');
    expect(res.status).toBe(200);
    const data = await res.json() as { agents: Array<{ name: string }> };
    expect(data.agents.some(a => a.name === 'P1')).toBe(true);
    expect(data.agents.every(a => a.name !== 'P2')).toBe(true);
  });

  it('multiple capabilities filter with comma', async () => {
    await createTestAgent(db, { name: 'Multi', status: 'active', capabilities: ['code-generation', 'debugging'] });
    await createTestAgent(db, { name: 'Single', status: 'active', capabilities: ['code-generation'] });
    const res = await app.request('/v1/agents/search?capabilities=code-generation,debugging');
    expect(res.status).toBe(200);
    const data = await res.json() as { agents: Array<{ name: string }> };
    expect(data.agents.some(a => a.name === 'Multi')).toBe(true);
    // Single only has code-generation, not debugging, so it shouldn't match both
    expect(data.agents.every(a => a.name !== 'Single')).toBe(true);
  });
});

// ── MED-6: Webhook HMAC-SHA256 signing ───────────────────────────────

describe('MED-6: Webhook HMAC-SHA256 signing', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes X-BasedAgents-Signature header when secret provided', async () => {
    await fireWebhook('https://example.com/hook', {
      type: 'agent.registered',
      agent_id: 'ag_test',
      name: 'Test',
      capabilities: [],
    }, 'test-secret-key');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers['X-BasedAgents-Signature']).toBeDefined();
    expect(opts.headers['X-BasedAgents-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('omits X-BasedAgents-Signature when no secret', async () => {
    await fireWebhook('https://example.com/hook', {
      type: 'agent.registered',
      agent_id: 'ag_test',
      name: 'Test',
      capabilities: [],
    });

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers['X-BasedAgents-Signature']).toBeUndefined();
  });

  it('omits X-BasedAgents-Signature when secret is null', async () => {
    await fireWebhook('https://example.com/hook', {
      type: 'agent.registered',
      agent_id: 'ag_test',
      name: 'Test',
      capabilities: [],
    }, null);

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers['X-BasedAgents-Signature']).toBeUndefined();
  });

  it('HMAC is deterministic for same secret + payload', async () => {
    const event = {
      type: 'agent.registered' as const,
      agent_id: 'ag_test',
      name: 'Test',
      capabilities: [] as string[],
    };

    await fireWebhook('https://a.com', event, 'key1');
    await fireWebhook('https://b.com', event, 'key1');

    const sig1 = mockFetch.mock.calls[0][1].headers['X-BasedAgents-Signature'];
    const sig2 = mockFetch.mock.calls[1][1].headers['X-BasedAgents-Signature'];
    expect(sig1).toBe(sig2);
  });

  it('different secret produces different HMAC', async () => {
    const event = {
      type: 'agent.registered' as const,
      agent_id: 'ag_test',
      name: 'Test',
      capabilities: [] as string[],
    };

    await fireWebhook('https://a.com', event, 'key1');
    await fireWebhook('https://b.com', event, 'key2');

    const sig1 = mockFetch.mock.calls[0][1].headers['X-BasedAgents-Signature'];
    const sig2 = mockFetch.mock.calls[1][1].headers['X-BasedAgents-Signature'];
    expect(sig1).not.toBe(sig2);
  });
});

describe('MED-6: webhook_secret generated on profile update', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = setupTestDb();
    app = createTestApp(db);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('setting webhook_url generates a webhook_secret', async () => {
    const agent = await createTestAgent(db);
    const body = JSON.stringify({ webhook_url: 'https://example.com/hook' });
    const headers = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/profile`, body);
    const res = await app.request(`/v1/agents/${agent.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    expect(res.status).toBe(200);

    const row = await db.get<{ webhook_secret: string | null }>('SELECT webhook_secret FROM agents WHERE id = ?', agent.agentId);
    expect(row?.webhook_secret).toBeTruthy();
    expect(typeof row?.webhook_secret).toBe('string');
    // base64 encoded 32 bytes = 44 chars
    expect(row!.webhook_secret!.length).toBe(44);
  });

  it('clearing webhook_url also clears webhook_secret', async () => {
    const agent = await createTestAgent(db);
    // Set
    const setBody = JSON.stringify({ webhook_url: 'https://example.com/hook' });
    const setH = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/profile`, setBody);
    await app.request(`/v1/agents/${agent.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...setH },
      body: setBody,
    });
    // Clear
    const clearBody = JSON.stringify({ webhook_url: '' });
    const clearH = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/profile`, clearBody);
    await app.request(`/v1/agents/${agent.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...clearH },
      body: clearBody,
    });

    const row = await db.get<{ webhook_secret: string | null }>('SELECT webhook_secret FROM agents WHERE id = ?', agent.agentId);
    expect(row?.webhook_secret).toBeNull();
  });
});

// ── MED-8: Source validation ─────────────────────────────────────────

describe('MED-8: scan source validation', () => {
  let db: SQLiteAdapter;
  let app: InstanceType<typeof Hono<AppEnv>>;

  beforeEach(async () => {
    db = setupTestDb();
    // Create scan tables needed for tests
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS scan_reports (
        id TEXT PRIMARY KEY, package_name TEXT NOT NULL, package_version TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'npm', ref TEXT,
        score REAL NOT NULL, grade TEXT NOT NULL,
        findings_json TEXT, metadata_json TEXT, basedagents_json TEXT,
        scanned_at TEXT, submitted_by TEXT, created_at TEXT,
        scanner_version INTEGER DEFAULT 1,
        UNIQUE(source, package_name, package_version)
      )`);
    } catch { /* already exists */ }

    // Build a custom app that includes scan routes.
    // ADMIN_SECRET is required: POST /v1/scan is fail-closed (HIGH-3).
    app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      (c.env as AppEnv['Bindings']) = { ...(c.env ?? {}), ADMIN_SECRET: 'test-admin-secret' };
      await next();
    });
    app.route('/v1/scan', scanRoutes);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    await createTestAgent(db, { status: 'active' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const makeReport = (source: string) => ({
    package_name: 'test-pkg',
    package_version: '1.0.0',
    source,
    score: 80,
    grade: 'B',
    findings: [],
  });

  for (const validSource of ['npm', 'github', 'pypi']) {
    it(`accepts valid source "${validSource}"`, async () => {
      const body = JSON.stringify(makeReport(validSource));
      const res = await app.request('/v1/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-secret' },
        body,
      });
      // Should not be 400 (invalid source) — should be accepted
      expect(res.status).not.toBe(400);
    });
  }

  for (const invalidSource of ['rubygems', 'docker', 'npm"OR 1=1--', 'NPM']) {
    it(`rejects invalid source "${invalidSource}"`, async () => {
      const body = JSON.stringify(makeReport(invalidSource));
      const res = await app.request('/v1/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-secret' },
        body,
      });
      expect(res.status).toBe(400);
      const data = await res.json() as { message: string };
      expect(data.message).toContain('Invalid source');
    });
  }

  it('defaults to npm when source is omitted', async () => {
    const report = { package_name: 'pkg', package_version: '1.0.0', score: 80, grade: 'B', findings: [] };
    const body = JSON.stringify(report);
    const res = await app.request('/v1/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-secret' },
      body,
    });
    // npm is valid so should not be 400
    expect(res.status).not.toBe(400);
  });

  it('rejects submission with a wrong bearer token (401)', async () => {
    const res = await app.request('/v1/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
      body: JSON.stringify(makeReport('npm')),
    });
    expect(res.status).toBe(401);
  });

  it('fails closed when ADMIN_SECRET is not configured (403)', async () => {
    const openApp = new Hono<AppEnv>();
    openApp.use('*', async (c, next) => {
      c.set('db', db);
      (c.env as AppEnv['Bindings']) = { ...(c.env ?? {}) }; // no ADMIN_SECRET
      await next();
    });
    openApp.route('/v1/scan', scanRoutes);

    const res = await openApp.request('/v1/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeReport('npm')),
    });
    expect(res.status).toBe(403);
  });
});

// ── LOW-1: Lazy cleanup in rateLimit ─────────────────────────────────

describe('LOW-1: rateLimit lazy cleanup', () => {
  it('module exports without setInterval errors', async () => {
    const { rateLimit } = await import('./middleware/rateLimit.js');
    const mw = rateLimit({ windowMs: 60_000, max: 10 });
    expect(typeof mw).toBe('function');
  });

  it('no setInterval in rateLimit source', async () => {
    // Read the source to verify setInterval was actually removed
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(import.meta.dirname!, 'middleware', 'rateLimit.ts'),
      'utf-8'
    );
    // Check there are no actual setInterval calls (comments mentioning it are OK)
    const lines = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    expect(lines.some(l => l.includes('setInterval('))).toBe(false);
  });
});

// ── LOW-9: parseOctal — skip entries with malformed size fields ───────────────

import { parseTar } from './scanner/tar.js';

/** Build a minimal 512-byte tar header block. */
function makeTarHeader(opts: {
  name: string;
  size: string;    // raw octal string written into the 12-byte field
  typeFlag?: string;
}): Uint8Array {
  const block = new Uint8Array(512);
  const enc = new TextEncoder();

  // name (offset 0, length 100)
  const nameBytes = enc.encode(opts.name);
  block.set(nameBytes.slice(0, 100), 0);

  // size (offset 124, length 12)
  const sizeBytes = enc.encode(opts.size.slice(0, 11).padEnd(11, ' '));
  block.set(sizeBytes, 124);

  // type flag (offset 156)
  block[156] = opts.typeFlag ? opts.typeFlag.charCodeAt(0) : '0'.charCodeAt(0);

  return block;
}

/** Wrap header blocks + optional data into a ReadableStream. */
function tarStream(...blocks: Uint8Array[]): ReadableStream<Uint8Array> {
  const eoa = new Uint8Array(1024); // two zero blocks = end of archive
  const parts = [...blocks, eoa];
  const total = parts.reduce((s, b) => s + b.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { buf.set(p, off); off += p.length; }
  return new ReadableStream({ start(c) { c.enqueue(buf); c.close(); } });
}

describe('LOW-9: parseOctal — malformed size field handling', () => {
  it('skips entry with non-octal size (letters)', async () => {
    const header = makeTarHeader({ name: 'bad.js', size: 'XXXXXXX    ' });
    const entries: string[] = [];
    for await (const e of parseTar(tarStream(header))) {
      entries.push(e.name);
    }
    expect(entries).not.toContain('bad.js');
  });

  it('skips entry with size containing 8 or 9 (invalid octal digits)', async () => {
    const header = makeTarHeader({ name: 'bad2.js', size: '89abcdef   ' });
    const entries: string[] = [];
    for await (const e of parseTar(tarStream(header))) {
      entries.push(e.name);
    }
    expect(entries).not.toContain('bad2.js');
  });

  it('parses entry with valid zero size', async () => {
    const header = makeTarHeader({ name: 'empty.js', size: '0          ' });
    const entries: string[] = [];
    for await (const e of parseTar(tarStream(header))) {
      entries.push(e.name);
    }
    expect(entries).toContain('empty.js');
  });

  it('parses entry with valid non-zero octal size', async () => {
    // size = octal 15 = decimal 13 bytes; add a data block (512 bytes) after header
    const header = makeTarHeader({ name: 'hello.js', size: '15         ' });
    const data = new Uint8Array(512);
    new TextEncoder().encodeInto('console.log(1)', data);
    const entries: Awaited<ReturnType<typeof parseTar extends AsyncGenerator<infer T> ? Promise<T[]> : never>> | { name: string; size: number }[] = [];
    for await (const e of parseTar(tarStream(header, data))) {
      entries.push({ name: e.name, size: e.size });
    }
    expect(entries.find(e => e.name === 'hello.js')?.size).toBe(13); // 0o15 = 13
  });

  it('skips entry with empty size field (ambiguous — treated as zero, allowed)', async () => {
    const header = makeTarHeader({ name: 'empty-field.js', size: '           ' });
    // empty string → parseOctal returns 0, which is valid
    const entries: string[] = [];
    for await (const e of parseTar(tarStream(header))) {
      entries.push(e.name);
    }
    expect(entries).toContain('empty-field.js');
  });
});

// ── HIGH-4: Decompression bomb — readAll enforces limit on decompressed bytes ─

describe('HIGH-4: readAll enforces decompressed size limit', () => {
  it('throws TARBALL_TOO_LARGE when decompressed bytes exceed maxBytes', async () => {
    const smallLimit = 1024; // 1 KB limit for this test
    const bigBuf = new Uint8Array(2048); // 2 KB — exceeds limit
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(bigBuf); c.close(); },
    });

    const drain = async () => {
      for await (const _entry of parseTar(stream, smallLimit)) { /* drain */ }
    };
    await expect(drain()).rejects.toThrow('TARBALL_TOO_LARGE');
  });

  it('does not throw when decompressed bytes are within limit', async () => {
    // A minimal valid tar: one header + EOA (≤50MB)
    const header = makeTarHeader({ name: 'ok.js', size: '0          ' });
    const stream = tarStream(header);
    const entries: string[] = [];
    for await (const e of parseTar(stream, 50 * 1024 * 1024)) {
      entries.push(e.name);
    }
    expect(entries).toContain('ok.js');
  });
});
