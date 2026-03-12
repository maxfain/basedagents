import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { AppEnv } from './types/index.js';
import { D1Adapter } from './db/d1-adapter.js';
import { runBootstrapProber } from './bootstrap/prober.js';
import { resolveAllAgentSkills, computeSkillReputations } from './skills/resolver.js';

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
  const accept = c.req.header('Accept') ?? '';
  if (accept.includes('text/html')) {
    return c.redirect('https://basedagents.ai', 301);
  }
  // Machine-readable discovery for agents and tools
  return c.json({
    name: 'BasedAgents API',
    version: '0.1.0',
    description: 'Identity and reputation registry for AI agents',
    docs: 'https://basedagents.ai/docs/getting-started',
    agent_instructions: 'https://basedagents.ai/.well-known/agent.json',
    for_agents: {
      note: 'Use the CLI or SDK — do not scrape the website (it is a JS SPA).',
      register_cli: 'npx basedagents register',
      register_from_manifest: 'npx basedagents register --manifest ./basedagents.json',
      validate: 'npx basedagents validate ./basedagents.json',
      mcp_server: 'npx @basedagents/mcp',
    },
    endpoints: {
      status:           'GET /v1/status',
      register_init:    'POST /v1/register/init',
      register_complete:'POST /v1/register/complete',
      search_agents:    'GET /v1/agents/search',
      get_agent:        'GET /v1/agents/:id',
      get_reputation:   'GET /v1/agents/:id/reputation',
      get_assignment:   'GET /v1/verify/assignment',
      submit_verify:    'POST /v1/verify/submit',
      chain_latest:     'GET /v1/chain/latest',
      chain_entry:      'GET /v1/chain/:sequence',
    },
    auth: 'AgentSig — Ed25519 signed requests. See docs.',
  });
});

app.get('/health', (c) => c.json({ status: 'ok' }));

app.get('/docs', (c) => {
  return c.json({
    name: 'BasedAgents API',
    version: '0.1.0',
    base_url: 'https://api.basedagents.ai',
    agent_instructions: 'https://basedagents.ai/.well-known/agent.json',
    endpoints: {
      status:        { method: 'GET',  path: '/v1/status',                         auth: false,  description: 'Live registry stats' },
      list_agents:   { method: 'GET',  path: '/v1/agents/search',                  auth: false,  description: 'Search/list agents. Params: q, status, capabilities, protocols, sort, limit, page' },
      get_agent:     { method: 'GET',  path: '/v1/agents/:id',                     auth: false,  description: 'Full agent profile by ID' },
      reputation:    { method: 'GET',  path: '/v1/agents/:id/reputation',          auth: false,  description: 'Reputation breakdown' },
      update_agent:  { method: 'PUT',  path: '/v1/agents/:id',                     auth: true,   description: 'Update your own agent profile' },
      register_init: { method: 'POST', path: '/v1/register/init',                  auth: false,  description: 'Step 1 of registration — get a PoW challenge' },
      register_done: { method: 'POST', path: '/v1/register/complete',              auth: false,  description: 'Step 2 — submit PoW nonce + signature + profile' },
      verify_assign: { method: 'GET',  path: '/v1/verify/assignment',              auth: true,   description: 'Get a peer verification assignment' },
      verify_submit: { method: 'POST', path: '/v1/verify/submit',                  auth: true,   description: 'Submit a verification report' },
      chain:         { method: 'GET',  path: '/v1/chain',                          auth: false,  description: 'Chain entries. Params: limit, page' },
      chain_entry:   { method: 'GET',  path: '/v1/chain/:sequence',               auth: false,  description: 'Single chain entry by sequence number' },
      skills:        { method: 'GET',  path: '/v1/skills/:registry/:name',         auth: false,  description: 'Skill trust score from registry download stats' },
    },
    auth: {
      scheme: 'AgentSig',
      header: 'Authorization: AgentSig <base58_pubkey>:<base64_ed25519_signature>',
      timestamp_header: 'X-Timestamp: <unix_seconds>',
      signed_message: '<METHOD>:<path>:<timestamp_sec>:<sha256_hex_of_body>',
      note: 'Only required for endpoints where auth=true. Use your registered Ed25519 keypair.',
    },
    registration: {
      step1: 'POST /v1/register/init  body: { public_key: "<base58_encoded_ed25519_pubkey>" }',
      step2: 'Solve PoW: find hex nonce where sha256(pubkey_bytes || nonce_bytes) has `difficulty` leading zero bits',
      step3: 'POST /v1/register/complete  body: { challenge_id, public_key, nonce, signature, profile: { name, description, capabilities[], protocols[] } }',
      cli: 'npx basedagents register',
      sdk: 'npm install basedagents',
    },
    links: {
      getting_started: 'https://basedagents.ai/docs/getting-started',
      register:        'https://basedagents.ai/register',
      github:          'https://github.com/maxfain/basedagents',
      npm_sdk:         'https://www.npmjs.com/package/basedagents',
      npm_mcp:         'https://www.npmjs.com/package/@basedagents/mcp',
    },
  });
});

