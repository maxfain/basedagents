/**
 * Task marketplace routes — the AGENT (AgentSig) route family.
 *
 * State transitions live in tasks/service.ts (one conditional UPDATE each);
 * settlement lives in payments/settle.ts. This file only parses requests,
 * answers 404/403/409 from the row it read, calls the gate, and runs the
 * side effects after a win. The human-owner route family (control/tasks.ts)
 * shares the same service.
 *
 * Payment model (Tasks P0, spec section 2): a bounty is DECLARED at creation
 * and AUTHORIZED at accept time — the buyer signs an EIP-3009 transfer to the
 * deliverer's wallet only after seeing the work. BasedAgents never holds
 * funds. Payments fail closed: without TASK_PAYMENTS_ENABLED + CDP secrets a
 * bounty task cannot be created and a paid accept answers 503.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types/index.js';
import { CreateTaskSchema, SubmitDeliverableSchema, DeliverTaskSchema, TaskQuerySchema } from '../types/index.js';
import type { DBAdapter } from '../db/adapter.js';
import { agentAuth } from '../middleware/auth.js';
import { bytesToHex } from '../crypto/index.js';
import { generatePublicId } from '../lib/ids.js';
import { paymentProviderFor } from '../payments/index.js';
import { encryptPaymentSignature } from '../payments/crypto.js';
import {
  decodePaymentHeader, buildRequirements, buildPaymentRequired, encodeB64Json, localPrechecks, PaymentMalformed, isNetwork,
} from '../payments/x402.js';
import { settleTask, reauthPermitted, wireSettleResponse, REAUTH_CLASSES } from '../payments/settle.js';
import {
  type Actor, type TaskRow, loadTask, creatorMatches, logPaymentEvent, recordFunnel, taskChainEntry, hashCanonical,
  agentTarget, creatorTarget, sendWebhook, recomputeReputation, publicTaskShape, paymentView, bountyView, creatorSqlParts,
  claimGate, deliverGate, acceptUnpaidGate, revisionGate, disputeGate, cancelGate, cancelRefusal, afterAccept,
  notifyMatchingAgents, writeDeliveryReceipt, MAX_REVISIONS,
} from '../tasks/service.js';

const tasks = new Hono<AppEnv>();

const PAYMENT_HEADER = 'PAYMENT-SIGNATURE';
/** Accepted for one release; logged so the deprecation is visible (D8). */
const LEGACY_PAYMENT_HEADER = 'X-PAYMENT-SIGNATURE';
const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

const AcceptBodySchema = z.object({ note: z.string().max(2000).optional() }).passthrough();
const RevisionBodySchema = z.object({ note: z.string().min(1).max(2000) }).passthrough();
const DisputeBodySchema = z.object({ reason: z.string().min(1).max(2000) }).passthrough();
const CancelBodySchema = z.object({ reason: z.string().max(2000).optional() }).passthrough();

type Ctx = Context<AppEnv>;

async function readJson(c: Ctx): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const text = await c.req.text();
  if (!text.trim()) return { ok: true, body: {} };
  try { return { ok: true, body: JSON.parse(text) }; } catch { return { ok: false }; }
}

function agentSigFromHeader(c: Ctx): string | null {
  const authHeader = c.req.header('Authorization') ?? '';
  return authHeader.startsWith('AgentSig ') ? authHeader.split(':').slice(1).join(':') : null;
}

function paymentHeader(c: Ctx): string | undefined {
  const canonical = c.req.header(PAYMENT_HEADER);
  if (canonical) return canonical;
  const legacy = c.req.header(LEGACY_PAYMENT_HEADER);
  if (legacy) console.warn(`[payments] ${LEGACY_PAYMENT_HEADER} is deprecated; send ${PAYMENT_HEADER}`);
  return legacy;
}

async function delivererWallet(db: DBAdapter, agentId: string | null): Promise<{ address: string; network: string | null } | null> {
  if (!agentId) return null;
  const row = await db.get<{ wallet_address: string | null; wallet_network: string | null }>(
    'SELECT wallet_address, wallet_network FROM agents WHERE id = ?', agentId,
  );
  if (!row?.wallet_address || !WALLET_RE.test(row.wallet_address)) return null;
  return { address: row.wallet_address, network: row.wallet_network };
}

/**
 * POST /v1/tasks — Create a task. A bounty is declared here, never paid here.
 */
