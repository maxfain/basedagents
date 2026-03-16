/**
 * Universal scanner entry point.
 *
 * Maintains full backward compatibility:
 *   - `scan(packageName, options)` still works exactly as before (npm)
 *   - `scanGitHub(owner, repo, ref, options)` for GitHub repos
 *   - `scanFiles()` / `computeScore()` / `computeGrade()` are now in core.ts
 *
 * No fs, no child_process — works in Cloudflare Workers.
 */

import type { DBAdapter } from '../db/adapter.js';
import { resolveNpm }    from './resolvers/npm.js';
import { resolveGitHub } from './resolvers/github.js';
import { scanFiles, computeScore, computeGrade } from './core.js';

export type { Finding, ScanReport, FileEntry, SourceMetadata, PatternDef } from './core.js';
export { computeScore, computeGrade, scanFiles };
export { resolveNpm }    from './resolvers/npm.js';
export { resolveGitHub, parseGitHubTarget } from './resolvers/github.js';

// ─── Constants ───

const SCAN_TIMEOUT_MS = 30_000;

// ─── npm scan (backward-compatible) ───

export interface ScanOptions {
  db?: DBAdapter | null;
  version?: string;
}

/**
 * Scan an npm package by name.
 * Identical external interface as before — callers need no changes.
 */
export async function scan(packageName: string, options: ScanOptions = {}) {
  const version = options.version || 'latest';
  const db = options.db ?? null;

  const scanPromise = _scanNpm(packageName, version, db);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('SCAN_TIMEOUT')), SCAN_TIMEOUT_MS)
  );

  return Promise.race([scanPromise, timeoutPromise]);
}

async function _scanNpm(packageName: string, version: string, db: DBAdapter | null) {
  const { files, metadata, pkgJson } = await resolveNpm(packageName, version);

  const report = await scanFiles(files, metadata, db);

  // Augment metadata with npm-specific fields from package.json
  const installScriptKeys = ['preinstall', 'install', 'postinstall', 'prepare'];
  const scripts = pkgJson?.scripts ?? (metadata.extra.scripts as Record<string, string> | undefined) ?? {};
  const hasInstallScripts = installScriptKeys.some(k => scripts[k]);

  const depCount = (metadata.extra.dependency_count as number | undefined) ?? 0;
  const binField = pkgJson?.bin ?? metadata.extra.bin;

  // Inject npm-specific info findings
  if (hasInstallScripts) {
    for (const key of installScriptKeys) {
      const script = scripts[key];
      if (script) {
        const infoCount = report.findings.filter(f => f.severity === 'info').length;
        if (infoCount < 20) {
          report.findings.push({
            severity: 'info',
            category: 'Install Script',
            pattern: key,
            file: 'package.json',
            line: 0,
            context: `"${key}": "${script}"`,
            description: `Package has a ${key} script that runs automatically on npm install`,
          });
        }
      }
    }
  }

  if (binField) {
    const infoCount = report.findings.filter(f => f.severity === 'info').length;
    if (infoCount < 20) {
      const binEntries = typeof binField === 'string' ? [binField] : Object.values(binField as Record<string, string>);
      report.findings.push({
        severity: 'info',
        category: 'Package Metadata',
        pattern: 'bin entries',
        file: 'package.json',
        line: 0,
        context: `bin: ${JSON.stringify(binField)}`,
        description: `Package exposes ${binEntries.length} CLI bin entr${binEntries.length === 1 ? 'y' : 'ies'}`,
      });
    }
  }

  {
    const infoCount = report.findings.filter(f => f.severity === 'info').length;
    if (infoCount < 20) {
      report.findings.push({
        severity: 'info',
        category: 'Package Metadata',
        pattern: 'dependency count',
        file: 'package.json',
        line: 0,
        context: `dependencies: ${depCount}`,
        description: `Package has ${depCount} total dependencies`,
      });
    }
  }

  // Recompute score to include new info findings (they don't affect score, but keep consistent)
  report.metadata.has_install_scripts = hasInstallScripts;
  report.metadata.dependency_count = depCount;

  return report;
}

// ─── GitHub scan ───

export interface GitHubScanOptions {
  db?: DBAdapter | null;
  ref?: string;
  githubToken?: string;
}

/**
 * Scan a GitHub repository by owner/repo.
 */
export async function scanGitHub(
  owner: string,
  repo: string,
  options: GitHubScanOptions = {},
) {
  const db = options.db ?? null;
  const { files, metadata } = await resolveGitHub(owner, repo, options.ref, options.githubToken);
  return scanFiles(files, metadata, db);
}
