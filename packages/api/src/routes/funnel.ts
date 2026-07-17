/**
 * Onboarding funnel + provider vote tiles (onboarding redesign, marketing page).
 *
 * Deliberately anonymous: no auth, no cookies, no identity. A funnel event is
 * an event name, an optional random correlation id (minted by the client for
 * one onboarding run — meaningless across runs), and an optional provider
 * slug. A vote is +1 on a fixed allowlisted slug. Everything is fire-and-
 * forget from the clients' side; abuse is rate-limited at the edge like the
 * other public endpoints and is low-stakes by construction (counters only).
 *
 *   POST /v1/funnel                    {event, funnel_id?, provider?}
 *   POST /v1/providers/:provider/vote  gray "vote for next" tile tap
 *   GET  /v1/providers/votes           tile counts for the grid
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types/index.js';

/** The funnel of the onboarding redesign, in order. */
export const FUNNEL_EVENTS = [
  'copy_command',
  'init_run',
  'mcp_config_written',
  'passkey_created',
  'provider_connected',
  'first_lease', // accepted for a future local opt-in; nothing ships it today
] as const;

/** The marketing grid's "vote for next" tiles. Live providers are not votable. */
export const VOTABLE_PROVIDERS = [
  'railway',
  'flyio',
  'cloudflare',
  'aws',
  'neon',
  'upstash',
  'anthropic',
  'openrouter',
] as const;

const FunnelSchema = z.object({
  event: z.enum(FUNNEL_EVENTS),
  funnel_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  provider: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
});

const app = new Hono<AppEnv>();

app.post('/funnel', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'invalid JSON body' }, 400);
  }
  const parsed = FunnelSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'bad_request', message: 'validation failed' }, 400);

  await c.get('db').run(
    `INSERT INTO funnel_events (event, funnel_id, provider) VALUES (?, ?, ?)`,
    parsed.data.event,
    parsed.data.funnel_id ?? null,
    parsed.data.provider ?? null,
  );
  return c.json({ ok: true });
});

app.post('/providers/:provider/vote', async (c) => {
  const provider = c.req.param('provider');
  if (!(VOTABLE_PROVIDERS as readonly string[]).includes(provider)) {
    return c.json({ error: 'bad_request', message: 'unknown provider' }, 400);
  }
  await c.get('db').run(
    `INSERT INTO provider_votes (provider, votes) VALUES (?, 1)
     ON CONFLICT(provider) DO UPDATE SET
       votes = votes + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
    provider,
  );
  const row = await c.get('db').get<{ votes: number }>(
    `SELECT votes FROM provider_votes WHERE provider = ?`, provider,
  );
  return c.json({ provider, votes: Number(row?.votes ?? 1) });
});

app.get('/providers/votes', async (c) => {
  const rows = await c.get('db').all<{ provider: string; votes: number }>(
    `SELECT provider, votes FROM provider_votes ORDER BY votes DESC, provider ASC`,
  );
  return c.json({ votes: rows.map((r) => ({ provider: r.provider, votes: Number(r.votes) })) });
});

export default app;