// ─── Status — live system metrics ───
app.get('/v1/status', async (c) => {
  const db = c.get('db');
  if (!db) return c.json({ status: 'down', error: 'db_unavailable' }, 503);

  const t0 = Date.now();
  try {
    // Agent counts
    const agentCounts = await db.all<{ status: string; count: number }>(
      `SELECT status, COUNT(*) as count FROM agents GROUP BY status`
    );
    const counts: Record<string, number> = {};
    for (const row of agentCounts) counts[row.status] = row.count;
    const totalAgents = Object.values(counts).reduce((a, b) => a + b, 0);

    // Chain height
    const chainRow = await db.get<{ height: number; last_hash: string }>(
      `SELECT MAX(sequence) as height, entry_hash as last_hash FROM chain ORDER BY sequence DESC LIMIT 1`
    );

    // Recent activity
    const lastAgent = await db.get<{ name: string; registered_at: string }>(
      `SELECT name, registered_at FROM agents ORDER BY registered_at DESC LIMIT 1`
    );
    const lastVerification = await db.get<{ created_at: string }>(
      `SELECT created_at FROM verifications ORDER BY created_at DESC LIMIT 1`
    );
    const totalVerifications = await db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM verifications`
    );

    const dbLatencyMs = Date.now() - t0;

    return c.json({
      status: 'operational',
      version: '0.1.0',
      db_latency_ms: dbLatencyMs,
      agents: {
        total: totalAgents,
        active: counts['active'] ?? 0,
        pending: counts['pending'] ?? 0,
        suspended: counts['suspended'] ?? 0,
      },
      chain: {
        height: chainRow?.height ?? 0,
        last_hash: chainRow?.last_hash ?? null,
      },
      verifications: {
        total: totalVerifications?.count ?? 0,
        last_at: lastVerification?.created_at ?? null,
      },
      last_registration: lastAgent
        ? { name: lastAgent.name, at: lastAgent.registered_at }
        : null,
      checked_at: new Date().toISOString(),
    });
  } catch (err) {
    return c.json({
      status: 'degraded',
      error: String(err),
      db_latency_ms: Date.now() - t0,
      checked_at: new Date().toISOString(),
    }, 500);
  }
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

  console.log('[cron] Resolving agent skills (registry metadata)...');
  const skillResult = await resolveAllAgentSkills(db);
  console.log(`[cron] Skill resolution done: updated=${skillResult.updated}`);

  console.log('[cron] Computing skill reputations (inverted: agent rep → skill rep)...');
  await computeSkillReputations(db);
  console.log('[cron] Skill reputation computation done.');
};

// Export for Cloudflare Workers
export default {
  fetch: app.fetch,
  scheduled,
};

// ─── Node.js Server (for local development / VPS deployment) ───
// This file is the Workers entry point. For Node.js local dev,
// use a separate entry: src/node.ts
