import { Hono } from 'hono';
import type { AppEnv } from '../types/index.js';
import { scan as workerScan } from '../scanner/index.js';

const scan = new Hono<AppEnv>();

// ─── In-memory rate limiter: 5 scans/min per IP ───

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// Periodic cleanup to avoid memory leaks (best-effort, once per minute)
let lastCleanup = Date.now();
function maybeCleanupRateLimit() {
  const now = Date.now();
  if (now - lastCleanup < RATE_WINDOW_MS) return;
  lastCleanup = now;
  for (const [key, val] of rateLimitMap.entries()) {
    if (now >= val.resetAt) rateLimitMap.delete(key);
  }
}

// ─── Types ───

interface ScanFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  file: string;
  line?: number;
  snippet?: string;
  description: string;
}

interface ScanReport {
  id?: string;
  package_name: string;
  package_version: string;
  score: number;
  grade: string;
  findings: ScanFinding[];
  metadata: Record<string, unknown>;
  basedagents: Record<string, unknown>;
  scanned_at: string;
  submitted_by?: string;
}

// ─── POST /v1/scan/trigger — Trigger a server-side scan ───
scan.post('/trigger', async (c) => {
  maybeCleanupRateLimit();

  // Rate limiting
  const ip =
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown';

  if (!checkRateLimit(ip)) {
    return c.json({
      error: 'rate_limited',
      message: 'Too many scan requests. Limit: 5 scans per minute per IP.',
    }, 429);
  }

  // Parse body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  }

  const { package: packageName, version = 'latest' } = body as { package?: string; version?: string };

  if (!packageName || typeof packageName !== 'string' || !packageName.trim()) {
    return c.json({ error: 'bad_request', message: 'package name is required' }, 400);
  }

  const db = c.get('db') || null;

  let report;
  try {
    report = await workerScan(packageName.trim(), { db, version: version || 'latest' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg === 'PACKAGE_NOT_FOUND') {
      return c.json({ error: 'not_found', message: `Package "${packageName}" not found on npm` }, 404);
    }
    if (msg.startsWith('TARBALL_TOO_LARGE')) {
      return c.json({ error: 'payload_too_large', message: 'Package tarball exceeds 50 MB limit' }, 413);
    }
    if (msg === 'SCAN_TIMEOUT') {
      return c.json({ error: 'gateway_timeout', message: 'Scan timed out after 30 seconds' }, 504);
    }

    console.error('[scan/trigger] Scan error:', err);
    return c.json({ error: 'internal_error', message: 'Scan failed unexpectedly' }, 500);
  }

  // Store the report (reuse POST /v1/scan DB logic)
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  if (db) {
    try {
      await db.run(
        `INSERT INTO scan_reports (id, package_name, package_version, score, grade, findings_json, metadata_json, basedagents_json, scanned_at, submitted_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(package_name, package_version) DO UPDATE SET
           id = excluded.id,
           score = excluded.score,
           grade = excluded.grade,
           findings_json = excluded.findings_json,
           metadata_json = excluded.metadata_json,
           basedagents_json = excluded.basedagents_json,
           scanned_at = excluded.scanned_at,
           submitted_by = excluded.submitted_by`,
        id,
        report.package,
        report.version,
        Math.round(report.score),
        report.grade,
        JSON.stringify(report.findings || []),
        JSON.stringify(report.metadata || {}),
        JSON.stringify(report.basedagents || {}),
        report.scanned_at,
        'web-trigger',
        now
      );
    } catch (err) {
      console.error('[scan/trigger] DB insert error:', err);
      // Don't fail the request — return the report even if storage fails
    }
  }

  const criticalHighCount = report.findings.filter(
    f => f.severity === 'critical' || f.severity === 'high'
  ).length;

  const encodedPkg = encodeURIComponent(report.package);
  const reportUrl = `https://basedagents.ai/scan/${encodedPkg}?version=${encodeURIComponent(report.version)}`;

  return c.json({
    ok: true,
    id,
    package_name: report.package,
    package_version: report.version,
    score: Math.round(report.score),
    grade: report.grade,
    finding_count: report.findings.length,
    critical_high_count: criticalHighCount,
    report_url: reportUrl,
    message: 'Scan complete',
  });
});

// ─── POST /v1/scan — Submit a scan report ───
scan.post('/', async (c) => {
  const db = c.get('db');
  if (!db) return c.json({ error: 'db_unavailable', message: 'Database not available' }, 503);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  }

  const report = body as ScanReport;

  // Basic validation
  if (!report.package_name || typeof report.package_name !== 'string') {
    return c.json({ error: 'bad_request', message: 'package_name is required' }, 400);
  }
  if (!report.package_version || typeof report.package_version !== 'string') {
    return c.json({ error: 'bad_request', message: 'package_version is required' }, 400);
  }
  if (typeof report.score !== 'number' || report.score < 0 || report.score > 100) {
    return c.json({ error: 'bad_request', message: 'score must be a number 0-100' }, 400);
  }
  if (!report.grade || typeof report.grade !== 'string') {
    return c.json({ error: 'bad_request', message: 'grade is required' }, 400);
  }
  if (!Array.isArray(report.findings)) {
    return c.json({ error: 'bad_request', message: 'findings must be an array' }, 400);
  }

  const id = report.id || crypto.randomUUID();
  const now = new Date().toISOString();
  const scannedAt = report.scanned_at || now;

  try {
    // Upsert — last write wins on same package@version
    await db.run(
      `INSERT INTO scan_reports (id, package_name, package_version, score, grade, findings_json, metadata_json, basedagents_json, scanned_at, submitted_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(package_name, package_version) DO UPDATE SET
         id = excluded.id,
         score = excluded.score,
         grade = excluded.grade,
         findings_json = excluded.findings_json,
         metadata_json = excluded.metadata_json,
         basedagents_json = excluded.basedagents_json,
         scanned_at = excluded.scanned_at,
         submitted_by = excluded.submitted_by`,
      id,
      report.package_name,
      report.package_version,
      Math.round(report.score),
      report.grade,
      JSON.stringify(report.findings || []),
      JSON.stringify(report.metadata || {}),
      JSON.stringify(report.basedagents || {}),
      scannedAt,
      report.submitted_by || null,
      now
    );

    const encodedPkg = encodeURIComponent(report.package_name);
    const reportUrl = `https://basedagents.ai/scan/${encodedPkg}?version=${encodeURIComponent(report.package_version)}`;

    return c.json({
      ok: true,
      id,
      package_name: report.package_name,
      package_version: report.package_version,
      score: Math.round(report.score),
      grade: report.grade,
      report_url: reportUrl,
      message: `Scan report submitted. View at: ${reportUrl}`,
    }, 201);
  } catch (err) {
    console.error('[scan] Insert error:', err);
    return c.json({ error: 'internal_error', message: 'Failed to store scan report' }, 500);
  }
});

