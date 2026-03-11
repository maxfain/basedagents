import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { AppEnv } from './types/index.js';
import { D1Adapter } from './db/d1-adapter.js';
import { runBootstrapProber } from './bootstrap/prober.js';
import { resolveAllAgentSkills } from './skills/resolver.js';

import registerRoutes from './routes/register.js';
import agentRoutes from './routes/agents.js';
import verifyRoutes from './routes/verify.js';
import chainRoutes from './routes/chain.js';
import skillRoutes from './routes/skills.js';

const app = new Hono<AppEnv>();

// ─── CORS — explicit origin whitelist ───
const ALLOWED_ORIGINS = [
  'https://basedagents.ai',
  'https://www.basedagents.ai',
  // Cloudflare Pages preview deploys
  /^https:\/\/[a-z0-9]+\.auth-ai-web\.pages\.dev$/,
  // Local dev
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:4000',
];

// ─── In-memory rate limiter (per-isolate; acceptable for single-worker deploy) ───
// Key: `${route}:${ip}`, Value: { count, resetAt }
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
  '/v1/register/init':     { max: 5,  windowMs: 60_000 },   // 5 init attempts/min per IP
  '/v1/register/complete': { max: 5,  windowMs: 60_000 },
  '/v1/verify/submit':     { max: 20, windowMs: 60_000 },   // 20 verifications/min
  '/v1/agents/search':     { max: 60, windowMs: 60_000 },   // 60 searches/min
};

function checkRateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

// ─── Global Middleware ───
app.use('*', logger());
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return null; // no-origin (server-to-server) — allow
    for (const allowed of ALLOWED_ORIGINS) {
      if (typeof allowed === 'string' && allowed === origin) return origin;
      if (allowed instanceof RegExp && allowed.test(origin)) return origin;
    }
    return null; // reject
  },
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Timestamp'],
  exposeHeaders: ['X-RateLimit-Remaining'],
  maxAge: 86400,
}));

// ─── Rate limiting middleware ───
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const limit = RATE_LIMITS[path];
  if (limit) {
    const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown';
    const key = `${path}:${ip}`;
    if (!checkRateLimit(key, limit.max, limit.windowMs)) {
      return c.json({ error: 'rate_limited', message: 'Too many requests. Please slow down.' }, 429);
    }
  }
  await next();
});

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
app.route('/v1/skills', skillRoutes);

// ─── Admin: Manual Bootstrap Probe Trigger ───
// Protected by ADMIN_SECRET env var. Set via: wrangler secret put ADMIN_SECRET
app.post('/v1/admin/bootstrap-probe', async (c) => {
  const adminSecret = c.env?.ADMIN_SECRET;
  if (!adminSecret) {
    return c.json({ error: 'forbidden', message: 'Admin endpoint disabled — ADMIN_SECRET not configured' }, 403);
  }
  const authHeader = c.req.header('Authorization');
  if (!authHeader || authHeader !== `Bearer ${adminSecret}`) {
    return c.json({ error: 'unauthorized', message: 'Invalid admin token' }, 401);
  }
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scheduled = async (_event: unknown, env: any, _ctx: unknown) => {
  if (!env.DB) { console.error('[cron] No DB binding'); return; }
  const db = new D1Adapter(env.DB);
  const threshold = parseInt(env.BOOTSTRAP_THRESHOLD ?? '100', 10);
  console.log('[cron] Running bootstrap prober...');
  const result = await runBootstrapProber(db, threshold);
  console.log(`[cron] Bootstrap prober done: activated=${result.activated.length} suspended=${result.suspended.length} probed=${result.probed}`);

  console.log('[cron] Resolving agent skills...');
  const skillResult = await resolveAllAgentSkills(db);
  console.log(`[cron] Skill resolution done: updated=${skillResult.updated}`);
};

// Export for Cloudflare Workers
export default {
  fetch: app.fetch,
  scheduled,
};

// ─── Node.js Server (for local development / VPS deployment) ───
// This file is the Workers entry point. For Node.js local dev,
// use a separate entry: src/node.ts
