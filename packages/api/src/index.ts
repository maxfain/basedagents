import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { AppEnv } from './types/index.js';
import { D1Adapter } from './db/d1-adapter.js';
import { runBootstrapProber } from './bootstrap/prober.js';

import registerRoutes from './routes/register.js';
import agentRoutes from './routes/agents.js';
import verifyRoutes from './routes/verify.js';
import chainRoutes from './routes/chain.js';

const app = new Hono<AppEnv>();

// ─── Global Middleware ───
app.use('*', logger());
app.use('*', cors());

// ─── Database Adapter Middleware ───
// Wraps the D1 binding from Cloudflare Workers environment.
app.use('*', async (c, next) => {
  if (c.env?.DB) {
    c.set('db', new D1Adapter(c.env.DB));
  }
  await next();
});

// ─── Health Check ───
app.get('/', (c) => {
  // Redirect browsers to the frontend; return JSON for API clients
  const accept = c.req.header('Accept') ?? '';
  if (accept.includes('text/html')) {
    return c.redirect('https://basedagents.ai', 301);
  }
  return c.json({
    name: 'Agent Registry',
    version: '0.1.0',
    status: 'ok',
  });
});

app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

// ─── API Routes ───
app.route('/v1/register', registerRoutes);
app.route('/v1/agents', agentRoutes);
app.route('/v1/verify', verifyRoutes);
app.route('/v1/chain', chainRoutes);

// ─── Admin: Manual Bootstrap Probe Trigger ───
app.post('/v1/admin/bootstrap-probe', async (c) => {
  const db = c.get('db');
  if (!db) return c.json({ error: 'db_unavailable', message: 'Database not available' }, 503);
  const threshold = parseInt(c.env?.BOOTSTRAP_THRESHOLD ?? '100', 10);
  const result = await runBootstrapProber(db, threshold);
  return c.json({ ok: true, result });
});

// ─── 404 Handler ───
app.notFound((c) => {
  return c.json({ error: 'not_found', message: 'Route not found' }, 404);
});

// ─── Error Handler ───
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'internal_error', message: 'Internal server error' }, 500);
});

// ─── Cloudflare Workers Scheduled Handler (Cron) ───
const scheduled: ExportedHandlerScheduledHandler<{ DB?: D1Database; BOOTSTRAP_THRESHOLD?: string }> = async (
  _event,
  env,
  _ctx
) => {
  if (!env.DB) { console.error('[cron] No DB binding'); return; }
  const db = new D1Adapter(env.DB);
  const threshold = parseInt(env.BOOTSTRAP_THRESHOLD ?? '100', 10);
  console.log('[cron] Running bootstrap prober...');
  const result = await runBootstrapProber(db, threshold);
  console.log(`[cron] Bootstrap prober done: activated=${result.activated.length} suspended=${result.suspended.length} probed=${result.probed}`);
};

// Export for Cloudflare Workers
export default {
  fetch: app.fetch,
  scheduled,
};

// ─── Node.js Server (for local development / VPS deployment) ───
// This file is the Workers entry point. For Node.js local dev,
// use a separate entry: src/node.ts
