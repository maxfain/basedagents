import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { AppEnv } from './types/index.js';

import registerRoutes from './routes/register.js';
import agentRoutes from './routes/agents.js';
import verifyRoutes from './routes/verify.js';
import chainRoutes from './routes/chain.js';

const app = new Hono<AppEnv>();

// ─── Global Middleware ───
app.use('*', logger());
app.use('*', cors());

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

// ─── Node.js Server (for local development / VPS deployment) ───
// When running on Cloudflare Workers, this block is tree-shaken out.
const isNode = typeof globalThis.process !== 'undefined' && globalThis.process.versions?.node;

if (isNode) {
  const { serve } = await import('@hono/node-server');
  const { initDatabase } = await import('./db/index.js');
  const { mkdirSync } = await import('node:fs');

  const port = parseInt(process.env['PORT'] || '3000', 10);
  const dbPath = process.env['DATABASE_PATH'] || './data/registry.db';

  // Ensure data directory exists
  mkdirSync('./data', { recursive: true });

  // Initialize database
  initDatabase(dbPath);

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`🔑 Agent Registry API running at http://localhost:${info.port}`);
  });
}

// Export for Cloudflare Workers
export default app;
