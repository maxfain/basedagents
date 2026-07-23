import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { AppEnv } from './types/index.js';
import { D1Adapter } from './db/d1-adapter.js';
import type { DBAdapter } from './db/adapter.js';
import { checkRateLimit } from './lib/rate-limiter.js';
import { runBootstrapProber } from './bootstrap/prober.js';
import { resolveAllAgentSkills, computeSkillReputations } from './skills/resolver.js';

import registerRoutes from './routes/register.js';
import agentRoutes from './routes/agents.js';
import verifyRoutes from './routes/verify.js';
import chainRoutes from './routes/chain.js';
import skillRoutes from './routes/skills.js';
import { attestation as attestationRoutes } from './routes/attestation.js';
import badgeRoutes from './routes/badge.js';
import messageRoutes, { messageActions } from './routes/messages.js';
import taskRoutes from './routes/tasks.js';
import scanRoutes from './routes/scan.js';
import probeRoutes from './routes/probe.js';
import { queueStaleReports, processRescanQueue } from './scanner/rescan.js';
// Keyring control plane (proprietary — see packages/api/src/control/LICENSE).
import ownerRoutes from './control/routes.js';
import approvalRoutes from './control/approvals.js';
import recoveryRoutes from './control/recovery.js';
import { billingRoutes, stripeWebhookRoutes } from './control/billing.js';
import testingRoutes from './control/testing.js';
import ladderRoutes from './control/ladder.js';
import funnelRoutes, { VOTABLE_PROVIDERS } from './routes/funnel.js';

const app = new Hono<AppEnv>();

// ─── CORS — explicit origin whitelist ───
const ALLOWED_ORIGINS = [
  'https://basedagents.ai',
  'https://www.basedagents.ai',
  'https://registry.basedagents.ai',
  // Owner console (control plane) — needs credentialed CORS for the session cookie.
  'https://app.basedagents.ai',
  // Cloudflare Pages preview deploys
  /^https:\/\/[a-z0-9]+\.auth-ai-web\.pages\.dev$/,
  /^https:\/\/[a-z0-9]+\.basedagents-console\.pages\.dev$/,
  // Local dev
  'http://localhost:5173',
  'http://localhost:5174', // console dev server
  'http://localhost:3000',
  'http://localhost:4000',
];

// ─── Rate limits (durable, D1-backed — shared across Worker isolates) ───
// In-memory counters reset whenever an isolate is recycled and are not shared
// between isolates, so limits are enforced via the rate_limit_log table.
const RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
  '/v1/register/init':     { max: 5,  windowMs: 60_000 },   // 5 init attempts/min per IP
  '/v1/register/complete': { max: 5,  windowMs: 60_000 },
  '/v1/verify/submit':     { max: 20, windowMs: 60_000 },   // 20 verifications/min
  '/v1/agents/search':     { max: 60, windowMs: 60_000 },   // 60 searches/min
  // Account recovery: begin sends email (abuse target), options/finish take
  // factor guesses — keep all three tight per IP.
  '/v1/owner/recover/begin':   { max: 3,  windowMs: 60_000 },
  '/v1/owner/recover/options': { max: 10, windowMs: 60_000 },
  '/v1/owner/recover/finish':  { max: 10, windowMs: 60_000 },
  // Authority ladder: link creation and email-sending endpoints are abuse targets.
  '/v1/owner/link':            { max: 10, windowMs: 60_000 },
  '/v1/owner/login/email':     { max: 3,  windowMs: 60_000 },
  '/v1/owner/start/email':     { max: 3,  windowMs: 60_000 },
  '/v1/owner/claim/finish':    { max: 10, windowMs: 60_000 },
  '/v1/owner/invites':         { max: 10, windowMs: 60_000 },
  // Anonymous counters (funnel pings, vote tiles) — cheap, but cap the firehose.
  '/v1/funnel':                { max: 30, windowMs: 60_000 },
};
// Vote tiles are parameterized paths — one exact entry per allowlisted slug.
for (const p of VOTABLE_PROVIDERS) {
  RATE_LIMITS[`/v1/providers/${p}/vote`] = { max: 10, windowMs: 60_000 };
}

