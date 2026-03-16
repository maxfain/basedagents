/**
 * Shared scanner core — source-agnostic.
 *
 * Accepts FileEntry[] + SourceMetadata from any resolver (npm, GitHub, PyPI, …)
 * and returns a ScanReport using the same pattern-matching engine.
 *
 * Works in Cloudflare Workers (no fs, no child_process).
 */

/** Bump this whenever patterns, scoring, or grading logic changes. */
export const SCANNER_VERSION = 2;

import type { DBAdapter } from '../db/adapter.js';
import { PATTERNS as JS_PATTERNS }          from './patterns/javascript.js';
import { PATTERNS as PYTHON_PATTERNS }      from './patterns/python.js';
import { PATTERNS as RUST_PATTERNS }        from './patterns/rust.js';
import { PATTERNS as SHELL_PATTERNS }       from './patterns/shell.js';
import { PATTERNS as YAML_PATTERNS }        from './patterns/yaml.js';
import { PATTERNS as DOCKERFILE_PATTERNS }  from './patterns/dockerfile.js';

// ─── Public types ───

export interface Finding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  pattern: string;
  file: string;
  line: number;
  context: string;
  description: string;
}

export interface ScanReport {
  package: string;
  version: string;
  source: 'npm' | 'github' | 'pypi';
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  findings: Finding[];
  metadata: {
    files_scanned: number;
    total_files: number;
    has_install_scripts: boolean;
    dependency_count: number;
    package_size_bytes: number;
    source_metadata?: SourceMetadata;
  };
  basedagents: {
    registered: boolean;
    verified: boolean;
    reputation_score: number | null;
    agent_id: string | null;
  };
  scanned_at: string;
}

export interface FileEntry {
  /** Relative path within the archive (e.g. "src/index.ts") */
  path: string;
  /** File contents as UTF-8 string */
  content: string;
  /** File size in bytes */
  size: number;
}

export interface SourceMetadata {
  /** Source type */
  source: 'npm' | 'github' | 'pypi';
  /** Package/repo name */
  name: string;
  /** Version, tag, or commit ref */
  version: string;
  /** Description from registry/repo */
  description?: string;
  /** Total size of all source files (bytes) */
  total_size: number;
  /** Number of files in archive */
  total_files: number;
  /** Number of scannable files */
  scannable_files: number;
  /** Source-specific metadata (stars, downloads, etc.) */
  extra: Record<string, unknown>;
}

// ─── PatternDef (shared by all pattern files) ───

export interface PatternDef {
  severity: Finding['severity'];
  category: string;
  pattern: string;
  regex: RegExp;
  description: string;
}

// ─── Language routing ───

function getPatternsForFile(filePath: string): PatternDef[] {
  const lastSlash = filePath.lastIndexOf('/');
  const basename = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  const dotIdx = basename.lastIndexOf('.');
  const ext = dotIdx >= 0 ? basename.slice(dotIdx).toLowerCase() : '';

  if (['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx'].includes(ext)) return JS_PATTERNS;
  if (['.py', '.pyx', '.pyi'].includes(ext))                          return PYTHON_PATTERNS;
  if (ext === '.rs')                                                   return RUST_PATTERNS;
  if (['.sh', '.bash'].includes(ext))                                  return SHELL_PATTERNS;
  if (['.yml', '.yaml'].includes(ext))                                 return YAML_PATTERNS;
  if (basename === 'Dockerfile' || basename.startsWith('Dockerfile.')) return DOCKERFILE_PATTERNS;
  return [];
}

// ─── Max findings per severity ───

const MAX_FINDINGS: Record<Finding['severity'], number> = {
  critical: 50,
  high: 50,
  medium: 30,
  low: 10,
  info: 20,
};

// ─── Scan a single file ───