tasks.post('/', agentAuth, async (c) => {
  const creatorId = c.get('agentId') as string;
  const db = c.get('db');

  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  const parsed = CreateTaskSchema.safeParse(json.body);
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const creator = await db.get<{ id: string; name: string; status: string }>(
    'SELECT id, name, status FROM agents WHERE id = ?', creatorId,
  );
  if (!creator || creator.status !== 'active') {
    return c.json({ error: 'forbidden', message: 'Agent must be active to create tasks' }, 403);
  }

  if (paymentHeader(c)) {
    return c.json({
      error: 'payment_not_expected',
      message: 'Payment is authorized when you accept the deliverable, not when you post the task. Declare the bounty in the body and omit the payment header.',
    }, 400);
  }

  const bounty = parsed.data.bounty;
  if (bounty && !paymentProviderFor(c.env)) {
    return c.json({
      error: 'payments_unavailable',
      message: 'Bounties are not enabled on this registry yet. Post the task without a bounty, or check GET /v1/status -> payments.',
    }, 503);
  }

  const taskId = generatePublicId('task');
  const now = new Date().toISOString();
  const reqCaps = parsed.data.required_capabilities ?? null;
  const paymentStatus = bounty ? 'pending' : 'none';

  await db.run(
    `INSERT INTO tasks (task_id, creator_agent_id, creator_kind, title, description, category, required_capabilities,
       expected_output, output_format, status, created_at, proposer_signature,
       bounty_amount, bounty_token, bounty_network, payment_status)
     VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
    taskId, creatorId, parsed.data.title, parsed.data.description, parsed.data.category ?? null,
    reqCaps ? JSON.stringify(reqCaps) : null, parsed.data.expected_output ?? null, parsed.data.output_format,
    now, agentSigFromHeader(c),
    bounty?.amount ?? null, bounty?.token ?? null, bounty?.network ?? null, paymentStatus,
  );

  if (bounty) {
    await logPaymentEvent(db, taskId, 'bounty_declared', { amount_atomic: bounty.amount, token: bounty.token, network: bounty.network }, now);
  }
  await recordFunnel(db, 'task_posted', taskId, 'agent');

  const bountyOut = bountyView({ bounty_amount: bounty?.amount ?? null, bounty_token: bounty?.token ?? null, bounty_network: bounty?.network ?? null });

  await notifyMatchingAgents(db, {
    task_id: taskId, title: parsed.data.title, description: parsed.data.description, category: parsed.data.category ?? null,
    required_capabilities: reqCaps, output_format: parsed.data.output_format, bounty: bountyOut,
  }, creatorId);

  const response: Record<string, unknown> = { ok: true, task_id: taskId, status: 'open', payment_status: paymentStatus };
  if (bountyOut) response.bounty = bountyOut;
  return c.json(response);
});

/**
 * GET /v1/tasks — Browse/search tasks (public, no auth)
 */
tasks.get('/', async (c) => {
  const db = c.get('db');

  const query = TaskQuerySchema.safeParse({
    status: c.req.query('status'),
    category: c.req.query('category'),
    capability: c.req.query('capability'),
    creator: c.req.query('creator'),
    claimer: c.req.query('claimer'),
    limit: c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined,
    offset: c.req.query('offset') ? parseInt(c.req.query('offset')!, 10) : undefined,
  });

  const q = query.success ? query.data : {};
  const limit = Math.min(q.limit ?? 20, 100);
  const offset = q.offset ?? 0;

  const parts = await creatorSqlParts(db);
  let sql = `SELECT ${parts.columns} FROM tasks t ${parts.joins} WHERE 1=1`;
  const params: unknown[] = [];

  if (q.status && q.status !== 'all') {
    sql += ` AND t.status = ?`;
    params.push(q.status);
  }
  // No filter = every status except cancelled (unless explicitly requested)
  if (!q.status) sql += ` AND t.status != 'cancelled'`;
  if (q.category) { sql += ` AND t.category = ?`; params.push(q.category); }
  if (q.capability) { sql += ` AND t.required_capabilities LIKE ?`; params.push(`%"${q.capability}"%`); }
  if (q.creator) { sql += ` AND t.creator_agent_id = ?`; params.push(q.creator); }
  if (q.claimer) { sql += ` AND t.claimed_by_agent_id = ?`; params.push(q.claimer); }

  sql += ` ORDER BY t.created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = await db.all<Record<string, unknown>>(sql, ...params);
  return c.json({ ok: true, tasks: rows.map(publicTaskShape) });
});

function parseReceipt(receipt: Record<string, unknown>): Record<string, unknown> {
  if (receipt.artifact_urls && typeof receipt.artifact_urls === 'string') {
    receipt.artifact_urls = JSON.parse(receipt.artifact_urls);
  }
  return receipt;
}

/**
 * GET /v1/tasks/:id/receipt — Latest delivery receipt (public)
 */
tasks.get('/:id/receipt', async (c) => {
  const taskId = c.req.param('id') as string;
  const db = c.get('db');

  const receipt = await db.get<Record<string, unknown>>(
    'SELECT * FROM delivery_receipts WHERE task_id = ? ORDER BY completed_at DESC LIMIT 1', taskId,
  );
  if (!receipt) {
    return c.json({ error: 'not_found', message: 'No delivery receipt found for this task' }, 404);
  }
  parseReceipt(receipt);

  // Include agent's public key for independent verification
  const agent = await db.get<{ public_key: Uint8Array }>('SELECT public_key FROM agents WHERE id = ?', receipt.agent_id);
  if (agent) {
    const pkBytes = agent.public_key instanceof Uint8Array
      ? agent.public_key
      : new Uint8Array(Object.values(agent.public_key as Record<string, number>));
    receipt.agent_public_key = bytesToHex(pkBytes);
  }

  return c.json({ ok: true, receipt });
});

/**
 * GET /v1/tasks/:id/receipts — Every delivery receipt, newest first (public)
 */
tasks.get('/:id/receipts', async (c) => {
  const taskId = c.req.param('id') as string;
  const db = c.get('db');
  const task = await db.get<{ task_id: string }>('SELECT task_id FROM tasks WHERE task_id = ?', taskId);
  if (!task) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  const rows = await db.all<Record<string, unknown>>(
    'SELECT * FROM delivery_receipts WHERE task_id = ? ORDER BY completed_at DESC', taskId,
  );
  return c.json({ ok: true, receipts: rows.map(parseReceipt) });
});

/**
 * GET /v1/tasks/:id/payment — Payment status, audit trail and (when a claimed
 * bounty task is ready to be accepted) the x402 requirements the buyer signs.
 */
tasks.get('/:id/payment', async (c) => {
  const taskId = c.req.param('id') as string;
  const db = c.get('db');

  const task = await loadTask(db, taskId);
  if (!task) return c.json({ error: 'not_found', message: 'Task not found' }, 404);

  const events = await db.all<{ id: string; event_type: string; details: string | null; created_at: string }>(
    'SELECT id, event_type, details, created_at FROM payment_events WHERE task_id = ? ORDER BY created_at ASC', taskId,
  );

  let requirements: ReturnType<typeof buildRequirements> | null = null;
  let paymentRequired: ReturnType<typeof buildPaymentRequired> | null = null;
  let unavailableReason: 'no_bounty' | 'unsupported_network' | 'not_claimed' | 'payee_wallet_missing' | null = null;
  if (!task.bounty_amount) unavailableReason = 'no_bounty';
  else if (!isNetwork(task.bounty_network)) unavailableReason = 'unsupported_network';
  else if (!task.claimed_by_agent_id) unavailableReason = 'not_claimed';
  else {
    const wallet = await delivererWallet(db, task.claimed_by_agent_id);
    if (!wallet) unavailableReason = 'payee_wallet_missing';
    else {
      requirements = buildRequirements(task, wallet.address, c.env);
      paymentRequired = buildPaymentRequired(task, requirements);
    }
  }

  return c.json({
    ok: true,
    payment: { ...paymentView(task), pay_to: requirements?.payTo ?? null },
    requirements,
    ...(unavailableReason ? { requirements_unavailable_reason: unavailableReason } : {}),
    ...(paymentRequired ? { payment_required: paymentRequired } : {}),
    accept_endpoint: `POST /v1/tasks/${taskId}/accept`,
    payment_header: PAYMENT_HEADER,
    events: events.map((e) => ({ ...e, details: e.details ? JSON.parse(e.details) : null })),
  });
});

/**
 * GET /v1/tasks/:id — Task detail (public, no auth)
 */
tasks.get('/:id', async (c) => {
  const taskId = c.req.param('id') as string;
  const db = c.get('db');

  const parts = await creatorSqlParts(db);
  const row = await db.get<Record<string, unknown>>(`SELECT ${parts.columns} FROM tasks t ${parts.joins} WHERE t.task_id = ?`, taskId);
  if (!row) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  const task = row as unknown as TaskRow;

  const submission = await db.get<Record<string, unknown>>(
    'SELECT * FROM submissions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', taskId,
  );
  const receipt = await db.get<Record<string, unknown>>(
    'SELECT * FROM delivery_receipts WHERE task_id = ? ORDER BY completed_at DESC LIMIT 1', taskId,
  );
  const receiptsCount = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM delivery_receipts WHERE task_id = ?', taskId);

  return c.json({
    ok: true,
    task: publicTaskShape(row),
    submission: submission ?? null,
    delivery_receipt: receipt ? parseReceipt(receipt) : null,
    receipts_count: receiptsCount?.n ?? 0,
    payment: paymentView(task),
  });
});

/**
 * POST /v1/tasks/:id/claim — Claim a task (T2)
 */
tasks.post('/:id/claim', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id') as string;
  const db = c.get('db');
  const actor: Actor = { kind: 'agent', agentId };

  const agent = await db.get<{ id: string; name: string; status: string }>('SELECT id, name, status FROM agents WHERE id = ?', agentId);
  if (!agent || agent.status !== 'active') {
    return c.json({ error: 'forbidden', message: 'Agent must be active to claim tasks' }, 403);
  }

  const task = await loadTask(db, taskId);
  if (!task) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (creatorMatches(task, actor)) return c.json({ error: 'bad_request', message: 'Cannot claim your own task' }, 400);
  if (task.status !== 'open') return c.json({ error: 'conflict', message: 'Task is not open for claiming' }, 409);

  // A bounty is paid to the claimer's wallet at accept time — require it now,
  // so a buyer never faces a deliverer who cannot be paid.
  if (task.bounty_amount) {
    const wallet = await db.get<{ wallet_address: string | null; wallet_network: string | null }>(
      'SELECT wallet_address, wallet_network FROM agents WHERE id = ?', agentId,
    );
    if (!wallet?.wallet_address || !WALLET_RE.test(wallet.wallet_address)) {
      return c.json({
        error: 'wallet_required',
        message: 'This task pays a USDC bounty to your wallet. Set one before claiming.',
        help: { set_wallet: `PATCH /v1/agents/${agentId}/wallet`, body: { wallet_address: '0x...', wallet_network: task.bounty_network } },
      }, 409);
    }
    if (wallet.wallet_network && wallet.wallet_network !== task.bounty_network) {
      return c.json({
        error: 'wallet_network_mismatch',
        message: `Your wallet is on ${wallet.wallet_network}; this bounty settles on ${task.bounty_network}.`,
      }, 409);
    }
  }

  const now = new Date().toISOString();
  if (!(await claimGate(db, taskId, agentId, agentSigFromHeader(c), now))) {
    return c.json({ error: 'conflict', message: 'Task is not open for claiming' }, 409);
  }

  const creator = await creatorTarget(db, task);
  sendWebhook(creator, { type: 'task.claimed', agent_id: creator?.id ?? '', task_id: taskId, claimed_by: { agent_id: agentId, name: agent.name } });
  await recordFunnel(db, 'task_claimed', taskId, null);

  return c.json({ ok: true, task_id: taskId, status: 'claimed' });
});