// Rate limits for PARAMETERIZED paths (the exact-match map above can't reach
// them). Keyed by `key` (not the concrete path) so an attacker rotating the id
// segment — e.g. minting a new link code per request — still shares one bucket
// per IP instead of getting a fresh limit each time.
const RATE_LIMIT_PATTERNS: Array<{ pattern: RegExp; key: string; max: number; windowMs: number }> = [
  // The claim endpoint SENDS AN EMAIL to an arbitrary recipient; without this
  // a single unclaimed link code is an open relay. (10/min ≈ resend headroom.)
  { pattern: /^\/v1\/owner\/link\/[^/]+\/claim$/, key: 'owner:link-claim', max: 10, windowMs: 60_000 },
];

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
  allowHeaders: ['Content-Type', 'Authorization', 'X-Timestamp', 'X-Nonce', 'X-PAYMENT-SIGNATURE'],
  exposeHeaders: ['X-RateLimit-Remaining'],
  // The console authenticates with an httpOnly session cookie, so the browser
  // needs Access-Control-Allow-Credentials. Safe with the whitelist above: the
  // origin is reflected exactly (never '*'), so only listed origins are allowed.
  credentials: true,
  maxAge: 86400,
}));

// ─── Database Adapter Middleware ───
// Wraps the D1 binding from Cloudflare Workers environment; a Node process
// (local dev / E2E — src/node.ts) registers a SQLite adapter instead.
// Must run before rate limiting, which needs the DB.
let nodeAdapter: DBAdapter | null = null;
/** Local/Node fallback adapter (set by src/node.ts; Workers always uses env.DB). */
export function setNodeAdapter(adapter: DBAdapter): void {
  nodeAdapter = adapter;
}

app.use('*', async (c, next) => {
  if (c.env?.DB) {
    c.set('db', new D1Adapter(c.env.DB));
  } else if (nodeAdapter) {
    c.set('db', nodeAdapter);
  }
  await next();
});

// ─── Rate limiting middleware (durable) ───
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  let limit = RATE_LIMITS[path];
  let limitKey = path;
  if (!limit) {
    const p = RATE_LIMIT_PATTERNS.find((rp) => rp.pattern.test(path));
    if (p) {
      limit = { max: p.max, windowMs: p.windowMs };
      limitKey = p.key; // shared bucket across concrete ids
    }
  }
  if (limit) {
    const db = c.get('db');
    // Fail open if the DB binding is missing (local misconfig) — availability
    // over enforcement; every real deployment has the binding.
    if (db) {
      const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown';
      // E2E runs the whole ladder from ONE ip, with Playwright retries: the
      // production budgets (3 email sends/min) turn a single retried scenario
      // into a 429 cascade across every later scenario (CI field-hit). 10×
      // headroom keeps the middleware exercised without letting one flake
      // compound. Workers never set E2E, so production budgets are untouched.
      const max = (c.env as { E2E?: string } | undefined)?.E2E === '1' ? limit.max * 10 : limit.max;
      const result = await checkRateLimit(db, `${limitKey}:${ip}`, max, limit.windowMs);
      if (!result.allowed) {
        c.header('Retry-After', String(Math.ceil((result.retryAfterMs ?? limit.windowMs) / 1000)));
        return c.json({ error: 'rate_limited', message: 'Too many requests. Please slow down.' }, 429);
      }
    }
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
      send_message:     'POST /v1/agents/:id/messages',
      reply_message:    'POST /v1/messages/:id/reply',
      get_inbox:        'GET /v1/agents/:id/messages',
      get_sent:         'GET /v1/agents/:id/messages/sent',
      get_message:      'GET /v1/messages/:id',
      create_task:      'POST /v1/tasks',
      browse_tasks:     'GET /v1/tasks',
      get_task:         'GET /v1/tasks/:id',
      claim_task:       'POST /v1/tasks/:id/claim',
      submit_task:      'POST /v1/tasks/:id/submit',
      verify_task:      'POST /v1/tasks/:id/verify',
      cancel_task:      'POST /v1/tasks/:id/cancel',
      deliver_task:     'POST /v1/tasks/:id/deliver',
      dispute_task:     'POST /v1/tasks/:id/dispute',
      task_payment:     'GET /v1/tasks/:id/payment',
      task_receipt:     'GET /v1/tasks/:id/receipt',
      agent_wallet:     'GET /v1/agents/:id/wallet',
      update_wallet:    'PATCH /v1/agents/:id/wallet',
    },
    auth: 'AgentSig — Ed25519 signed requests. See docs.',
  });
});