function scanFileContent(
  text: string,
  relPath: string,
  patterns: PatternDef[],
  severityCounts: Record<Finding['severity'], number>,
): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split('\n');

  for (const def of patterns) {
    const maxCount = MAX_FINDINGS[def.severity];
    if ((severityCounts[def.severity] ?? 0) >= maxCount) continue;

    def.regex.lastIndex = 0;
    const seenLines = new Set<number>();

    for (let i = 0; i < lines.length; i++) {
      if ((severityCounts[def.severity] ?? 0) >= maxCount) break;

      const line = lines[i];
      def.regex.lastIndex = 0;
      const match = def.regex.exec(line);
      if (!match) continue;
      if (seenLines.has(i)) continue;
      seenLines.add(i);

      const context = line.trim().slice(0, 120);

      findings.push({
        severity: def.severity,
        category: def.category,
        pattern: def.pattern,
        file: relPath,
        line: i + 1,
        context,
        description: def.description,
      });

      severityCounts[def.severity] = (severityCounts[def.severity] ?? 0) + 1;
    }
  }

  return findings;
}

// ─── Score & Grade ───

export function computeScore(findings: Finding[]): number {
  const seen = new Set<string>();
  let score = 100;
  for (const f of findings) {
    const key = `${f.pattern}:${f.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    switch (f.severity) {
      case 'critical': score -= 25; break;
      case 'high':     score -= 10; break;
      case 'medium':   score -=  3; break;
      case 'low':      score -=  1; break;
      case 'info':                  break;
    }
  }
  return Math.max(0, score);
}

export function computeGrade(score: number): ScanReport['grade'] {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

// ─── BasedAgents lookup ───

interface AgentLookup {
  registered: boolean;
  verified: boolean;
  reputation_score: number | null;
  agent_id: string | null;
}

async function lookupBasedAgents(name: string, db: DBAdapter | null): Promise<AgentLookup> {
  if (!db) return { registered: false, verified: false, reputation_score: null, agent_id: null };
  try {
    const rows = await db.all<{
      id: string;
      status: string;
      reputation_score: number;
      verification_count: number;
      skills: string | null;
    }>(
      `SELECT id, status, reputation_score, verification_count, skills
       FROM agents
       WHERE skills IS NOT NULL
       LIMIT 50`
    );

    const match = rows.find(row => {
      if (!row.skills) return false;
      try {
        const skills = JSON.parse(row.skills) as Array<{ name: string }>;
        return skills.some(s => s.name === name || s.name === name.replace(/^@/, ''));
      } catch {
        return false;
      }
    });

    if (!match) return { registered: false, verified: false, reputation_score: null, agent_id: null };

    return {
      registered: true,
      verified: match.status === 'active' && match.verification_count >= 2,
      reputation_score: match.reputation_score,
      agent_id: match.id,
    };
  } catch {
    return { registered: false, verified: false, reputation_score: null, agent_id: null };
  }
}

// ─── Main scanner engine ───

export async function scanFiles(
  files: FileEntry[],
  metadata: SourceMetadata,
  db: DBAdapter | null,
): Promise<ScanReport> {
  const findings: Finding[] = [];
  let filesScanned = 0;
  let totalTextBytes = 0;
  let packageSizeBytes = 0;

  const MAX_TEXT_BYTES = 10 * 1024 * 1024; // 10 MB

  const severityCounts: Record<Finding['severity'], number> = {
    critical: 0, high: 0, medium: 0, low: 0, info: 0,
  };

  for (const file of files) {
    packageSizeBytes += file.size;

    const patterns = getPatternsForFile(file.path);
    if (patterns.length === 0) continue;
    if (totalTextBytes >= MAX_TEXT_BYTES) continue;

    totalTextBytes += file.content.length;
    filesScanned++;

    const fileFindings = scanFileContent(file.content, file.path, patterns, severityCounts);
    findings.push(...fileFindings);
  }

  // Score (exclude info findings)
  let score = computeScore(findings.filter(f => f.severity !== 'info'));

  // BasedAgents lookup
  const ba = await lookupBasedAgents(metadata.name, db);
  if (ba.registered) score = Math.min(100, score + 10);
  if (ba.verified)   score = Math.min(100, score + 10);

  const grade = computeGrade(score);

  return {
    package: metadata.name,
    version: metadata.version,
    source: metadata.source,
    score,
    grade,
    findings,
    metadata: {
      files_scanned: filesScanned,
      total_files: metadata.total_files,
      has_install_scripts: false, // resolvers set this via extra if applicable
      dependency_count: (metadata.extra.dependency_count as number | undefined) ?? 0,
      package_size_bytes: packageSizeBytes,
      source_metadata: metadata,
    },
    basedagents: ba,
    scanned_at: new Date().toISOString(),
  };
}
