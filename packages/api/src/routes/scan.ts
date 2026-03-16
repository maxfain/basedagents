import { Hono } from 'hono';
import type { AppEnv } from '../types/index.js';
import { scan as workerScan, scanGitHub, scanPyPI, parseGitHubTarget } from '../scanner/index.js';
import { SCANNER_VERSION } from '../scanner/core.js';
import { computeProvenanceBonus } from '../scanner/provenance.js';
import { queueSingleReport, processRescanQueue } from '../scanner/rescan.js';
import { checkRateLimit as d1CheckRateLimit } from '../lib/rate-limiter.js';

const scan = new Hono<AppEnv>();

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
  source?: string;
  ref?: string;
  score: number;
  grade: string;
  findings: ScanFinding[];
  metadata: Record<string, unknown>;
  basedagents: Record<string, unknown>;
  scanned_at: string;
  submitted_by?: string;
}

type SourceType = 'npm' | 'github' | 'pypi';

// ─── DB helpers ───

interface StoreReportInput {
  package: string;
  version: string;
  source: string;
  ref?: string;
  score: number;
  grade: string;
  findings: unknown[];
  metadata: unknown;
  basedagents: unknown;
  scanned_at: string;
  scanner_version?: number;
}

async function storeReport(
  db: import('../db/adapter.js').DBAdapter,
  report: StoreReportInput,
  submittedBy: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const scannerVersion = report.scanner_version ?? SCANNER_VERSION;

  await db.run(
    `INSERT INTO scan_reports (id, package_name, package_version, source, ref, score, grade, findings_json, metadata_json, basedagents_json, scanned_at, submitted_by, created_at, scanner_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, package_name, package_version) DO UPDATE SET
       id = excluded.id,
       ref = excluded.ref,
       score = excluded.score,
       grade = excluded.grade,
       findings_json = excluded.findings_json,
       metadata_json = excluded.metadata_json,
       basedagents_json = excluded.basedagents_json,
       scanned_at = excluded.scanned_at,
       submitted_by = excluded.submitted_by,
       scanner_version = excluded.scanner_version`,
    id,
    report.package,
    report.version,
    report.source,
    report.ref ?? null,
    Math.round(report.score),
    report.grade,
    JSON.stringify(report.findings || []),
    JSON.stringify(report.metadata || {}),
    JSON.stringify(report.basedagents || {}),
    report.scanned_at,
    submittedBy,
    now,
    scannerVersion,
  );

  return id;
}

function makeReportUrl(source: string, packageName: string, version?: string): string {
  if (source === 'github') {
    const encoded = encodeURIComponent(`github:${packageName}`);
    return `https://basedagents.ai/scan/${encoded}`;
  }
  if (source === 'pypi') {
    const encoded = encodeURIComponent(`pypi:${packageName}`);
    return `https://basedagents.ai/scan/${encoded}`;
  }
  const encodedPkg = encodeURIComponent(packageName);
  const base = `https://basedagents.ai/scan/${encodedPkg}`;
  return version ? `${base}?version=${encodeURIComponent(version)}` : base;
}