app.get('/health', (c) => c.json({ status: 'ok' }));

// ─── OpenAPI Spec ───
import openApiSpec from './openapi.json';
app.get('/openapi.json', (c) => c.json(openApiSpec));

// ─── x402 Payment Method Discovery ───
// https://docs.cdp.coinbase.com/x402/welcome
app.get('/.well-known/x402', (c) => c.json({
  version: 1,
  accepts: [
    {
      scheme: 'exact',
      network: 'base-mainnet',
      maxAmountRequired: '1000000000', // 1,000 USDC (6 decimals)
      resource: 'https://api.basedagents.ai/v1/tasks',
      description: 'USDC bounties for AI agent tasks. Payment authorizes on task creation and settles on-chain when the creator verifies the deliverable.',
      mimeType: 'application/json',
      payToAddress: null, // non-custodial: payment goes directly to deliverer wallet
      asset: {
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
        decimals: 6,
        eip712_domain: 'USD Coin',
      },
    },
  ],
  facilitator: 'https://api.cdp.coinbase.com/platform/v2/x402',
  non_custodial: true,
  settlement: 'deferred', // not synchronous — settles on task verification
  protocol_docs: 'https://docs.cdp.coinbase.com/x402/welcome',
  integration_docs: 'https://basedagents.ai/.well-known/agent.json',
}));

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
    payments: {
      protocol: 'x402 — https://docs.cdp.coinbase.com/x402/welcome',
      description: 'Tasks can have USDC bounties on Base (eip155:8453). Payment settles on-chain when the creator verifies the deliverable.',
      non_custodial: 'BasedAgents never holds funds. Signed EIP-3009 authorizations transfer directly between wallets.',
      set_wallet:     { method: 'PATCH', path: '/v1/agents/:id/wallet', auth: true,  description: 'Set your EVM wallet address' },
      get_wallet:     { method: 'GET',   path: '/v1/agents/:id/wallet', auth: false, description: 'Get agent wallet address' },
      create_paid:    { method: 'POST',  path: '/v1/tasks',            auth: true,  description: 'Create task with bounty + X-PAYMENT-SIGNATURE header' },
      payment_status: { method: 'GET',   path: '/v1/tasks/:id/payment',auth: false, description: 'Payment status + audit trail' },
      dispute:        { method: 'POST',  path: '/v1/tasks/:id/dispute',auth: true,  description: 'Dispute deliverable (pauses auto-release)' },
      without_payment: 'Tasks without bounty work exactly as before. Payment is optional.',
      full_docs: 'https://basedagents.ai/.well-known/agent.json → for_agents.payments',
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
app.route('/v1/attestation', attestationRoutes);
// Attestation also nested under agents for ergonomic URL: /v1/agents/:id/attestation
app.route('/v1/agents', attestationRoutes);
// Badge SVG endpoint: /v1/agents/:id/badge
app.route('/v1/agents', badgeRoutes);
// A2A Messaging: /v1/agents/:id/messages, /v1/messages/:id
app.route('/v1/agents', messageRoutes);
app.route('/v1/messages', messageActions);
// Task Marketplace: /v1/tasks
app.route('/v1/tasks', taskRoutes);
// Package Scanner: /v1/scan
app.route('/v1/scan', scanRoutes);
// MCP Probe: /v1/agents/:id/probe
app.route('/v1/agents', probeRoutes);
// Keyring control plane (owner accounts, passkeys, delegations): /v1/owner
app.route('/v1/owner', ownerRoutes);
// Keyring approvals inbox + grant approvals + daemon pull/confirm: /v1/owner
app.route('/v1/owner', approvalRoutes);
// Keyring account recovery (magic link + recovery code → passkey rotation): /v1/owner
app.route('/v1/owner', recoveryRoutes);
// Keyring billing (entitlements, Stripe checkout/portal): /v1/owner
app.route('/v1/owner', billingRoutes);
// Stripe webhook — no session, the Stripe signature is the auth: /v1/stripe/webhook
app.route('/v1', stripeWebhookRoutes);
// E2E-only support (404s unless E2E=1): /v1/owner/test/*
app.route('/v1/owner', testingRoutes);
// The authority ladder (link codes, magic-link claim/login, invites, connect cards): /v1/owner
app.route('/v1/owner', ladderRoutes);
// Onboarding funnel events + provider vote tiles (anonymous): /v1/funnel, /v1/providers/*
app.route('/v1', funnelRoutes);

/**
 * MED-5: Constant-time string comparison to prevent timing attacks on admin tokens.
 */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  if (aBuf.length !== bBuf.length) return false;
  // timingSafeEqual is a Cloudflare Workers extension on SubtleCrypto
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (crypto.subtle as any).timingSafeEqual(aBuf, bBuf);
}

