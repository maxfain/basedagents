/**
 * Rescan queue — auto-queue stale reports and process them.
 *
 * Works in Cloudflare Workers (no fs, no child_process).
 */

import type { DBAdapter } from '../db/adapter.js';
import { SCANNER_VERSION } from './core.js';
import { scan, scanGitHub, scanPyPI, parseGitHubTarget } from './index.js';

// ─── Types ───

interface RescanQueueItem {
  id: string;
  scan_report_id: string;
  source: string;
  package_name: string;
  package_version: string;
  ref: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  created_at: string;
  last_attempt_at: string | null;
  error: string | null;
}

// ─── Queue stale reports ───

/**
 * Queue all scan reports that were produced by an older scanner version.
 * Called on app startup / cron.
 */
export async function queueStaleReports(
  db: DBAdapter,
): Promise<{ queued: number }> {
  // Find all reports where scanner_version < SCANNER_VERSION
  const stale = await db.all<{
    id: string;
    source: string;
    package_name: string;
    package_version: string;
    ref: string | null;
  }>(
    `SELECT id, source, package_name, package_version, ref
     FROM scan_reports
     WHERE scanner_version < ?`,
    SCANNER_VERSION,
  );

  if (stale.length === 0) return { queued: 0 };

  let queued = 0;
  const now = new Date().toISOString();

  for (const row of stale) {
    try {
      await db.run(
        `INSERT OR IGNORE INTO rescan_queue
           (id, scan_report_id, source, package_name, package_version, ref, status, attempts, max_attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 3, ?)`,
        crypto.randomUUID(),
        row.id,
        row.source,
        row.package_name,
        row.package_version,
        row.ref ?? null,
        now,
      );
      queued++;
    } catch {
      // UNIQUE(scan_report_id) conflict — already queued, skip
    }
  }

  return { queued };
}

// ─── Process rescan queue ───

/**
 * Process up to N items from the rescan queue.
 * Called by cron job. Processes serially to avoid exceeding Worker CPU limits.
 */
export async function processRescanQueue(
  db: DBAdapter,
  limit = 5,
  options: { githubToken?: string } = {},
): Promise<{ processed: number; succeeded: number; failed: number }> {
  const items = await db.all<RescanQueueItem>(
    `SELECT * FROM rescan_queue
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT ?`,
    limit,
  );

  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  for (const item of items) {
    processed++;
    const now = new Date().toISOString();

    // Mark as processing
    await db.run(
      `UPDATE rescan_queue SET status = 'processing', last_attempt_at = ?, attempts = attempts + 1 WHERE id = ?`,
      now,
      item.id,
    );

    try {
      let report;

      if (item.source === 'github') {
        const { owner, repo } = parseGitHubTarget(item.package_name);
        report = await scanGitHub(owner, repo, {
          db,
          ref: item.ref ?? undefined,
          githubToken: options.githubToken,
        });
      } else if (item.source === 'pypi') {
        report = await scanPyPI(item.package_name, {
          db,
          version: item.package_version === 'latest' ? undefined : item.package_version,
        });
      } else {
        // npm
        report = await scan(item.package_name, {
          db,
          version: item.package_version || 'latest',
        });
      }

      // Update the existing scan report
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
        item.scan_report_id,
      );

      // Mark queue item as completed
      await db.run(
        `UPDATE rescan_queue SET status = 'completed', last_attempt_at = ? WHERE id = ?`,
        new Date().toISOString(),
        item.id,
      );

      succeeded++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const newAttempts = item.attempts + 1;
      const isFinal = newAttempts >= item.max_attempts;

      await db.run(
        `UPDATE rescan_queue
         SET status = ?,
             error = ?,
             last_attempt_at = ?
         WHERE id = ?`,
        isFinal ? 'failed' : 'pending',
        errorMsg,
        new Date().toISOString(),
        item.id,
      );

      failed++;
      console.error(`[rescan] Failed to rescan ${item.source}:${item.package_name} (attempt ${newAttempts}/${item.max_attempts}):`, err);
    }
  }

  return { processed, succeeded, failed };
}

// ─── Queue a single report for rescan ───

/**
 * Queue a single scan report for re-scanning.
 * Returns the queue item ID, or null if already queued.
 */
export async function queueSingleReport(
  db: DBAdapter,
  reportId: string,
): Promise<{ queued: boolean; queueItemId: string | null }> {
  const report = await db.get<{
    id: string;
    source: string;
    package_name: string;
    package_version: string;
    ref: string | null;
  }>(
    `SELECT id, source, package_name, package_version, ref FROM scan_reports WHERE id = ?`,
    reportId,
  );

  if (!report) return { queued: false, queueItemId: null };

  const queueItemId = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    await db.run(
      `INSERT OR IGNORE INTO rescan_queue
         (id, scan_report_id, source, package_name, package_version, ref, status, attempts, max_attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 3, ?)`,
      queueItemId,
      report.id,
      report.source,
      report.package_name,
      report.package_version,
      report.ref ?? null,
      now,
    );
    return { queued: true, queueItemId };
  } catch {
    // Already queued (UNIQUE constraint)
    return { queued: false, queueItemId: null };
  }
}
