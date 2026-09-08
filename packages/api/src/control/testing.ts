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
 *   POST /test/seed-task-delivery  claim + deliver a task as a seeded agent so
 *                            the console review flow (Tasks P0) can run without
 *                            a real agent; re-delivers when already claimed
 *
 * Mounted by the coordinator at /v1/owner.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types/index.js';
import { ControlStore } from './store.js';
import { base58Decode } from '../crypto/index.js';
import { loadTask, claimGate, deliverGate, writeDeliveryReceipt } from '../tasks/service.js';

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

const SeedDeliverySchema = z.object({
  task_id: z.string().min(1),
  summary: z.string().min(1).max(2000).optional(),
});

app.post('/test/seed-task-delivery', async (c) => {
  if (!isE2E(c.env)) return c.json({ error: 'not_found', message: 'not found' }, 404);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'invalid JSON body' }, 400);
  }
  const parsed = SeedDeliverySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'bad_request', message: 'validation failed' }, 400);
  const db = c.get('db');
  const task = await loadTask(db, parsed.data.task_id);
  if (!task) return c.json({ error: 'not_found', message: 'task not found' }, 404);

  const now = new Date().toISOString();
  let agentId = task.claimed_by_agent_id;
  if (!agentId) {
    agentId = `ag_e2e_${Math.random().toString(36).slice(2, 12)}`;
    const pub = new Uint8Array(32);
    crypto.getRandomValues(pub);
    await db.run(
      `INSERT INTO agents (id, public_key, name, description, capabilities, protocols, status)
       VALUES (?, ?, ?, 'e2e seeded deliverer', '["code"]', '["https"]', 'active')`,
      agentId, pub, 'e2e-deliverer',
    );
    if (!(await claimGate(db, task.task_id, agentId, null, now))) {
      return c.json({ error: 'conflict', message: 'task is not open' }, 409);
    }
  }
  if (!(await deliverGate(db, task.task_id, agentId, now))) {
    return c.json({ error: 'conflict', message: 'task is not claimed by the seeded agent' }, 409);
  }
  const { receipt_id } = await writeDeliveryReceipt(db, task.task_id, agentId, {
    summary: parsed.data.summary ?? 'Delivered by the e2e seeded agent',
    submission_type: 'json',
    submission_content: '{"result":"done"}',
  }, 'e2e', now);
  return c.json({ ok: true, agent_id: agentId, receipt_id });
});

export default app;