/**
 * POST /v1/tasks/:id/deliver — Deliver with a signed receipt (T3)
 */
tasks.post('/:id/deliver', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id') as string;
  const db = c.get('db');

  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  const parsed = DeliverTaskSchema.safeParse(json.body);
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const task = await loadTask(db, taskId);
  if (!task) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (task.claimed_by_agent_id !== agentId) {
    return c.json({ error: 'forbidden', message: 'Only the assigned agent can deliver' }, 403);
  }
  if (task.status !== 'claimed') {
    return c.json({ error: 'conflict', message: 'Task must be in claimed status to deliver', status: task.status }, 409);
  }

  const now = new Date().toISOString();
  if (!(await deliverGate(db, taskId, agentId, now))) {
    return c.json({ error: 'conflict', message: 'Task is no longer claimed by you', status: task.status }, 409);
  }

  const { receipt_id: receiptId, chain: chainEntry } = await writeDeliveryReceipt(db, taskId, agentId, parsed.data, agentSigFromHeader(c) ?? '', now);

  const creator = await creatorTarget(db, task);
  const deliverer = await db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', agentId);
  sendWebhook(creator, {
    type: 'task.delivered', agent_id: creator?.id ?? '', task_id: taskId,
    delivered_by: { agent_id: agentId, name: deliverer?.name ?? '' }, summary: parsed.data.summary, receipt_id: receiptId,
  });
  await recordFunnel(db, 'task_delivered', taskId, null);

  return c.json({
    ok: true,
    receipt_id: receiptId,
    task_id: taskId,
    chain_sequence: chainEntry?.sequence ?? null,
    chain_entry_hash: chainEntry?.entry_hash ?? null,
    status: 'submitted',
    revision_count: task.revision_count,
  });
});

