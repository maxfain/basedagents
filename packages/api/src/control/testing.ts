/**
 * E2E-only support endpoints (coder brief Task 2).
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * Every route here 404s unless the deployment was explicitly started with
 * E2E=1 — the guard is the environment, not auth: outside an E2E run these
 * endpoints simply do not exist. Production never sets E2E.
 *
 *   GET  /test/outbox        read captured emails (the E2E mailer writes to
 *                            test_outbox instead of calling Resend — the
 *                            Playwright suite reads recovery magic links here)
 *   POST /test/seed-agent    insert a registry agent row so delegation /
 *                            approval flows can run without the full
 *                            proof-of-work registration ceremony
 *
 * Mounted by the coordinator at /v1/owner.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types/index.js';
import { ControlStore } from './store.js';
import { base58Decode } from '../crypto/index.js';

function isE2E(env: unknown): boolean {
  return ((env ?? {}) as Record<string, string | undefined>).E2E === '1';
}

function getStore(c: Context<AppEnv>): ControlStore {
  return new ControlStore(c.get('db'));
}

const SeedAgentSchema = z.object({
  agent_id: z.string().min(1),
  public_key_b58: z.string().min(1),
  name: z.string().optional(),
});

const app = new Hono<AppEnv>();

app.get('/test/outbox', async (c) => {
  if (!isE2E(c.env)) return c.json({ error: 'not_found', message: 'not found' }, 404);
  const recipient = c.req.query('recipient');
  return c.json({ messages: await getStore(c).listTestOutbox(recipient) });
});

app.post('/test/seed-agent', async (c) => {
  if (!isE2E(c.env)) return c.json({ error: 'not_found', message: 'not found' }, 404);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'invalid JSON body' }, 400);
  }
  const parsed = SeedAgentSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'bad_request', message: 'validation failed' }, 400);

  let pub: Uint8Array;
  try {
    pub = base58Decode(parsed.data.public_key_b58);
  } catch {
    return c.json({ error: 'bad_request', message: 'invalid public key' }, 400);
  }
  const db = c.get('db');
  // Full NOT NULL column set of the real registry schema — and no OR IGNORE:
  // a silently-skipped insert here surfaces later as a baffling FK error on
  // the delegation. A duplicate id is the only tolerated failure.
  try {
    await db.run(
      `INSERT INTO agents (id, public_key, name, description, capabilities, protocols, status)
       VALUES (?, ?, ?, 'e2e seeded agent', '[]', '["https"]', 'active')`,
      parsed.data.agent_id,
      pub,
      parsed.data.name ?? 'e2e-agent',
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('UNIQUE')) {
      return c.json({ error: 'seed_failed', message: msg }, 400);
    }
  }
  return c.json({ ok: true, agent_id: parsed.data.agent_id });
});

export default app;
