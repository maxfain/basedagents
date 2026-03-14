import { Hono } from 'hono';
import type { AppEnv } from '../types/index.js';
import { CreateTaskSchema, SubmitDeliverableSchema, TaskQuerySchema } from '../types/index.js';
import { agentAuth } from '../middleware/auth.js';
import { fireWebhook } from '../lib/webhooks.js';

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

/**
 * POST /v1/tasks — Create a task
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

  await db.run(
    `INSERT INTO tasks (task_id, creator_agent_id, title, description, category, required_capabilities, expected_output, output_format, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    taskId, creatorId,
    parsed.data.title, parsed.data.description,
    parsed.data.category ?? null,
    reqCaps ? JSON.stringify(reqCaps) : null,
    parsed.data.expected_output ?? null,
    parsed.data.output_format,
    now
  );

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
            },
          });
        }
      } catch {
        // skip agents with invalid capabilities JSON
      }
    }
  }

  return c.json({ ok: true, task_id: taskId, status: 'open' });
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

  // Parse required_capabilities JSON for response
  const tasks_list = rows.map((row) => ({
    ...row,
    required_capabilities: row.required_capabilities ? JSON.parse(row.required_capabilities as string) : null,
  }));

  return c.json({ ok: true, tasks: tasks_list });
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

  // Include submission if task has been submitted
  let submission = null;
  if (task.status === 'submitted' || task.status === 'verified') {
    submission = await db.get<Record<string, unknown>>(
      'SELECT * FROM submissions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', taskId
    );
  }

  return c.json({ ok: true, task, submission });
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

  const now = new Date().toISOString();
  await db.run(
    `UPDATE tasks SET claimed_by_agent_id = ?, status = 'claimed', claimed_at = ? WHERE task_id = ?`,
    agentId, now, taskId
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
 * POST /v1/tasks/:id/submit — Submit deliverable
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

  const task = await db.get<{ task_id: string; creator_agent_id: string; claimed_by_agent_id: string | null; status: string }>(
    'SELECT task_id, creator_agent_id, claimed_by_agent_id, status FROM tasks WHERE task_id = ?', taskId
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

  await db.run(
    `UPDATE tasks SET status = 'submitted', submitted_at = ? WHERE task_id = ?`,
    now, taskId
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
 * POST /v1/tasks/:id/verify — Creator verifies deliverable
 */
tasks.post('/:id/verify', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id');
  const db = c.get('db');

  const task = await db.get<{ task_id: string; creator_agent_id: string; claimed_by_agent_id: string | null; status: string }>(
    'SELECT task_id, creator_agent_id, claimed_by_agent_id, status FROM tasks WHERE task_id = ?', taskId
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
  await db.run(
    `UPDATE tasks SET status = 'verified', verified_at = ? WHERE task_id = ?`,
    now, taskId
  );

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
      });
    }
  }

  return c.json({ ok: true, task_id: taskId, status: 'verified' });
});

/**
 * POST /v1/tasks/:id/cancel — Creator cancels task
 */
tasks.post('/:id/cancel', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id');
  const db = c.get('db');

  const task = await db.get<{ task_id: string; creator_agent_id: string; claimed_by_agent_id: string | null; status: string }>(
    'SELECT task_id, creator_agent_id, claimed_by_agent_id, status FROM tasks WHERE task_id = ?', taskId
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