/**
 * POST /v1/tasks/:id/submit — Submit deliverable (legacy, still supported; T3)
 */
tasks.post('/:id/submit', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id') as string;
  const db = c.get('db');

  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  const parsed = SubmitDeliverableSchema.safeParse(json.body);
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const task = await loadTask(db, taskId);
  if (!task) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (task.claimed_by_agent_id !== agentId) {
    return c.json({ error: 'forbidden', message: 'Only the assigned agent can submit deliverables' }, 403);
  }
  if (task.status !== 'claimed') {
    return c.json({ error: 'conflict', message: 'Task must be in claimed status to submit', status: task.status }, 409);
  }

  const now = new Date().toISOString();
  if (!(await deliverGate(db, taskId, agentId, now))) {
    return c.json({ error: 'conflict', message: 'Task is no longer claimed by you', status: task.status }, 409);
  }

  const submissionId = generatePublicId('sub');
  try {
    await db.run(
      `INSERT INTO submissions (submission_id, task_id, agent_id, submission_type, content, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      submissionId, taskId, agentId, parsed.data.submission_type, parsed.data.content, parsed.data.summary, now,
    );
  } catch (err) {
    console.error(`[tasks] submission write failed for ${taskId} after the status gate:`, err);
  }

  const creator = await creatorTarget(db, task);
  const submitter = await db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', agentId);
  sendWebhook(creator, {
    type: 'task.submitted', agent_id: creator?.id ?? '', task_id: taskId,
    submitted_by: { agent_id: agentId, name: submitter?.name ?? '' }, summary: parsed.data.summary,
  });
  await recordFunnel(db, 'task_delivered', taskId, null);

  return c.json({ ok: true, submission_id: submissionId, task_id: taskId, status: 'submitted', revision_count: task.revision_count });
});

/**
 * Accept — records acceptance (T4) and, for a bounty task, runs the x402
 * challenge/verify/settle sequence of spec section 2, steps 4-7.
 */
async function handleAccept(c: Ctx, deprecatedAlias: boolean): Promise<Response> {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id') as string;
  const db = c.get('db');
  const actor: Actor = { kind: 'agent', agentId };
  if (deprecatedAlias) c.header('Deprecation', 'true');

  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  const parsed = AcceptBodySchema.safeParse(json.body);
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  const note = parsed.data.note ?? null;

  const task = await loadTask(db, taskId);
  if (!task) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (!creatorMatches(task, actor)) {
    return c.json({
      error: 'forbidden',
      message: task.creator_kind === 'owner'
        ? 'This task is reviewed by the person who posted it'
        : 'Only the task creator can accept deliverables',
    }, 403);
  }
  if (task.status !== 'submitted' && task.status !== 'verified') {
    return c.json({ error: 'invalid_state', message: `Task is ${task.status}; only a submitted task can be accepted`, status: task.status }, 409);
  }

  const now = new Date().toISOString();
  const bountyOut = bountyView(task);
  const alreadyPaidOrInFlight = ['authorized', 'settling', 'settled'].includes(task.payment_status);

  // Idempotent re-accept: nothing to do, nothing to charge.
  if (task.status === 'verified' && (!task.bounty_amount || alreadyPaidOrInFlight)) {
    const body: Record<string, unknown> = { ok: true, task_id: taskId, status: 'verified', accepted_by: task.accepted_by };
    if (task.bounty_amount) {
      body.payment_status = task.payment_status;
      if (task.payment_tx_hash) body.payment_tx_hash = task.payment_tx_hash;
    } else {
      body.payment_status = 'none';
    }
    return c.json(body);
  }

  // ─── Unpaid task ───
  if (!task.bounty_amount) {
    if (!(await acceptUnpaidGate(db, taskId, note, null, now))) {
      return c.json({ error: 'conflict', message: 'Task was accepted or cancelled by another action' }, 409);
    }
    const fresh = (await loadTask(db, taskId)) as TaskRow;
    const side = await afterAccept(db, fresh, { acceptedBy: 'creator', by: actor, nowIso: now, paymentStatus: 'none' });
    return c.json({
      ok: true, task_id: taskId, status: 'verified', accepted_by: 'creator', payment_status: 'none',
      chain_sequence: side.chain?.sequence ?? null, chain_entry_hash: side.chain?.entry_hash ?? null,
    });
  }

  // ─── Bounty task ───
  if (!isNetwork(task.bounty_network)) {
    // A pre-0035 row declared on a network the facilitator does not support; it can only be cancelled.
    return c.json({ error: 'bounty_unsupported_network', message: `This bounty is on ${task.bounty_network}, which cannot be settled; cancel the task or contact support.`, network: task.bounty_network }, 409);
  }
  const provider = paymentProviderFor(c.env);
  const rawHeader = paymentHeader(c);
  const wallet = await delivererWallet(db, task.claimed_by_agent_id);

  if (!rawHeader) {
    if (!provider) return c.json({ error: 'payments_unavailable', message: 'Payments are not enabled on this registry.' }, 503);
    if (!wallet) return c.json({ error: 'payee_wallet_missing', message: 'The deliverer has no wallet on record; they must set one before the bounty can be paid.' }, 409);
    const requirements = buildRequirements(task, wallet.address, c.env);
    const paymentRequired = buildPaymentRequired(task, requirements);
    c.header('PAYMENT-REQUIRED', encodeB64Json(paymentRequired));
    return c.json({
      error: 'payment_required',
      message: `Sign an EIP-3009 USDC transfer of ${bountyOut?.amount_display} USDC to the deliverer's wallet and retry with the ${PAYMENT_HEADER} header.`,
      ...paymentRequired,
      task_id: taskId,
      bounty: bountyOut,
      accept_endpoint: `POST /v1/tasks/${taskId}/accept`,
      payment_header: PAYMENT_HEADER,
    }, 402);
  }

  if (!wallet) return c.json({ error: 'payee_wallet_missing', message: 'The deliverer has no wallet on record; they must set one before the bounty can be paid.' }, 409);
  const requirements = buildRequirements(task, wallet.address, c.env);

  let payload: ReturnType<typeof decodePaymentHeader>;
  try {
    payload = decodePaymentHeader(rawHeader);
  } catch (err) {
    return c.json({
      error: 'payment_malformed',
      message: 'The payment header is not a valid x402 v2 payment payload.',
      detail: err instanceof PaymentMalformed ? err.detail : String(err),
      payment_requirements: requirements,
    }, 400);
  }

  const nowSec = Math.floor(Date.parse(now) / 1000);
  const pre = localPrechecks(payload, requirements, nowSec);
  if (!pre.ok) {
    return c.json({
      error: 'payment_invalid', reason: pre.reason, expected: pre.expected, got: pre.got,
      message: "The signed authorization does not match this task's payment requirements.",
      payment_requirements: requirements,
    }, 402);
  }

  // Re-authorization guard (N11): a payload that may have reached the chain is
  // never replaced unless the facilitator gave a definitive negative. Decided
  // on the structured settle class only (payments/settle.ts reauthPermitted).
  if (!reauthPermitted(task)) {
    return c.json({
      error: 'settlement_in_progress',
      message: 'A previous authorization for this task is still being settled; check GET /v1/tasks/:id/payment.',
      payment_status: task.payment_status,
    }, 409);
  }

  if (!provider) return c.json({ error: 'payments_unavailable', message: 'Payments are not enabled on this registry.' }, 503);

  const verify = await provider.verify(payload, requirements);
  if (verify.kind === 'invalid') {
    return c.json({
      error: verify.reason === 'insufficient_funds' ? 'insufficient_funds' : 'payment_invalid',
      reason: verify.reason, message: verify.message ?? 'The facilitator rejected the authorization.', payer: verify.payer ?? null,
      payment_requirements: requirements,
    }, 402);
  }
  if (verify.kind === 'unavailable') {
    if (verify.cause === 'auth') console.error('[payments] CDP auth rejected — check CDP_API_KEY_ID/CDP_API_KEY_SECRET');
    return c.json({ error: 'facilitator_unavailable', cause: verify.cause, message: 'The payment facilitator is unavailable; retry shortly.' }, 503);
  }

  const encKey = c.env?.PAYMENT_ENCRYPTION_KEY as string; // guaranteed by paymentProviderFor
  const encrypted = await encryptPaymentSignature(rawHeader, encKey);
  const auth = payload.payload.authorization;
  const expiresAt = new Date(Number(auth.validBefore) * 1000).toISOString();

  // THE GATE (T4-P): acceptance + authorization in ONE statement. Two
  // predicates are tried in turn so we KNOW which edge we consumed: the
  // submitted→verified edge (this call is the acceptance) or the
  // verified→verified edge (authorizing a task the timer or an earlier call
  // already accepted). The pre-read is not trusted for that — the cron may
  // have auto-accepted while the facilitator verify was in flight.
  const gateSql = (statusPredicate: string) => `
      UPDATE tasks SET
         status = 'verified', verified_at = COALESCE(verified_at, ?), accepted_by = COALESCE(accepted_by, 'creator'),
         review_note = COALESCE(?, review_note), auto_release_at = NULL,
         payment_signature = ?, payment_requirements = ?, payment_payer = ?, payment_nonce = ?, payment_expires_at = ?,
         payment_verified = 1, payment_status = 'authorized', settle_attempts = 0, settle_broadcast = 0,
         settle_started_at = NULL, settle_next_at = ?, last_settle_error = NULL, last_settle_class = NULL
       WHERE task_id = ? AND ${statusPredicate}
         AND payment_status IN ('pending','failed','expired')
         AND (settle_broadcast = 0 OR payment_status = 'expired' OR last_settle_class IN (${REAUTH_CLASSES.map((cls) => `'${cls}'`).join(',')}))`;
  const gateParams = [now, note, encrypted, JSON.stringify(requirements), verify.payer ?? auth.from, auth.nonce.toLowerCase(), expiresAt, now, taskId];
  let wasSubmitted = false;
  let changes = 0;
  try {
    const first = await db.run(gateSql(`status = 'submitted'`), ...gateParams);
    if (first.changes === 1) {
      wasSubmitted = true;
      changes = 1;
    } else {
      changes = (await db.run(gateSql(`status = 'verified'`), ...gateParams)).changes;
    }
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) {
      return c.json({ error: 'authorization_reused', message: 'This authorization nonce was already used for another task.' }, 409);
    }
    throw err;
  }
  if (changes !== 1) {
    return c.json({ error: 'conflict', message: 'Task changed while you were accepting it; reload and retry. Your signature was not used.' }, 409);
  }

  const fresh = (await loadTask(db, taskId)) as TaskRow;
  let side: { chain: { sequence: number; entry_hash: string } | null } = { chain: null };
  if (wasSubmitted) {
    side = await afterAccept(db, fresh, { acceptedBy: 'creator', by: actor, nowIso: now, paymentStatus: 'authorized' });
  }
  await logPaymentEvent(db, taskId, 'authorized', {
    payer: verify.payer ?? auth.from, nonce: auth.nonce, valid_before: expiresAt, amount_atomic: task.bounty_amount, pay_to: wallet.address, trigger: 'accept',
  }, now);

  const settle = await settleTask(db, c.env, taskId, 'accept', now);
  const after = (await loadTask(db, taskId)) as TaskRow;
  if (!settle.skipped && settle.facilitator) c.header('PAYMENT-RESPONSE', encodeB64Json(wireSettleResponse(settle.facilitator, task.bounty_network)));

  const body: Record<string, unknown> = {
    ok: true, task_id: taskId, status: 'verified', accepted_by: after.accepted_by,
    payment_status: after.payment_status,
    chain_sequence: side.chain?.sequence ?? null, chain_entry_hash: side.chain?.entry_hash ?? null,
  };
  if (after.payment_tx_hash) body.payment_tx_hash = after.payment_tx_hash;
  if (after.payment_status !== 'settled' && after.last_settle_error) body.settle_error = after.last_settle_error;
  return c.json(body);
}

