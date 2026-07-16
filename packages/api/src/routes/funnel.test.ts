/**
 * Funnel + provider-vote routes: anonymous counters, allowlists, and the
 * promise that nothing identifying is ever stored.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { SQLiteAdapter } from '../db/sqlite-adapter.js';
import type { AppEnv } from '../types/index.js';
import funnelRoutes, { FUNNEL_EVENTS, VOTABLE_PROVIDERS } from './funnel.js';

const MIGRATION_0028 = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', '0028_funnel.sql'),
  'utf-8',
);

let db: SQLiteAdapter;
let app: Hono<AppEnv>;

beforeEach(() => {
  const raw = new Database(':memory:');
  raw.exec(MIGRATION_0028);
  db = new SQLiteAdapter(raw);
  app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });
  app.route('/v1', funnelRoutes);
});

async function post(path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('POST /v1/funnel', () => {
  it('records every event in the funnel, and only what was sent', async () => {
    for (const event of FUNNEL_EVENTS) {
      const res = await post('/v1/funnel', { event, funnel_id: 'run-abc123' });
      expect(res.status).toBe(200);
    }
    const rows = await db.all<{ event: string; funnel_id: string | null; provider: string | null }>(
      `SELECT event, funnel_id, provider FROM funnel_events ORDER BY id`,
    );
    expect(rows.map((r) => r.event)).toEqual([...FUNNEL_EVENTS]);
    expect(rows.every((r) => r.funnel_id === 'run-abc123')).toBe(true);
    expect(rows.every((r) => r.provider === null)).toBe(true); // nothing invented
  });

  it('accepts a provider slug on provider_connected', async () => {
    const res = await post('/v1/funnel', { event: 'provider_connected', provider: 'vercel' });
    expect(res.status).toBe(200);
    const row = await db.get<{ provider: string }>(`SELECT provider FROM funnel_events`);
    expect(row?.provider).toBe('vercel');
  });

  it('rejects unknown events, malformed ids, and junk bodies', async () => {
    expect((await post('/v1/funnel', { event: 'password_typed' })).status).toBe(400);
    expect((await post('/v1/funnel', { event: 'init_run', funnel_id: 'x'.repeat(65) })).status).toBe(400);
    expect((await post('/v1/funnel', { event: 'init_run', provider: 'Not A Slug!' })).status).toBe(400);
    const junk = await app.request('/v1/funnel', { method: 'POST', body: 'not json' });
    expect(junk.status).toBe(400);
    expect(await db.get(`SELECT 1 FROM funnel_events`)).toBeFalsy();
  });
});

describe('provider votes', () => {
  it('increments an allowlisted tile and reports counts', async () => {
    expect(await (await post('/v1/providers/railway/vote')).json()).toEqual({ provider: 'railway', votes: 1 });
    expect(await (await post('/v1/providers/railway/vote')).json()).toEqual({ provider: 'railway', votes: 2 });
    expect(await (await post('/v1/providers/neon/vote')).json()).toEqual({ provider: 'neon', votes: 1 });

    const res = await app.request('/v1/providers/votes');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      votes: [
        { provider: 'railway', votes: 2 },
        { provider: 'neon', votes: 1 },
      ],
    });
  });

  it('rejects anything off the allowlist (live providers included)', async () => {
    expect((await post('/v1/providers/vercel/vote')).status).toBe(400); // live, not votable
    expect((await post('/v1/providers/../../etc/vote')).status).toBe(404); // path, not a slug
    expect((await post('/v1/providers/eviltile/vote')).status).toBe(400);
    for (const p of VOTABLE_PROVIDERS) {
      expect((await post(`/v1/providers/${p}/vote`)).status).toBe(200);
    }
  });
});
