import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { AppEnv } from './types/index.js';
import { D1Adapter } from './db/d1-adapter.js';

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

// ─── 404 Handler ───
app.notFound((c) => {
  return c.json({ error: 'not_found', message: 'Route not found' }, 404);
});

// ─── Error Handler ───
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'internal_error', message: 'Internal server error' }, 500);
});

// Export for Cloudflare Workers
export default app;

// ─── Node.js Server (for local development / VPS deployment) ───
// This file is the Workers entry point. For Node.js local dev,
// use a separate entry: src/node.ts
