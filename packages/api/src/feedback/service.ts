/**
 * Agent feedback and API telemetry (WS5, agent-first plan).
 *
 *   - Feedback: POST /v1/feedback stores a report (routes/feedback.ts) and
 *     notifies the operator by email (Resend) and Slack, if configured. The
 *     5-minute cron retries any notification that failed.
 *   - Telemetry: one upsert per agent-relevant request into api_usage_daily
 *     (CLI/skill version headers, signer, status, error code).
 *   - Digest: once a day, yesterday's counts go to the same channels: unique
 *     agents, versions in use, top error codes, 429s, feedback.
 *
 * Notify targets are env: FEEDBACK_NOTIFY_EMAIL, FEEDBACK_SLACK_WEBHOOK_URL.
 * With neither set, nothing is sent (and nothing is marked sent).
 */
import type { DBAdapter } from '../db/adapter.js';
import type { EmailSender } from '../control/email.js';

export interface FeedbackRow {
  feedback_id: string;
  agent_id: string | null;
  scope: 'task' | 'general';
  task_id: string | null;
  environment: string;
  expected_behavior: string;
  actual_behavior: string;
  steps_to_reproduce: string;
  error_codes: string | null;
  request_ids: string | null;
  suggested_improvement: string | null;
  skill_version: string | null;
  cli_version: string | null;
  user_agent: string | null;
  status: 'open' | 'fixed' | 'wont_fix';
  status_note: string | null;
  created_at: string;
  updated_at: string;
  notified_at: string | null;
}

interface NotifyEnv {
  FEEDBACK_NOTIFY_EMAIL?: string;
  FEEDBACK_SLACK_WEBHOOK_URL?: string;
}

const CONSOLE_FEEDBACK_URL = 'https://app.basedagents.ai/admin/feedback';
const list = (json: string | null): string[] => { try { return json ? JSON.parse(json) as string[] : []; } catch { return []; } };
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function feedbackMessage(row: FeedbackRow): { subject: string; text: string } {
  const who = row.agent_id ?? 'anonymous';
  const subject = `[BasedAgents feedback] ${row.scope}${row.task_id ? ` ${row.task_id}` : ''}: ${clip(row.actual_behavior.split('\n')[0], 80)}`;
  const lines = [
    `From: ${who}`,
    `Scope: ${row.scope}${row.task_id ? ` (task ${row.task_id})` : ''}`,
    `Skill: ${row.skill_version ?? '—'} · CLI: ${row.cli_version ?? '—'}`,
    `Environment: ${row.environment}`,
    '',
    `Expected:\n${row.expected_behavior}`,
    '',
    `Actual:\n${row.actual_behavior}`,
    '',
    `Steps:\n${row.steps_to_reproduce}`,
  ];
  const codes = list(row.error_codes);
  const reqs = list(row.request_ids);
  if (codes.length) lines.push('', `Error codes: ${codes.join(', ')}`);
  if (reqs.length) lines.push(`Request ids: ${reqs.join(', ')}`);
  if (row.suggested_improvement) lines.push('', `Suggested:\n${row.suggested_improvement}`);
  lines.push('', `${row.feedback_id} · triage: ${CONSOLE_FEEDBACK_URL}`);
  return { subject, text: lines.join('\n') };
}

/** Send one message to every configured channel. True when at least one accepted it. */
async function broadcast(env: NotifyEnv, sender: EmailSender, subject: string, text: string): Promise<boolean> {
  let delivered = false;
  if (env.FEEDBACK_NOTIFY_EMAIL) {
    try { await sender.send({ to: env.FEEDBACK_NOTIFY_EMAIL, subject, text }); delivered = true; }
    catch (err) { console.error('[feedback] email notify failed:', err instanceof Error ? err.message : err); }
  }
  if (env.FEEDBACK_SLACK_WEBHOOK_URL) {
    try {
      const res = await fetch(env.FEEDBACK_SLACK_WEBHOOK_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `*${subject}*\n${clip(text, 3500)}` }),
      });
      if (res.ok) delivered = true; else console.error(`[feedback] slack notify failed: HTTP ${res.status}`);
    } catch (err) { console.error('[feedback] slack notify failed:', err instanceof Error ? err.message : err); }
  }
  return delivered;
}

export function notifyConfigured(env: NotifyEnv): boolean {
  return !!(env.FEEDBACK_NOTIFY_EMAIL || env.FEEDBACK_SLACK_WEBHOOK_URL);
}

/** Notify about one report; marks notified_at on success. */
export async function notifyFeedback(db: DBAdapter, env: NotifyEnv, sender: EmailSender, row: FeedbackRow, nowIso: string): Promise<boolean> {
  if (!notifyConfigured(env)) return false;
  const { subject, text } = feedbackMessage(row);
  const ok = await broadcast(env, sender, subject, text);
  if (ok) await db.run('UPDATE feedback SET notified_at = ? WHERE feedback_id = ? AND notified_at IS NULL', nowIso, row.feedback_id);
  return ok;
}

/** Cron: retry notifications that didn't go out (older than 1 min, younger than 24 h). */
export async function retryFeedbackNotifications(db: DBAdapter, env: NotifyEnv, sender: EmailSender, nowIso: string): Promise<number> {
  if (!notifyConfigured(env)) return 0;
  const now = Date.parse(nowIso);
  const rows = await db.all<FeedbackRow>(
    `SELECT * FROM feedback WHERE notified_at IS NULL AND created_at < ? AND created_at > ? ORDER BY created_at LIMIT 20`,
    new Date(now - 60_000).toISOString(), new Date(now - 24 * 3_600_000).toISOString(),
  );
  let sent = 0;
  for (const row of rows) if (await notifyFeedback(db, env, sender, row, nowIso)) sent++;
  return sent;
}