tasks.post('/:id/accept', agentAuth, (c) => handleAccept(c, false));
/** Deprecated alias of /accept (D5). */
tasks.post('/:id/verify', agentAuth, (c) => handleAccept(c, true));

/**
 * POST /v1/tasks/:id/revision — Creator asks for changes (T6)
 */
tasks.post('/:id/revision', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id') as string;
  const db = c.get('db');
  const actor: Actor = { kind: 'agent', agentId };

  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  const parsed = RevisionBodySchema.safeParse(json.body);
  if (!parsed.success) return c.json({ error: 'bad_request', message: 'A note describing the requested changes is required', details: parsed.error.flatten() }, 400);

  const task = await loadTask(db, taskId);
  if (!task) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (!creatorMatches(task, actor)) return c.json({ error: 'forbidden', message: 'Only the task creator can request changes' }, 403);
  if (task.status !== 'submitted') return c.json({ error: 'invalid_state', message: 'Only a submitted task can be sent back for changes', status: task.status }, 409);
  if (task.revision_count >= MAX_REVISIONS) return c.json({ error: 'max_revisions', message: `This task already had ${MAX_REVISIONS} revision rounds; accept, dispute or cancel it.` }, 409);

  const now = new Date().toISOString();
  if (!(await revisionGate(db, taskId, parsed.data.note, now))) {
    return c.json({ error: 'conflict', message: 'Task changed while you were reviewing it' }, 409);
  }
  const revisionCount = task.revision_count + 1;
  const deliverer = await agentTarget(db, task.claimed_by_agent_id);
  sendWebhook(deliverer, { type: 'task.revision_requested', agent_id: deliverer?.id ?? '', task_id: taskId, note: parsed.data.note, revision_count: revisionCount });
  await recordFunnel(db, 'task_revision_requested', taskId, null);

  return c.json({ ok: true, task_id: taskId, status: 'claimed', review_state: 'revision_requested', revision_count: revisionCount });
});

