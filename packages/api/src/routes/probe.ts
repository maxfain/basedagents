import { Hono } from 'hono';
import type { AppEnv } from '../types/index.js';

const probe = new Hono<AppEnv>();

// ─── Allowed MCP methods ───
const ALLOWED_METHODS = new Set([
  'tools/list',
  'resources/list',
  'prompts/list',
  'tools/call',
]);

// ─── In-memory rate limiter: 10 req/min per IP ───
const probeRateLimiter = new Map<string, { count: number; resetAt: number }>();

function checkProbeRateLimit(ip: string): boolean {
  const now = Date.now();
  const key = `probe:${ip}`;
  const entry = probeRateLimiter.get(key);
  if (!entry || now > entry.resetAt) {
    probeRateLimiter.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}

/**
 * POST /v1/agents/:id/probe
 *
 * Proxy: forward an MCP JSON-RPC request to the agent's contact_endpoint.
 * Avoids browser CORS issues; allows server-side rate limiting + logging.
 */
probe.post('/:id/probe', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown';

  // Rate limit
  if (!checkProbeRateLimit(ip)) {
    return c.json({ error: 'rate_limited', message: 'Too many requests. Try again in a minute.' }, 429);
  }

  const db = c.get('db');
  if (!db) {
    return c.json({ error: 'db_unavailable', message: 'Database not available' }, 503);
  }

  const agentId = c.req.param('id');

  // Parse body
  let method: string;
  let params: Record<string, unknown>;
  try {
    const body = await c.req.json<{ method: unknown; params?: unknown }>();
    if (typeof body.method !== 'string') {
      return c.json({ error: 'bad_request', message: 'method must be a string' }, 400);
    }
    method = body.method;
    params = (body.params && typeof body.params === 'object' && !Array.isArray(body.params))
      ? (body.params as Record<string, unknown>)
      : {};
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  }

  // Method whitelist
  if (!ALLOWED_METHODS.has(method)) {
    return c.json({
      error: 'method_not_allowed',
      message: `Method '${method}' is not allowed. Allowed: ${[...ALLOWED_METHODS].join(', ')}`,
    }, 400);
  }

  // Fetch agent from DB
  const agent = await db.get<{ contact_endpoint: string | null }>(
    'SELECT contact_endpoint FROM agents WHERE id = ?',
    agentId
  );

  if (!agent) {
    return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  }

  if (!agent.contact_endpoint) {
    return c.json({
      error: 'no_endpoint',
      message: 'Agent has no contact endpoint configured',
    }, 400);
  }

  // Forward JSON-RPC request to agent endpoint
  const rpcPayload = {
    jsonrpc: '2.0',
    id: 1,
    method,
    params,
  };

  const t0 = Date.now();
  let agentRes: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      agentRes = await fetch(agent.contact_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rpcPayload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    if (isTimeout) {
      return c.json({ error: 'timeout', message: 'Agent endpoint timed out after 10s' }, 504);
    }
    return c.json({ error: 'fetch_error', message: `Failed to reach agent endpoint: ${String(err)}` }, 502);
  }

  const responseTimeMs = Date.now() - t0;
  const statusCode = agentRes.status;

  let body: unknown;
  try {
    body = await agentRes.json();
  } catch {
    const text = await agentRes.text().catch(() => '');
    body = text || null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c.json({
    ok: agentRes.ok,
    response_time_ms: responseTimeMs,
    status_code: statusCode,
    body,
  }, (agentRes.ok ? 200 : statusCode) as any);
});

export default probe;