// ─── Telemetry ───

export interface UsageRecord {
  day: string;
  agentId: string;
  cliVersion: string;
  skillVersion: string;
  status: number;
  errorCode: string;
}

export async function recordUsage(db: DBAdapter, r: UsageRecord): Promise<void> {
  await db.run(
    `INSERT INTO api_usage_daily (day, agent_id, cli_version, skill_version, status, error_code, count) VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(day, agent_id, cli_version, skill_version, status, error_code) DO UPDATE SET count = count + 1`,
    r.day, r.agentId, r.cliVersion, r.skillVersion, r.status, r.errorCode,
  );
}

/** Keep version headers short and printable before they reach the table or a log line. */
export function cleanVersion(v: string | undefined | null): string {
  return (v ?? '').replace(/[^0-9A-Za-z.+\-_]/g, '').slice(0, 32);
}

// ─── Daily digest ───

export interface Digest {
  day: string;
  requests: number;
  uniqueAgents: number;
  rateLimited: number;
  byCli: Array<{ version: string; requests: number; agents: number }>;
  bySkill: Array<{ version: string; requests: number; agents: number }>;
  topErrors: Array<{ status: number; code: string; count: number }>;
  feedback: { received: number; open: number };
}

export async function buildDigest(db: DBAdapter, day: string): Promise<Digest> {
  const n = async (sql: string, ...p: unknown[]) => (await db.get<{ n: number | null }>(sql, ...p))?.n ?? 0;
  const byVersion = (col: 'cli_version' | 'skill_version') => db.all<{ version: string; requests: number; agents: number }>(
    `SELECT ${col} AS version, SUM(count) AS requests, COUNT(DISTINCT NULLIF(agent_id, '')) AS agents
     FROM api_usage_daily WHERE day = ? AND ${col} != '' GROUP BY ${col} ORDER BY requests DESC LIMIT 10`, day,
  );
  const next = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString();
  return {
    day,
    requests: await n('SELECT SUM(count) AS n FROM api_usage_daily WHERE day = ?', day),
    uniqueAgents: await n(`SELECT COUNT(DISTINCT agent_id) AS n FROM api_usage_daily WHERE day = ? AND agent_id != ''`, day),
    rateLimited: await n('SELECT SUM(count) AS n FROM api_usage_daily WHERE day = ? AND status = 429', day),
    byCli: await byVersion('cli_version'),
    bySkill: await byVersion('skill_version'),
    topErrors: await db.all<{ status: number; code: string; count: number }>(
      `SELECT status, error_code AS code, SUM(count) AS count FROM api_usage_daily WHERE day = ? AND status >= 400
       GROUP BY status, error_code ORDER BY count DESC, status LIMIT 10`, day,
    ),
    feedback: {
      received: await n('SELECT COUNT(*) AS n FROM feedback WHERE created_at >= ? AND created_at < ?', `${day}T00:00:00.000Z`, next),
      open: await n(`SELECT COUNT(*) AS n FROM feedback WHERE status = 'open'`),
    },
  };
}

export function formatDigest(d: Digest): { subject: string; text: string } {
  const versions = (rows: Digest['byCli']) => rows.length ? rows.map((r) => `  ${r.version}: ${r.requests} requests, ${r.agents} agents`).join('\n') : '  (none)';
  const errors = d.topErrors.length ? d.topErrors.map((e) => `  ${e.status} ${e.code || '(no code)'}: ${e.count}`).join('\n') : '  (none)';
  return {
    subject: `[BasedAgents digest] ${d.day}: ${d.uniqueAgents} agents, ${d.feedback.received} feedback, ${d.rateLimited} × 429`,
    text: [
      `Agent traffic on ${d.day} (UTC)`,
      '',
      `Unique agents (signed): ${d.uniqueAgents}`,
      `Requests counted: ${d.requests}`,
      `429 rate-limited: ${d.rateLimited}`,
      `Feedback received: ${d.feedback.received} (open overall: ${d.feedback.open})`,
      '',
      'CLI versions:', versions(d.byCli),
      '',
      'Skill versions:', versions(d.bySkill),
      '',
      'Top error codes:', errors,
      '',
      `Triage feedback: ${CONSOLE_FEEDBACK_URL}`,
    ].join('\n'),
  };
}

/** The digest hour (UTC): the 5-minute cron sends yesterday's digest on its first run at or after it. */
export const DIGEST_HOUR_UTC = 7;

/**
 * Cron: send yesterday's digest once. job_runs makes it once-only across the
 * 288 cron runs a day. The marker is written even with no channel configured,
 * so the work isn't redone every 5 minutes.
 */
export async function runDailyDigest(db: DBAdapter, env: NotifyEnv, sender: EmailSender, now: Date): Promise<'sent' | 'no_channel' | 'already_sent' | 'not_yet'> {
  if (now.getUTCHours() < DIGEST_HOUR_UTC) return 'not_yet';
  const day = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const claimed = await db.run(`INSERT OR IGNORE INTO job_runs (job, run_key, ran_at) VALUES ('daily_digest', ?, ?)`, day, now.toISOString());
  if (claimed.changes === 0) return 'already_sent';
  if (!notifyConfigured(env)) return 'no_channel';
  const { subject, text } = formatDigest(await buildDigest(db, day));
  await broadcast(env, sender, subject, text);
  return 'sent';
}