// ─── POST /v1/scan/trigger — Trigger a server-side scan ───
scan.post('/trigger', async (c) => {
  const ip =
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown';

  const db = c.get('db') || null;

  // D1-based rate limit: 5 scans/min per IP (HIGH-1)
  if (db) {
    const rl = await d1CheckRateLimit(db, `scan:${ip}`, 5, 60_000);
    if (!rl.allowed) {
      const retryAfterSec = rl.retryAfterMs ? Math.ceil(rl.retryAfterMs / 1000) : 60;
      c.header('Retry-After', String(retryAfterSec));
      return c.json({
        error: 'rate_limited',
        message: 'Too many scan requests. Limit: 5 scans per minute per IP.',
      }, 429);
    }
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  }

  const {
    package: packageName,
    version = 'latest',
    source,
    target,
    ref,
  } = body as {
    package?: string;
    version?: string;
    source?: string;
    target?: string;
    ref?: string;
  };

  // Determine source type
  // - new API: { source: "github", target: "owner/repo", ref?: "main" }
  // - new API: { source: "npm", target: "lodash" }
  // - legacy:  { package: "lodash", version: "latest" }
  let effectiveSource: SourceType;
  let effectiveTarget: string;

  if (source === 'github') {
    if (!target || typeof target !== 'string' || !target.trim()) {
      return c.json({ error: 'bad_request', message: 'target (owner/repo) is required for GitHub scans' }, 400);
    }
    effectiveSource = 'github';
    effectiveTarget = target.trim();
  } else if (source === 'pypi') {
    const pkg = target || packageName;
    if (!pkg || typeof pkg !== 'string' || !pkg.trim()) {
      return c.json({ error: 'bad_request', message: 'target (package name) is required for PyPI scans' }, 400);
    }
    effectiveSource = 'pypi';
    effectiveTarget = pkg.trim();
  } else if (source === 'npm') {
    const pkg = target || packageName;
    if (!pkg || typeof pkg !== 'string' || !pkg.trim()) {
      return c.json({ error: 'bad_request', message: 'target or package name is required' }, 400);
    }
    effectiveSource = 'npm';
    effectiveTarget = pkg.trim();
  } else {
    // Legacy: no source field, use package
    if (!packageName || typeof packageName !== 'string' || !packageName.trim()) {
      return c.json({ error: 'bad_request', message: 'package name is required' }, 400);
    }
    effectiveSource = 'npm';
    effectiveTarget = packageName.trim();
  }

  let report;
  try {
    if (effectiveSource === 'github') {
      // Parse "owner/repo", "https://github.com/owner/repo", or "github:owner/repo"
      const { owner, repo } = parseGitHubTarget(effectiveTarget);
      report = await scanGitHub(owner, repo, {
        db,
        ref: ref || undefined,
        githubToken: (c.env as Record<string, string>)?.GITHUB_TOKEN,
      });
    } else if (effectiveSource === 'pypi') {
      report = await scanPyPI(effectiveTarget, { db, version: version === 'latest' ? undefined : version || undefined });
    } else {
      report = await workerScan(effectiveTarget, { db, version: version || 'latest' });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg === 'PACKAGE_NOT_FOUND')      return c.json({ error: 'not_found',        message: `Package "${effectiveTarget}" not found` }, 404);
    if (msg === 'WHEEL_ONLY_PACKAGE')     return c.json({ error: 'not_supported',    message: `Package "${effectiveTarget}" only provides wheel distributions. Sdist (source distribution) required for scanning.` }, 422);
    if (msg === 'GITHUB_REPO_NOT_FOUND')  return c.json({ error: 'not_found',        message: `GitHub repo "${effectiveTarget}" not found` }, 404);
    if (msg === 'GITHUB_RATE_LIMITED')    return c.json({ error: 'rate_limited',     message: 'GitHub API rate limit hit. Try again later.' }, 429);
    if (msg.startsWith('TARBALL_TOO_LARGE'))  return c.json({ error: 'payload_too_large', message: 'Tarball exceeds 50 MB limit' }, 413);
    if (msg === 'SCAN_TIMEOUT')           return c.json({ error: 'gateway_timeout',  message: 'Scan timed out after 30 seconds' }, 504);
    if (msg.startsWith('INVALID_GITHUB_TARGET')) return c.json({ error: 'bad_request', message: `Invalid GitHub target: "${effectiveTarget}". Use owner/repo format.` }, 400);

    console.error('[scan/trigger] Scan error:', err);
    return c.json({ error: 'internal_error', message: 'Scan failed unexpectedly' }, 500);
  }

  let id: string = crypto.randomUUID();
  if (db) {
    try {
      id = await storeReport(db, {
        package: report.package,
        version: report.version,
        source: report.source,
        ref: effectiveSource === 'github' ? report.version : undefined,
        score: report.score,
        grade: report.grade,
        findings: report.findings,
        metadata: report.metadata,
        basedagents: report.basedagents,
        scanned_at: report.scanned_at,
        scanner_version: SCANNER_VERSION,
      }, 'web-trigger');
    } catch (err) {
      console.error('[scan/trigger] DB insert error:', err);
    }
  }

  const criticalHighCount = report.findings.filter(
    f => f.severity === 'critical' || f.severity === 'high'
  ).length;

  const reportUrl = makeReportUrl(report.source, report.package, report.version);

  return c.json({
    ok: true,
    source: report.source,
    id,
    package_name: report.package,
    package_version: report.version,
    score: Math.round(report.score),
    grade: report.grade,
    finding_count: report.findings.length,
    critical_high_count: criticalHighCount,
    scanner_version: SCANNER_VERSION,
    report_url: reportUrl,
    message: 'Scan complete',
  });
});