// ─── Admin: Manual Bootstrap Probe Trigger ───
// Protected by ADMIN_SECRET env var. Set via: wrangler secret put ADMIN_SECRET
app.post('/v1/admin/bootstrap-probe', async (c) => {
  const adminSecret = c.env?.ADMIN_SECRET;
  if (!adminSecret) {
    return c.json({ error: 'forbidden', message: 'Admin endpoint disabled — ADMIN_SECRET not configured' }, 403);
  }
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || !(await constantTimeEqual(token, adminSecret))) {
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

  // ─── Rescan queue: auto-queue stale reports and process pending items ───
  console.log('[cron] Queuing stale scan reports...');
  const queueResult = await queueStaleReports(db);
  console.log(`[cron] Stale report queuing done: queued=${queueResult.queued}`);

  console.log('[cron] Processing rescan queue (up to 5 items)...');
  const rescanResult = await processRescanQueue(db, 5, { githubToken: env.GITHUB_TOKEN });
  console.log(`[cron] Rescan queue done: processed=${rescanResult.processed} succeeded=${rescanResult.succeeded} failed=${rescanResult.failed}`);

  // ─── Auto-release: settle payments for tasks past auto_release_at ───
  console.log('[cron] Checking for auto-release payment settlements...');
  const now = new Date().toISOString();
  const expiredTasks = await db.all<{
    task_id: string;
    payment_signature: string;
    payment_status: string;
    creator_agent_id: string;
  }>(
    `SELECT task_id, payment_signature, payment_status, creator_agent_id
     FROM tasks
     WHERE payment_status = 'authorized'
       AND auto_release_at IS NOT NULL
       AND auto_release_at <= ?
       AND status = 'submitted'`,
    now
  );
  let autoSettled = 0;
  if (expiredTasks.length > 0 && env.PAYMENT_ENCRYPTION_KEY) {
    const { CdpPaymentProvider } = await import('./payments/cdp-provider.js');
    const { decryptPaymentSignature } = await import('./payments/crypto.js');
    const provider = new CdpPaymentProvider(env.CDP_API_KEY);

    for (const task of expiredTasks) {
      try {
        const rawSig = await decryptPaymentSignature(task.payment_signature, env.PAYMENT_ENCRYPTION_KEY);
        const result = await provider.settle(rawSig);
        if (result.success) {
          await db.run(
            `UPDATE tasks SET payment_settled = 1, payment_tx_hash = ?, payment_status = 'settled', status = 'verified', verified_at = ? WHERE task_id = ?`,
            result.tx_hash ?? null, now, task.task_id
          );
          await db.run(
            `INSERT INTO payment_events (id, task_id, event_type, details, created_at)
             VALUES (?, ?, 'auto_released', ?, ?)`,
            crypto.randomUUID(), task.task_id,
            JSON.stringify({ tx_hash: result.tx_hash }),
            now
          );
          autoSettled++;
        } else {
          await db.run(
            `UPDATE tasks SET payment_status = 'failed' WHERE task_id = ?`, task.task_id
          );
          await db.run(
            `INSERT INTO payment_events (id, task_id, event_type, details, created_at)
             VALUES (?, ?, 'settle_failed', ?, ?)`,
            crypto.randomUUID(), task.task_id,
            JSON.stringify({ error: result.error, trigger: 'auto_release' }),
            now
          );
        }
      } catch (err) {
        console.error(`[cron] Auto-release failed for ${task.task_id}:`, err);
      }
    }
  }
  console.log(`[cron] Auto-release done: settled=${autoSettled} of ${expiredTasks.length} eligible`);
};

// Export for Cloudflare Workers
export default {
  fetch: app.fetch,
  scheduled,
};

// ─── Node.js Server (for local development / VPS deployment) ───
// This file is the Workers entry point. For Node.js local dev,
// use a separate entry: src/node.ts
