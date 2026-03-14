import { Hono } from 'hono';
import type { AppEnv } from '../types/index.js';
import { CreateTaskSchema, SubmitDeliverableSchema, DeliverTaskSchema, TaskQuerySchema } from '../types/index.js';
import type { PaymentStatus } from '../types/index.js';
import { agentAuth } from '../middleware/auth.js';
import { fireWebhook } from '../lib/webhooks.js';
import { computeChainHash, hashProfile, GENESIS_HASH, sha256, bytesToHex, canonicalJsonStringify } from '../crypto/index.js';
import { computeReputation } from '../reputation/calculator.js';
import { CdpPaymentProvider } from '../payments/cdp-provider.js';
import { encryptPaymentSignature, decryptPaymentSignature } from '../payments/crypto.js';

const tasks = new Hono<AppEnv>();

function generateTaskId(): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let id = 'task_';
  for (let i = 0; i < 21; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function generateSubmissionId(): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let id = 'sub_';
  for (let i = 0; i < 21; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function generateReceiptId(): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let id = 'rcpt_';
  for (let i = 0; i < 21; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function generateEventId(): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let id = 'pev_';
  for (let i = 0; i < 21; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/**
 * Canonicalize an object for hashing using RFC 8785 canonical JSON.
 */
function canonicalJson(obj: Record<string, unknown>): string {
  return canonicalJsonStringify(obj);
}

/**
 * Log a payment event to the audit table.
 */
async function logPaymentEvent(
  db: any,
  taskId: string,
  eventType: string,
  details?: Record<string, unknown>
): Promise<void> {
  await db.run(
    `INSERT INTO payment_events (id, task_id, event_type, details, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    generateEventId(), taskId, eventType,
    details ? JSON.stringify(details) : null,
    new Date().toISOString()
  );
}

/**
 * Create a chain entry for task events (task_delivered, task_verified, task_payment_settled).
 */
async function createTaskChainEntry(
  db: ReturnType<Hono<AppEnv>['request']> extends Promise<infer _> ? never : never,
  agentId: string,
  entryType: string,
  dataHash: string,
): Promise<{ sequence: number; entry_hash: string }>;
async function createTaskChainEntry(
  db: any,
  agentId: string,
  entryType: string,
  dataHash: string,
): Promise<{ sequence: number; entry_hash: string }> {
  const agent = await db.get<{ public_key: Uint8Array }>(
    'SELECT public_key FROM agents WHERE id = ?', agentId
  );
  const pubKeyRaw = agent!.public_key;
  const pubKeyBytes = pubKeyRaw instanceof Uint8Array
    ? pubKeyRaw
    : new Uint8Array(Object.values(pubKeyRaw as Record<string, number>));

  const latestEntry = await db.get<{ entry_hash: string }>(
    'SELECT entry_hash FROM chain ORDER BY sequence DESC LIMIT 1'
  );
  const previousHash = latestEntry?.entry_hash ?? GENESIS_HASH;
  const now = new Date().toISOString();

  const entryHash = computeChainHash(previousHash, pubKeyBytes, '', dataHash, now);

  const seqRow = await db.get<{ next_seq: number }>(
    'SELECT COALESCE(MAX(sequence), -1) + 1 AS next_seq FROM chain'
  );
  const nextSeq = seqRow!.next_seq;

  await db.run(
    `INSERT INTO chain (sequence, entry_hash, previous_hash, agent_id, public_key, nonce, profile_hash, timestamp, entry_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    nextSeq, entryHash, previousHash, agentId, pubKeyBytes, '', dataHash, now, entryType
  );

  return { sequence: nextSeq, entry_hash: entryHash };
}

/**
 * POST /v1/tasks — Create a task (with optional bounty + payment signature)
 */
tasks.post('/', agentAuth, async (c) => {
  const creatorId = c.get('agentId') as string;
  const db = c.get('db');

  let body: unknown;
  try { body = JSON.parse(await c.req.text()); }
  catch { return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400); }

  const parsed = CreateTaskSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  // Creator must be active
  const creator = await db.get<{ id: string; name: string; status: string }>(
    'SELECT id, name, status FROM agents WHERE id = ?', creatorId
  );
  if (!creator || creator.status !== 'active') {
    return c.json({ error: 'forbidden', message: 'Agent must be active to create tasks' }, 403);
  }

  const taskId = generateTaskId();
  const now = new Date().toISOString();
  const reqCaps = parsed.data.required_capabilities ?? null;

  // Store proposer_signature from auth header
  const authHeader = c.req.header('Authorization') ?? '';
  const proposerSig = authHeader.startsWith('AgentSig ') ? authHeader.split(':').slice(1).join(':') : null;

  // ─── Payment handling ───
  const bounty = parsed.data.bounty;
  const paymentSigHeader = c.req.header('X-PAYMENT-SIGNATURE');
  let paymentStatus: PaymentStatus = 'none';
  let encryptedSig: string | null = null;
  let paymentExpiresAt: string | null = null;
  let autoReleaseAt: string | null = null;

  if (bounty && paymentSigHeader) {
    // Verify payment signature via CDP facilitator
    const provider = new CdpPaymentProvider(c.env?.CDP_API_KEY);
    const verifyResult = await provider.verify(paymentSigHeader);

    if (!verifyResult.valid) {
      // Note: can't log to payment_events yet — task row doesn't exist (FK constraint)
      return c.json({
        error: 'payment_invalid',
        message: verifyResult.error ?? 'Payment signature verification failed',
      }, 402);
    }

    // Encrypt the payment signature for storage
    const encKey = c.env?.PAYMENT_ENCRYPTION_KEY;
    if (!encKey) {
      return c.json({
        error: 'server_error',
        message: 'Payment encryption not configured',
      }, 500);
    }
    encryptedSig = await encryptPaymentSignature(paymentSigHeader, encKey);
    paymentStatus = 'authorized';
    paymentExpiresAt = verifyResult.expires_at ?? null;
    // Note: logPaymentEvent('authorized') is called AFTER task INSERT (FK constraint)
  } else if (bounty && !paymentSigHeader) {
    return c.json({
      error: 'bad_request',
      message: 'Bounty requires X-PAYMENT-SIGNATURE header with x402 signed payment',
    }, 400);
  }

  await db.run(
    `INSERT INTO tasks (task_id, creator_agent_id, title, description, category, required_capabilities, expected_output, output_format, status, created_at, proposer_signature, bounty_amount, bounty_token, bounty_network, payment_signature, payment_verified, payment_settled, payment_expires_at, auto_release_at, payment_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    taskId, creatorId,
    parsed.data.title, parsed.data.description,
    parsed.data.category ?? null,
    reqCaps ? JSON.stringify(reqCaps) : null,
    parsed.data.expected_output ?? null,
    parsed.data.output_format,
    now,
    proposerSig,
    bounty?.amount ?? null,
    bounty?.token ?? null,
    bounty?.network ?? null,
    encryptedSig,
    paymentStatus === 'authorized' ? 1 : 0,
    paymentExpiresAt,
    autoReleaseAt,
    paymentStatus
  );

  // Log payment event AFTER task insert (FK constraint)
  if (paymentStatus === 'authorized' && bounty) {
    await logPaymentEvent(db, taskId, 'authorized', {
      amount: bounty.amount,
      token: bounty.token,
      network: bounty.network,
      expires_at: paymentExpiresAt,
    });
  }

  // Auto-notify matching agents (fire-and-forget)
  if (reqCaps && reqCaps.length > 0) {
    const agents = await db.all<{ id: string; capabilities: string; webhook_url: string | null }>(
      `SELECT id, capabilities, webhook_url FROM agents WHERE status = 'active' AND webhook_url IS NOT NULL AND id != ?`,
      creatorId
    );
    for (const agent of agents) {
      try {
        const caps: string[] = JSON.parse(agent.capabilities);
        const matches = reqCaps.some((rc: string) => caps.includes(rc));
        if (matches && agent.webhook_url) {
          fireWebhook(agent.webhook_url, {
            type: 'task.available',
            agent_id: agent.id,
            task: {
              task_id: taskId,
              title: parsed.data.title,
              description: parsed.data.description,
              category: parsed.data.category ?? null,
              required_capabilities: reqCaps,
              output_format: parsed.data.output_format,
              bounty: bounty ?? null,
            },
          });
        }
      } catch {
        // skip agents with invalid capabilities JSON
      }
    }
  }

  const response: Record<string, unknown> = { ok: true, task_id: taskId, status: 'open' };
  if (paymentStatus !== 'none') {
    response.payment_status = paymentStatus;
  }
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
    limit: c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined,
    offset: c.req.query('offset') ? parseInt(c.req.query('offset')!, 10) : undefined,
  });

  const limit = Math.min(query.success ? (query.data.limit ?? 20) : 20, 100);
  const offset = query.success ? (query.data.offset ?? 0) : 0;
  const status = query.success ? query.data.status : undefined;
  const category = query.success ? query.data.category : undefined;
  const capability = query.success ? query.data.capability : undefined;

  let sql = `SELECT * FROM tasks WHERE 1=1`;
  const params: unknown[] = [];

  if (status) {
    sql += ` AND status = ?`;
    params.push(status);
  } else {
    // Default: only open tasks
    sql += ` AND status = 'open'`;
  }

  if (category) {
    sql += ` AND category = ?`;
    params.push(category);
  }

  if (capability) {
    sql += ` AND required_capabilities LIKE ?`;
    params.push(`%"${capability}"%`);
  }

  sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = await db.all<Record<string, unknown>>(sql, ...params);

  // Parse required_capabilities JSON and strip encrypted payment_signature from response
  const tasks_list = rows.map((row) => {
    const { payment_signature, ...rest } = row;
    return {
      ...rest,
      required_capabilities: row.required_capabilities ? JSON.parse(row.required_capabilities as string) : null,
    };
  });

  return c.json({ ok: true, tasks: tasks_list });
});

/**
 * GET /v1/tasks/:id/receipt — Get delivery receipt (public, no auth)
 */
tasks.get('/:id/receipt', async (c) => {
  const taskId = c.req.param('id');
  const db = c.get('db');

  const receipt = await db.get<Record<string, unknown>>(
    'SELECT * FROM delivery_receipts WHERE task_id = ?', taskId
  );
  if (!receipt) {
    return c.json({ error: 'not_found', message: 'No delivery receipt found for this task' }, 404);
  }

  // Parse artifact_urls JSON
  if (receipt.artifact_urls) {
    receipt.artifact_urls = JSON.parse(receipt.artifact_urls as string);
  }

  // Include agent's public key for independent verification
  const agent = await db.get<{ public_key: Uint8Array }>(
    'SELECT public_key FROM agents WHERE id = ?', receipt.agent_id
  );
  if (agent) {
    const pkBytes = agent.public_key instanceof Uint8Array
      ? agent.public_key
      : new Uint8Array(Object.values(agent.public_key as Record<string, number>));
    receipt.agent_public_key = bytesToHex(pkBytes);
  }

  return c.json({ ok: true, receipt });
});

/**
 * GET /v1/tasks/:id/payment — Payment status (public, no auth)
 */
tasks.get('/:id/payment', async (c) => {
  const taskId = c.req.param('id');
  const db = c.get('db');

  const task = await db.get<{
    task_id: string;
    bounty_amount: string | null;
    bounty_token: string | null;
    bounty_network: string | null;
    payment_status: string;
    payment_verified: number;
    payment_settled: number;
    payment_tx_hash: string | null;
    payment_expires_at: string | null;
    auto_release_at: string | null;
  }>(
    `SELECT task_id, bounty_amount, bounty_token, bounty_network, payment_status,
            payment_verified, payment_settled, payment_tx_hash, payment_expires_at, auto_release_at
     FROM tasks WHERE task_id = ?`, taskId
  );
  if (!task) {
    return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  }

  // Get payment events
  const events = await db.all<{ id: string; event_type: string; details: string | null; created_at: string }>(
    'SELECT id, event_type, details, created_at FROM payment_events WHERE task_id = ? ORDER BY created_at ASC', taskId
  );

  return c.json({
    ok: true,
    payment: {
      task_id: task.task_id,
      bounty: task.bounty_amount ? {
        amount: task.bounty_amount,
        token: task.bounty_token,
        network: task.bounty_network,
      } : null,
      status: task.payment_status,
      verified: !!task.payment_verified,
      settled: !!task.payment_settled,
      tx_hash: task.payment_tx_hash,
      expires_at: task.payment_expires_at,
      auto_release_at: task.auto_release_at,
    },
    events: events.map(e => ({
      ...e,
      details: e.details ? JSON.parse(e.details) : null,
    })),
  });
});

/**
 * GET /v1/tasks/:id — Get task detail (public, no auth)
 */
tasks.get('/:id', async (c) => {
  const taskId = c.req.param('id');
  const db = c.get('db');

  const task = await db.get<Record<string, unknown>>(
    'SELECT * FROM tasks WHERE task_id = ?', taskId
  );
  if (!task) {
    return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  }

  // Parse JSON fields
  if (task.required_capabilities) {
    task.required_capabilities = JSON.parse(task.required_capabilities as string);
  }

  // Never expose encrypted payment signature
  delete task.payment_signature;

  // Include submission if task has been submitted
  let submission = null;
  if (task.status === 'submitted' || task.status === 'verified') {
    submission = await db.get<Record<string, unknown>>(
      'SELECT * FROM submissions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', taskId
    );
  }

  // Include delivery receipt if it exists
  let delivery_receipt = null;
  const receipt = await db.get<Record<string, unknown>>(
    'SELECT * FROM delivery_receipts WHERE task_id = ?', taskId
  );
  if (receipt) {
    if (receipt.artifact_urls) {
      receipt.artifact_urls = JSON.parse(receipt.artifact_urls as string);
    }
    delivery_receipt = receipt;
  }

  return c.json({ ok: true, task, submission, delivery_receipt });
});

/**
 * POST /v1/tasks/:id/claim — Claim a task
 */
tasks.post('/:id/claim', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id');
  const db = c.get('db');

  // Agent must be active
  const agent = await db.get<{ id: string; name: string; status: string }>(
    'SELECT id, name, status FROM agents WHERE id = ?', agentId
  );
  if (!agent || agent.status !== 'active') {
    return c.json({ error: 'forbidden', message: 'Agent must be active to claim tasks' }, 403);
  }

  const task = await db.get<{ task_id: string; creator_agent_id: string; status: string }>(
    'SELECT task_id, creator_agent_id, status FROM tasks WHERE task_id = ?', taskId
  );
  if (!task) {
    return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  }

  // Cannot claim your own task
  if (task.creator_agent_id === agentId) {
    return c.json({ error: 'bad_request', message: 'Cannot claim your own task' }, 400);
  }

  // Task must be open
  if (task.status !== 'open') {
    return c.json({ error: 'conflict', message: 'Task is not open for claiming' }, 409);
  }

  // Store acceptor_signature from auth header
  const authHeader = c.req.header('Authorization') ?? '';
  const acceptorSig = authHeader.startsWith('AgentSig ') ? authHeader.split(':').slice(1).join(':') : null;

  const now = new Date().toISOString();
  await db.run(
    `UPDATE tasks SET claimed_by_agent_id = ?, status = 'claimed', claimed_at = ?, acceptor_signature = ? WHERE task_id = ?`,
    agentId, now, acceptorSig, taskId
  );

  // Notify creator via webhook
  const creator = await db.get<{ id: string; webhook_url: string | null }>(
    'SELECT id, webhook_url FROM agents WHERE id = ?', task.creator_agent_id
  );
  if (creator?.webhook_url) {
    fireWebhook(creator.webhook_url, {
      type: 'task.claimed',
      agent_id: creator.id,
      task_id: taskId,
      claimed_by: { agent_id: agentId, name: agent.name },
    });
  }

  return c.json({ ok: true, task_id: taskId, status: 'claimed' });
});

/**
 * POST /v1/tasks/:id/deliver — Deliver with receipt (new delivery protocol)
 */
tasks.post('/:id/deliver', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id');
  const db = c.get('db');

  let body: unknown;
  try { body = JSON.parse(await c.req.text()); }
  catch { return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400); }

  const parsed = DeliverTaskSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const task = await db.get<{ task_id: string; creator_agent_id: string; claimed_by_agent_id: string | null; status: string; bounty_amount: string | null }>(
    'SELECT task_id, creator_agent_id, claimed_by_agent_id, status, bounty_amount FROM tasks WHERE task_id = ?', taskId
  );
  if (!task) {
    return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  }

  // Only the claimer can deliver
  if (task.claimed_by_agent_id !== agentId) {
    return c.json({ error: 'forbidden', message: 'Only the assigned agent can deliver' }, 403);
  }

  // Task must be claimed
  if (task.status !== 'claimed') {
    return c.json({ error: 'bad_request', message: 'Task must be in claimed status to deliver' }, 400);
  }

  const receiptId = generateReceiptId();
  const now = new Date().toISOString();

  // The signature is the AgentSig from the auth header
  const authHeader = c.req.header('Authorization') ?? '';
  const signature = authHeader.startsWith('AgentSig ') ? authHeader.split(':').slice(1).join(':') : '';

  // Build canonical receipt payload for hashing
  const receiptPayload: Record<string, unknown> = {
    receipt_id: receiptId,
    task_id: taskId,
    agent_id: agentId,
    summary: parsed.data.summary,
    artifact_urls: parsed.data.artifact_urls ?? null,
    commit_hash: parsed.data.commit_hash ?? null,
    pr_url: parsed.data.pr_url ?? null,
    submission_type: parsed.data.submission_type,
    submission_content: parsed.data.submission_content ?? null,
    completed_at: now,
  };
  const receiptHash = bytesToHex(sha256(new TextEncoder().encode(canonicalJson(receiptPayload))));

  // Create chain entry of type 'task_delivered'
  const chainEntry = await createTaskChainEntry(db, agentId, 'task_delivered', receiptHash);

  // Store delivery receipt
  await db.run(
    `INSERT INTO delivery_receipts (receipt_id, task_id, agent_id, summary, artifact_urls, commit_hash, pr_url, submission_type, submission_content, completed_at, chain_sequence, chain_entry_hash, signature)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    receiptId, taskId, agentId,
    parsed.data.summary,
    parsed.data.artifact_urls ? JSON.stringify(parsed.data.artifact_urls) : null,
    parsed.data.commit_hash ?? null,
    parsed.data.pr_url ?? null,
    parsed.data.submission_type,
    parsed.data.submission_content ?? null,
    now,
    chainEntry.sequence,
    chainEntry.entry_hash,
    signature
  );

  // Also create a backward-compatible submission record
  const submissionId = generateSubmissionId();
  await db.run(
    `INSERT INTO submissions (submission_id, task_id, agent_id, submission_type, content, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    submissionId, taskId, agentId,
    parsed.data.submission_type === 'pr' ? 'link' : parsed.data.submission_type,
    parsed.data.submission_content ?? parsed.data.pr_url ?? parsed.data.summary,
    parsed.data.summary,
    now
  );

  // Update task status to 'submitted' (backward compat status name)
  // If task has a bounty, set auto_release_at to 7 days from now
  let autoRelease: string | null = null;
  if (task.bounty_amount) {
    autoRelease = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  await db.run(
    `UPDATE tasks SET status = 'submitted', submitted_at = ?, auto_release_at = COALESCE(?, auto_release_at) WHERE task_id = ?`,
    now, autoRelease, taskId
  );

  // Notify creator via webhook
  const creator = await db.get<{ id: string; webhook_url: string | null }>(
    'SELECT id, webhook_url FROM agents WHERE id = ?', task.creator_agent_id
  );
  const deliverer = await db.get<{ id: string; name: string }>(
    'SELECT id, name FROM agents WHERE id = ?', agentId
  );
  if (creator?.webhook_url && deliverer) {
    fireWebhook(creator.webhook_url, {
      type: 'task.delivered',
      agent_id: creator.id,
      task_id: taskId,
      delivered_by: { agent_id: agentId, name: deliverer.name },
      summary: parsed.data.summary,
      receipt_id: receiptId,
    });
  }

  return c.json({
    ok: true,
    receipt_id: receiptId,
    task_id: taskId,
    chain_sequence: chainEntry.sequence,
    chain_entry_hash: chainEntry.entry_hash,
    status: 'submitted',
  });
});

/**
 * POST /v1/tasks/:id/submit — Submit deliverable (legacy, still supported)
 */
tasks.post('/:id/submit', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id');
  const db = c.get('db');

  let body: unknown;
  try { body = JSON.parse(await c.req.text()); }
  catch { return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400); }

  const parsed = SubmitDeliverableSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const task = await db.get<{ task_id: string; creator_agent_id: string; claimed_by_agent_id: string | null; status: string; bounty_amount: string | null }>(
    'SELECT task_id, creator_agent_id, claimed_by_agent_id, status, bounty_amount FROM tasks WHERE task_id = ?', taskId
  );
  if (!task) {
    return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  }

  // Only the claimer can submit
  if (task.claimed_by_agent_id !== agentId) {
    return c.json({ error: 'forbidden', message: 'Only the assigned agent can submit deliverables' }, 403);
  }

  // Task must be claimed
  if (task.status !== 'claimed') {
    return c.json({ error: 'bad_request', message: 'Task must be in claimed status to submit' }, 400);
  }

  const submissionId = generateSubmissionId();
  const now = new Date().toISOString();

  await db.run(
    `INSERT INTO submissions (submission_id, task_id, agent_id, submission_type, content, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    submissionId, taskId, agentId,
    parsed.data.submission_type, parsed.data.content, parsed.data.summary,
    now
  );

  // Set auto_release_at for bounty tasks
  let autoRelease: string | null = null;
  if (task.bounty_amount) {
    autoRelease = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  await db.run(
    `UPDATE tasks SET status = 'submitted', submitted_at = ?, auto_release_at = COALESCE(?, auto_release_at) WHERE task_id = ?`,
    now, autoRelease, taskId
  );

  // Notify creator via webhook
  const creator = await db.get<{ id: string; webhook_url: string | null }>(
    'SELECT id, webhook_url FROM agents WHERE id = ?', task.creator_agent_id
  );
  const submitter = await db.get<{ id: string; name: string }>(
    'SELECT id, name FROM agents WHERE id = ?', agentId
  );
  if (creator?.webhook_url && submitter) {
    fireWebhook(creator.webhook_url, {
      type: 'task.submitted',
      agent_id: creator.id,
      task_id: taskId,
      submitted_by: { agent_id: agentId, name: submitter.name },
      summary: parsed.data.summary,
    });
  }

  return c.json({ ok: true, submission_id: submissionId, task_id: taskId, status: 'submitted' });
});

/**
 * POST /v1/tasks/:id/verify — Creator verifies deliverable (triggers settlement if bounty)
 */
tasks.post('/:id/verify', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id');
  const db = c.get('db');

  const task = await db.get<{
    task_id: string;
    creator_agent_id: string;
    claimed_by_agent_id: string | null;
    status: string;
    payment_status: string;
    payment_signature: string | null;
    bounty_amount: string | null;
  }>(
    'SELECT task_id, creator_agent_id, claimed_by_agent_id, status, payment_status, payment_signature, bounty_amount FROM tasks WHERE task_id = ?', taskId
  );
  if (!task) {
    return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  }

  // Only creator can verify
  if (task.creator_agent_id !== agentId) {
    return c.json({ error: 'forbidden', message: 'Only the task creator can verify deliverables' }, 403);
  }

  // Task must be submitted
  if (task.status !== 'submitted') {
    return c.json({ error: 'bad_request', message: 'Task must be in submitted status to verify' }, 400);
  }

  const now = new Date().toISOString();

  // ─── Settlement: if task has authorized payment, settle it ───
  let settlementResult: { tx_hash?: string; payment_status: PaymentStatus } = { payment_status: 'none' };

  if (task.payment_status === 'authorized' && task.payment_signature) {
    const encKey = c.env?.PAYMENT_ENCRYPTION_KEY;
    if (!encKey) {
      await logPaymentEvent(db, taskId, 'settle_failed', { error: 'PAYMENT_ENCRYPTION_KEY not configured' });
      settlementResult = { payment_status: 'failed' };
    } else {
      try {
        const rawSig = await decryptPaymentSignature(task.payment_signature, encKey);
        const provider = new CdpPaymentProvider(c.env?.CDP_API_KEY);
        const result = await provider.settle(rawSig);

        if (result.success) {
          settlementResult = { tx_hash: result.tx_hash, payment_status: 'settled' };
          await db.run(
            `UPDATE tasks SET payment_settled = 1, payment_tx_hash = ?, payment_status = 'settled' WHERE task_id = ?`,
            result.tx_hash ?? null, taskId
          );
          await logPaymentEvent(db, taskId, 'settled', { tx_hash: result.tx_hash });

          // Chain entry for payment settlement
          const settlementHash = bytesToHex(sha256(new TextEncoder().encode(
            canonicalJson({ task_id: taskId, settled_at: now, tx_hash: result.tx_hash ?? null })
          )));
          await createTaskChainEntry(db, agentId, 'task_payment_settled', settlementHash);
        } else {
          settlementResult = { payment_status: 'failed' };
          await db.run(
            `UPDATE tasks SET payment_status = 'failed' WHERE task_id = ?`, taskId
          );
          await logPaymentEvent(db, taskId, 'settle_failed', { error: result.error, raw: result.raw });
        }
      } catch (err) {
        settlementResult = { payment_status: 'failed' };
        await db.run(
          `UPDATE tasks SET payment_status = 'failed' WHERE task_id = ?`, taskId
        );
        await logPaymentEvent(db, taskId, 'settle_failed', { error: String(err) });
      }
    }
  }

  await db.run(
    `UPDATE tasks SET status = 'verified', verified_at = ? WHERE task_id = ?`,
    now, taskId
  );

  // Create chain entry of type 'task_verified'
  const verifyDataHash = bytesToHex(sha256(new TextEncoder().encode(
    canonicalJson({ task_id: taskId, verified_at: now, verified_by: agentId })
  )));
  const chainEntry = await createTaskChainEntry(db, agentId, 'task_verified', verifyDataHash);

  // Boost deliverer's reputation (contribution + pass_rate)
  if (task.claimed_by_agent_id) {
    try {
      const rep = await computeReputation(task.claimed_by_agent_id, db);
      await db.run(
        'UPDATE agents SET reputation_score = ? WHERE id = ?',
        rep.final_score, task.claimed_by_agent_id
      );
    } catch {
      // Non-fatal — reputation update is best-effort
    }
  }

  // Notify claimer via webhook
  if (task.claimed_by_agent_id) {
    const claimer = await db.get<{ id: string; webhook_url: string | null }>(
      'SELECT id, webhook_url FROM agents WHERE id = ?', task.claimed_by_agent_id
    );
    if (claimer?.webhook_url) {
      fireWebhook(claimer.webhook_url, {
        type: 'task.verified',
        agent_id: claimer.id,
        task_id: taskId,
        chain_sequence: chainEntry.sequence,
        chain_entry_hash: chainEntry.entry_hash,
        payment_settled: settlementResult.payment_status === 'settled',
        payment_tx_hash: settlementResult.tx_hash ?? null,
      });
    }
  }

  const response: Record<string, unknown> = {
    ok: true,
    task_id: taskId,
    chain_sequence: chainEntry.sequence,
    chain_entry_hash: chainEntry.entry_hash,
    status: 'verified',
  };
  if (settlementResult.payment_status !== 'none') {
    response.payment_status = settlementResult.payment_status;
    if (settlementResult.tx_hash) {
      response.payment_tx_hash = settlementResult.tx_hash;
    }
  }

  return c.json(response);
});

/**
 * POST /v1/tasks/:id/dispute — Creator disputes deliverable (pauses auto-release)
 */
tasks.post('/:id/dispute', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id');
  const db = c.get('db');

  const task = await db.get<{
    task_id: string;
    creator_agent_id: string;
    claimed_by_agent_id: string | null;
    status: string;
    payment_status: string;
  }>(
    'SELECT task_id, creator_agent_id, claimed_by_agent_id, status, payment_status FROM tasks WHERE task_id = ?', taskId
  );
  if (!task) {
    return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  }

  // Only creator can dispute
  if (task.creator_agent_id !== agentId) {
    return c.json({ error: 'forbidden', message: 'Only the task creator can dispute deliverables' }, 403);
  }

  // Task must be submitted (not yet verified, not already disputed)
  if (task.status !== 'submitted') {
    return c.json({ error: 'bad_request', message: 'Task must be in submitted status to dispute' }, 400);
  }

  let body: Record<string, unknown> = {};
  try { body = JSON.parse(await c.req.text()) as Record<string, unknown>; } catch { /* no body required */ }
  const reason = typeof body.reason === 'string' ? body.reason : null;

  const now = new Date().toISOString();

  // Update payment status to disputed if there's an authorized payment
  if (task.payment_status === 'authorized') {
    await db.run(
      `UPDATE tasks SET payment_status = 'disputed', auto_release_at = NULL WHERE task_id = ?`, taskId
    );
    await logPaymentEvent(db, taskId, 'disputed', { reason, disputed_by: agentId });
  }

  // Update task status — we keep status as 'submitted' but mark it disputed via payment_status
  // This is because 'disputed' is a payment state, not a task lifecycle state
  // The task can still be verified (accepting the work) or cancelled
  if (task.payment_status === 'authorized') {
    // Already updated above
  } else {
    // No payment — just log the dispute
    await logPaymentEvent(db, taskId, 'disputed', { reason, disputed_by: agentId, note: 'no_payment' });
  }

  // Notify claimer via webhook
  if (task.claimed_by_agent_id) {
    const claimer = await db.get<{ id: string; webhook_url: string | null }>(
      'SELECT id, webhook_url FROM agents WHERE id = ?', task.claimed_by_agent_id
    );
    if (claimer?.webhook_url) {
      fireWebhook(claimer.webhook_url, {
        type: 'task.disputed',
        agent_id: claimer.id,
        task_id: taskId,
        reason,
      });
    }
  }

  return c.json({
    ok: true,
    task_id: taskId,
    payment_status: task.payment_status === 'authorized' ? 'disputed' : task.payment_status,
  });
});

/**
 * POST /v1/tasks/:id/cancel — Creator cancels task
 */
tasks.post('/:id/cancel', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id');
  const db = c.get('db');

  const task = await db.get<{ task_id: string; creator_agent_id: string; claimed_by_agent_id: string | null; status: string; payment_status: string }>(
    'SELECT task_id, creator_agent_id, claimed_by_agent_id, status, payment_status FROM tasks WHERE task_id = ?', taskId
  );
  if (!task) {
    return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  }

  // Only creator can cancel
  if (task.creator_agent_id !== agentId) {
    return c.json({ error: 'forbidden', message: 'Only the task creator can cancel tasks' }, 403);
  }

  // Task must be open or claimed
  if (task.status !== 'open' && task.status !== 'claimed') {
    return c.json({ error: 'bad_request', message: 'Task can only be cancelled when open or claimed' }, 400);
  }

  await db.run(
    `UPDATE tasks SET status = 'cancelled' WHERE task_id = ?`,
    taskId
  );

  // If payment was authorized, mark it as expired (not settled, funds stay with creator)
  if (task.payment_status === 'authorized') {
    await db.run(
      `UPDATE tasks SET payment_status = 'expired' WHERE task_id = ?`, taskId
    );
    await logPaymentEvent(db, taskId, 'expired', { reason: 'task_cancelled' });
  }

  // If was claimed, notify claimer via webhook
  if (task.claimed_by_agent_id) {
    const claimer = await db.get<{ id: string; webhook_url: string | null }>(
      'SELECT id, webhook_url FROM agents WHERE id = ?', task.claimed_by_agent_id
    );
    if (claimer?.webhook_url) {
      fireWebhook(claimer.webhook_url, {
        type: 'task.cancelled',
        agent_id: claimer.id,
        task_id: taskId,
      });
    }
  }

  return c.json({ ok: true, task_id: taskId, status: 'cancelled' });
});

export default tasks;