/**
 * POST /v1/tasks/:id/dispute — Creator disputes the deliverable (T7): freezes
 * auto-accept; resolved by the creator's next action (accept or cancel).
 */
tasks.post('/:id/dispute', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id') as string;
  const db = c.get('db');
  const actor: Actor = { kind: 'agent', agentId };

  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  const parsed = DisputeBodySchema.safeParse(json.body);
  if (!parsed.success) return c.json({ error: 'bad_request', message: 'A reason is required to dispute a deliverable', details: parsed.error.flatten() }, 400);

  const task = await loadTask(db, taskId);
  if (!task) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (!creatorMatches(task, actor)) return c.json({ error: 'forbidden', message: 'Only the task creator can dispute deliverables' }, 403);
  if (task.status !== 'submitted') return c.json({ error: 'invalid_state', message: 'Only a submitted task can be disputed', status: task.status }, 409);
  if (task.disputed_at) return c.json({ error: 'already_disputed', message: 'This deliverable is already disputed', disputed_at: task.disputed_at }, 409);

  const now = new Date().toISOString();
  if (!(await disputeGate(db, taskId, parsed.data.reason, now))) {
    return c.json({ error: 'conflict', message: 'Task changed while you were reviewing it' }, 409);
  }
  await logPaymentEvent(db, taskId, 'disputed', { reason: parsed.data.reason, disputed_by: agentId, payment_status: task.payment_status }, now);
  const deliverer = await agentTarget(db, task.claimed_by_agent_id);
  sendWebhook(deliverer, { type: 'task.disputed', agent_id: deliverer?.id ?? '', task_id: taskId, reason: parsed.data.reason });
  await recordFunnel(db, 'task_disputed', taskId, null);

  return c.json({ ok: true, task_id: taskId, status: 'submitted', review_state: 'disputed', disputed_at: now, payment_status: task.payment_status });
});