// ─── GET /v1/scan — List recently scanned packages ───
scan.get('/', async (c) => {
  const db = c.get('db');
  if (!db) return c.json({ error: 'db_unavailable', message: 'Database not available' }, 503);

  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10));
  const sort = c.req.query('sort') === 'score' ? 'score DESC' : 'scanned_at DESC';

  try {
    const rows = await db.all<{
      id: string;
      package_name: string;
      package_version: string;
      score: number;
      grade: string;
      findings_json: string;
      scanned_at: string;
      submitted_by: string | null;
    }>(
      `SELECT id, package_name, package_version, score, grade, findings_json, scanned_at, submitted_by
       FROM scan_reports
       ORDER BY ${sort}
       LIMIT ? OFFSET ?`,
      limit, offset
    );

    const countRow = await db.get<{ count: number }>('SELECT COUNT(*) as count FROM scan_reports');

    const packages = rows.map(row => {
      const findings = JSON.parse(row.findings_json || '[]') as ScanFinding[];
      const criticalHigh = findings.filter(f => f.severity === 'critical' || f.severity === 'high').length;
      return {
        id: row.id,
        package_name: row.package_name,
        package_version: row.package_version,
        score: row.score,
        grade: row.grade,
        finding_count: findings.length,
        critical_high_count: criticalHigh,
        scanned_at: row.scanned_at,
        submitted_by: row.submitted_by,
        report_url: `https://basedagents.ai/scan/${encodeURIComponent(row.package_name)}`,
      };
    });

    return c.json({
      ok: true,
      packages,
      pagination: {
        limit,
        offset,
        total: countRow?.count ?? 0,
      },
    });
  } catch (err) {
    console.error('[scan] List error:', err);
    return c.json({ error: 'internal_error', message: 'Failed to list scan reports' }, 500);
  }
});

// ─── GET /v1/scan/:package — Get scan report for a package ───
scan.get('/:package', async (c) => {
  const db = c.get('db');
  if (!db) return c.json({ error: 'db_unavailable', message: 'Database not available' }, 503);

  // Hono encodes path params but let's be safe
  const rawPkg = decodeURIComponent(c.req.param('package'));
  const version = c.req.query('version');

  try {
    let row: {
      id: string;
      package_name: string;
      package_version: string;
      score: number;
      grade: string;
      findings_json: string;
      metadata_json: string;
      basedagents_json: string;
      scanned_at: string;
      submitted_by: string | null;
      created_at: string;
    } | null = null;

    if (version) {
      row = await db.get(
        `SELECT * FROM scan_reports WHERE package_name = ? AND package_version = ? LIMIT 1`,
        rawPkg, version
      );
    } else {
      row = await db.get(
        `SELECT * FROM scan_reports WHERE package_name = ? ORDER BY scanned_at DESC LIMIT 1`,
        rawPkg
      );
    }

    if (!row) {
      return c.json({
        error: 'not_found',
        message: `Package not yet scanned. Run: npx basedagents scan ${rawPkg}`,
        package_name: rawPkg,
        scan_command: `npx basedagents scan ${rawPkg}`,
        submit_url: 'POST /v1/scan',
      }, 404);
    }

    return c.json({
      ok: true,
      id: row.id,
      package_name: row.package_name,
      package_version: row.package_version,
      score: row.score,
      grade: row.grade,
      findings: JSON.parse(row.findings_json || '[]'),
      metadata: JSON.parse(row.metadata_json || '{}'),
      basedagents: JSON.parse(row.basedagents_json || '{}'),
      scanned_at: row.scanned_at,
      submitted_by: row.submitted_by,
      created_at: row.created_at,
    });
  } catch (err) {
    console.error('[scan] Get error:', err);
    return c.json({ error: 'internal_error', message: 'Failed to retrieve scan report' }, 500);
  }
});

export default scan;