// ─── POST /v1/scan — Submit a scan report ───
scan.post('/', async (c) => {
  // HIGH-3: Require admin bearer token for external scan report submission
  const adminSecret = (c.env as Record<string, string>)?.ADMIN_SECRET;
  if (adminSecret) {
    const auth = c.req.header('authorization');
    if (!auth || auth !== `Bearer ${adminSecret}`) {
      return c.json({ error: 'unauthorized', message: 'Scan report submission requires authentication' }, 401);
    }
  }

  const db = c.get('db');
  if (!db) return c.json({ error: 'db_unavailable', message: 'Database not available' }, 503);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  }

  const report = body as ScanReport;

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

  const source = (report.source as SourceType) || 'npm';
  const id = report.id || crypto.randomUUID();
  const now = new Date().toISOString();
  const scannedAt = report.scanned_at || now;
  const scannerVersion = (report as ScanReport & { scanner_version?: number }).scanner_version ?? SCANNER_VERSION;

  try {
    await db.run(
      `INSERT INTO scan_reports (id, package_name, package_version, source, ref, score, grade, findings_json, metadata_json, basedagents_json, scanned_at, submitted_by, created_at, scanner_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, package_name, package_version) DO UPDATE SET
         id = excluded.id,
         ref = excluded.ref,
         score = excluded.score,
         grade = excluded.grade,
         findings_json = excluded.findings_json,
         metadata_json = excluded.metadata_json,
         basedagents_json = excluded.basedagents_json,
         scanned_at = excluded.scanned_at,
         submitted_by = excluded.submitted_by,
         scanner_version = excluded.scanner_version`,
      id,
      report.package_name,
      report.package_version,
      source,
      report.ref ?? null,
      Math.round(report.score),
      report.grade,
      JSON.stringify(report.findings || []),
      JSON.stringify(report.metadata || {}),
      JSON.stringify(report.basedagents || {}),
      scannedAt,
      report.submitted_by || null,
      now,
      scannerVersion,
    );

    const reportUrl = makeReportUrl(source, report.package_name, report.package_version);

    return c.json({
      ok: true,
      source,
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

  const limit  = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10));
  const sort   = c.req.query('sort') === 'score' ? 'score DESC' : 'scanned_at DESC';
  const sourceFilter = c.req.query('source'); // optional: "npm" | "github"

  try {
    const whereClauses: string[] = [];
    const params: unknown[] = [];

    if (sourceFilter) {
      whereClauses.push('source = ?');
      params.push(sourceFilter);
    }

    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const rows = await db.all<{
      id: string;
      package_name: string;
      package_version: string;
      source: string;
      score: number;
      grade: string;
      findings_json: string;
      scanned_at: string;
      submitted_by: string | null;
      scanner_version: number | null;
    }>(
      `SELECT id, package_name, package_version, source, score, grade, findings_json, scanned_at, submitted_by, scanner_version
       FROM scan_reports
       ${where}
       ORDER BY ${sort}
       LIMIT ? OFFSET ?`,
      ...params, limit, offset
    );

    const countRow = await db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM scan_reports ${where}`,
      ...params
    );

    const packages = rows.map(row => {
      const findings = JSON.parse(row.findings_json || '[]') as ScanFinding[];
      const criticalHigh = findings.filter(f => f.severity === 'critical' || f.severity === 'high').length;
      const src = row.source || 'npm';
      return {
        id: row.id,
        source: src,
        package_name: row.package_name,
        package_version: row.package_version,
        score: row.score,
        grade: row.grade,
        finding_count: findings.length,
        critical_high_count: criticalHigh,
        scanned_at: row.scanned_at,
        submitted_by: row.submitted_by,
        scanner_version: row.scanner_version ?? 1,
        report_url: makeReportUrl(src, row.package_name),
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

// ─── GET /v1/scan/:package — Get scan report ───
scan.get('/:package', async (c) => {
  const db = c.get('db');
  if (!db) return c.json({ error: 'db_unavailable', message: 'Database not available' }, 503);

  const rawPkg = decodeURIComponent(c.req.param('package'));
  const version       = c.req.query('version');
  const sourceParam   = c.req.query('source');    // ?source=github
  const packageParam  = c.req.query('package');   // ?source=github&package=owner/repo

  // Resolve identifier:
  //   "lodash"             → npm, name="lodash"
  //   "github:owner/repo"  → github, name="owner/repo"
  //   "npm:lodash"         → npm, name="lodash"
  //   ?source=github&package=owner/repo → github
  let resolvedSource: string;
  let resolvedName: string;

  if (rawPkg.startsWith('github:')) {
    resolvedSource = 'github';
    resolvedName   = rawPkg.slice('github:'.length);
  } else if (rawPkg.startsWith('pypi:')) {
    resolvedSource = 'pypi';
    resolvedName   = rawPkg.slice('pypi:'.length);
  } else if (rawPkg.startsWith('npm:')) {
    resolvedSource = 'npm';
    resolvedName   = rawPkg.slice('npm:'.length);
  } else if (sourceParam) {
    resolvedSource = sourceParam;
    resolvedName   = packageParam || rawPkg;
  } else {
    resolvedSource = 'npm';
    resolvedName   = rawPkg;
  }

  try {
    let row: {
      id: string;
      package_name: string;
      package_version: string;
      source: string;
      ref: string | null;
      score: number;
      grade: string;
      findings_json: string;
      metadata_json: string;
      basedagents_json: string;
      scanned_at: string;
      submitted_by: string | null;
      created_at: string;
      scanner_version: number | null;
    } | null = null;

    

    if (version) {
      row = await db.get(
        `SELECT * FROM scan_reports WHERE source = ? AND package_name = ? AND package_version = ? LIMIT 1`,
        resolvedSource, resolvedName, version
      );
    } else {
      row = await db.get(
        `SELECT * FROM scan_reports WHERE source = ? AND package_name = ? ORDER BY scanned_at DESC LIMIT 1`,
        resolvedSource, resolvedName
      );
    }

    // Backward compat: if not found with source filter and rawPkg has no prefix, try without source
    if (!row && resolvedSource === 'npm' && !rawPkg.startsWith('npm:') && !sourceParam) {
      if (version) {
        row = await db.get(
          `SELECT * FROM scan_reports WHERE package_name = ? AND package_version = ? LIMIT 1`,
          resolvedName, version
        );
      } else {
        row = await db.get(
          `SELECT * FROM scan_reports WHERE package_name = ? ORDER BY scanned_at DESC LIMIT 1`,
          resolvedName
        );
      }
    }

    if (!row) {
      const scanCmd = resolvedSource === 'github'
        ? `npx basedagents scan github:${resolvedName}`
        : resolvedSource === 'pypi'
          ? `npx basedagents scan pypi:${resolvedName}`
          : `npx basedagents scan ${resolvedName}`;

      return c.json({
        error: 'not_found',
        message: `Not yet scanned. Run: ${scanCmd}`,
        source: resolvedSource,
        package_name: resolvedName,
        scan_command: scanCmd,
        submit_url: 'POST /v1/scan',
      }, 404);
    }

    return c.json({
      ok: true,
      id: row.id,
      source: row.source || 'npm',
      ref: row.ref || null,
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
      scanner_version: row.scanner_version ?? 1,
      provenance: (() => {
        try {
          const meta = JSON.parse(row.metadata_json || '{}');
          const extra = meta?.source_metadata?.extra ?? meta;
          const p = computeProvenanceBonus({
            source: (row.source ?? 'npm') as 'npm' | 'github' | 'pypi',
            name: row.package_name,
            version: row.package_version,
            total_size: 0,
            total_files: 0,
            scannable_files: 0,
            extra,
          });
          return p.bonus > 0 ? p : null;
        } catch { return null; }
      })(),
    });
  } catch (err) {
    console.error('[scan] Get error:', err);
    return c.json({ error: 'internal_error', message: 'Failed to retrieve scan report' }, 500);
  }
});

// ─── POST /v1/scan/:package/rescan — Trigger a re-scan ───
scan.post('/:package/rescan', async (c) => {
  const ip =
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown';

  const db = c.get('db');
  if (!db) return c.json({ error: 'db_unavailable', message: 'Database not available' }, 503);

  // D1-based rate limit: 5 scans/min per IP (HIGH-1)
  const rl = await d1CheckRateLimit(db, `scan:${ip}`, 5, 60_000);
  if (!rl.allowed) {
    const retryAfterSec = rl.retryAfterMs ? Math.ceil(rl.retryAfterMs / 1000) : 60;
    c.header('Retry-After', String(retryAfterSec));
    return c.json({
      error: 'rate_limited',
      message: 'Too many scan requests. Limit: 5 scans per minute per IP.',
    }, 429);
  }

  const rawPkg = decodeURIComponent(c.req.param('package'));

  // Resolve identifier
  let resolvedSource: string;
  let resolvedName: string;

  if (rawPkg.startsWith('github:')) {
    resolvedSource = 'github';
    resolvedName   = rawPkg.slice('github:'.length);
  } else if (rawPkg.startsWith('pypi:')) {
    resolvedSource = 'pypi';
    resolvedName   = rawPkg.slice('pypi:'.length);
  } else if (rawPkg.startsWith('npm:')) {
    resolvedSource = 'npm';
    resolvedName   = rawPkg.slice('npm:'.length);
  } else {
    resolvedSource = 'npm';
    resolvedName   = rawPkg;
  }

  // Look up existing report
  let existingReport: {
    id: string;
    source: string;
    package_name: string;
    package_version: string;
    ref: string | null;
  } | null = null;

  try {
    existingReport = await db.get(
      `SELECT id, source, package_name, package_version, ref FROM scan_reports
       WHERE source = ? AND package_name = ?
       ORDER BY scanned_at DESC LIMIT 1`,
      resolvedSource, resolvedName,
    );

    // Backward compat fallback
    if (!existingReport && resolvedSource === 'npm') {
      existingReport = await db.get(
        `SELECT id, source, package_name, package_version, ref FROM scan_reports
         WHERE package_name = ?
         ORDER BY scanned_at DESC LIMIT 1`,
        resolvedName,
      );
    }
  } catch (err) {
    console.error('[scan/rescan] DB lookup error:', err);
    return c.json({ error: 'internal_error', message: 'Failed to look up scan report' }, 500);
  }

  if (!existingReport) {
    return c.json({
      error: 'not_found',
      message: `No existing scan report found for "${resolvedName}". Run a scan first.`,
    }, 404);
  }

  // Perform synchronous rescan (scans typically complete in <10s)
  try {
    let report;

    if (existingReport.source === 'github') {
      const { owner, repo } = parseGitHubTarget(existingReport.package_name);
      report = await scanGitHub(owner, repo, {
        db,
        ref: existingReport.ref ?? undefined,
        githubToken: (c.env as Record<string, string>)?.GITHUB_TOKEN,
      });
    } else if (existingReport.source === 'pypi') {
      report = await scanPyPI(existingReport.package_name, {
        db,
        version: existingReport.package_version === 'latest' ? undefined : existingReport.package_version || undefined,
      });
    } else {
      report = await workerScan(existingReport.package_name, {
        db,
        version: existingReport.package_version || 'latest',
      });
    }

    const scannedAt = new Date().toISOString();
    await db.run(
      `UPDATE scan_reports
       SET score = ?,
           grade = ?,
           findings_json = ?,
           metadata_json = ?,
           basedagents_json = ?,
           scanned_at = ?,
           scanner_version = ?
       WHERE id = ?`,
      Math.round(report.score),
      report.grade,
      JSON.stringify(report.findings || []),
      JSON.stringify(report.metadata || {}),
      JSON.stringify(report.basedagents || {}),
      scannedAt,
      SCANNER_VERSION,
      existingReport.id,
    );

    return c.json({
      ok: true,
      message: 'Re-scan complete',
      package_name: report.package,
      source: report.source,
      score: Math.round(report.score),
      grade: report.grade,
      finding_count: report.findings.length,
      scanner_version: SCANNER_VERSION,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // On scan failure, fall back to queueing
    if (msg === 'SCAN_TIMEOUT' || msg.startsWith('TARBALL_TOO_LARGE')) {
      const { queued } = await queueSingleReport(db, existingReport.id);
      return c.json({
        ok: true,
        message: queued ? 'Re-scan queued' : 'Already queued for re-scan',
        package_name: existingReport.package_name,
        source: existingReport.source,
      });
    }

    if (msg === 'PACKAGE_NOT_FOUND' || msg === 'GITHUB_REPO_NOT_FOUND') {
      return c.json({ error: 'not_found', message: `Package "${resolvedName}" not found` }, 404);
    }

    console.error('[scan/rescan] Rescan error:', err);
    return c.json({ error: 'internal_error', message: 'Re-scan failed unexpectedly' }, 500);
  }
});

// ─── GET /v1/scan/queue/status — Queue status (admin/debug) ───
scan.get('/queue/status', async (c) => {
  const db = c.get('db');
  if (!db) return c.json({ error: 'db_unavailable', message: 'Database not available' }, 503);

  try {
    const statusRows = await db.all<{ status: string; count: number }>(
      `SELECT status, COUNT(*) as count FROM rescan_queue GROUP BY status`,
    );

    const counts: Record<string, number> = {};
    for (const row of statusRows) {
      counts[row.status] = row.count;
    }

    const staleRow = await db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM scan_reports WHERE scanner_version < ?`,
      SCANNER_VERSION,
    );

    return c.json({
      pending: counts['pending'] ?? 0,
      processing: counts['processing'] ?? 0,
      completed: counts['completed'] ?? 0,
      failed: counts['failed'] ?? 0,
      scanner_version: SCANNER_VERSION,
      stale_reports: staleRow?.count ?? 0,
    });
  } catch (err) {
    console.error('[scan/queue/status] Error:', err);
    return c.json({ error: 'internal_error', message: 'Failed to retrieve queue status' }, 500);
  }
});

export default scan;