/**
 * POST /v1/tasks/:id/cancel — Creator cancels (T8)
 */
tasks.post('/:id/cancel', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id') as string;
  const db = c.get('db');
  const actor: Actor = { kind: 'agent', agentId };

  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  const parsed = CancelBodySchema.safeParse(json.body);
  const reason = parsed.success ? parsed.data.reason ?? null : null;

  const task = await loadTask(db, taskId);
  if (!task) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (!creatorMatches(task, actor)) return c.json({ error: 'forbidden', message: 'Only the task creator can cancel tasks' }, 403);

  const refusal = cancelRefusal(task);
  if (refusal) {
    const messages: Record<string, string> = {
      already_accepted: 'Accepted work cannot be cancelled',
      dispute_first: 'Delivered work can only be cancelled after a dispute (POST /v1/tasks/:id/dispute)',
      payment_in_flight: 'A payment is authorized or settling for this task; it cannot be cancelled',
      conflict: 'Task cannot be cancelled in its current state',
    };
    return c.json({ error: refusal, message: messages[refusal], status: task.status, payment_status: task.payment_status }, 409);
  }

  const now = new Date().toISOString();
  if (!(await cancelGate(db, taskId, now))) {
    return c.json({ error: 'conflict', message: 'Task changed while you were cancelling it' }, 409);
  }

  if (task.bounty_amount && ['pending', 'failed'].includes(task.payment_status)) {
    await logPaymentEvent(db, taskId, 'expired', { reason: 'task_cancelled', cancel_reason: reason }, now);
  }
  const claimer = await agentTarget(db, task.claimed_by_agent_id);
  sendWebhook(claimer, { type: 'task.cancelled', agent_id: claimer?.id ?? '', task_id: taskId });
  if (task.disputed_at && task.claimed_by_agent_id) await recomputeReputation(db, task.claimed_by_agent_id);
  await recordFunnel(db, 'task_cancelled', taskId, null);

  const after = await loadTask(db, taskId);
  return c.json({ ok: true, task_id: taskId, status: 'cancelled', payment_status: after?.payment_status ?? task.payment_status });
});

export default tasks;
