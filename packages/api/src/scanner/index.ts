/**
 * Worker-compatible npm package security scanner.
 *
 * Fetches the tarball from registry.npmjs.org, extracts it in-memory using
 * DecompressionStream('gzip') + a custom tar parser, and runs pattern matching.
 *
 * No fs, no child_process, no npm pack — pure fetch + streaming APIs.
 */

import type { DBAdapter } from '../db/adapter.js';
import { parseTar } from './tar.js';

// ─── Types (mirror the SDK ScanReport) ───

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
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  findings: Finding[];
  metadata: {
    files_scanned: number;
    total_files: number;
    has_install_scripts: boolean;
    dependency_count: number;
    package_size_bytes: number;
  };
  basedagents: {
    registered: boolean;
    verified: boolean;
    reputation_score: number | null;
    agent_id: string | null;
  };
  scanned_at: string;
}

// ─── Pattern Definitions (copied exactly from packages/sdk/src/scanner/index.ts) ───

interface PatternDef {
  severity: Finding['severity'];
  category: string;
  pattern: string;
  regex: RegExp;
  description: string;
}

const PATTERNS: PatternDef[] = [
  // ── Critical: code execution ──
  {
    severity: 'critical',
    category: 'Code Execution',
    pattern: 'eval()',
    regex: /\beval\s*\(/g,
    description: 'Direct eval() call — can execute arbitrary code from strings',
  },
  {
    severity: 'critical',
    category: 'Code Execution',
    pattern: 'new Function()',
    regex: /new\s+Function\s*\(/g,
    description: 'new Function() — constructs and executes arbitrary code at runtime',
  },
  {
    severity: 'critical',
    category: 'Code Execution',
    pattern: 'vm.runInNewContext',
    regex: /\bvm\.runInNewContext\s*\(/g,
    description: 'vm.runInNewContext() — executes code in a new V8 context',
  },
  {
    severity: 'critical',
    category: 'Code Execution',
    pattern: 'vm.runInThisContext',
    regex: /\bvm\.runInThisContext\s*\(/g,
    description: 'vm.runInThisContext() — executes code in the current V8 context',
  },
  {
    severity: 'critical',
    category: 'Obfuscation',
    pattern: 'long hex string',
    regex: /[0-9a-f]{200,}/gi,
    description: 'Long hex string (>200 chars) — common obfuscation technique',
  },
  {
    severity: 'critical',
    category: 'Obfuscation',
    pattern: 'base64 code block',
    regex: /(?:[A-Za-z0-9+/]{40,}={0,2})(?:\s*\+\s*(?:[A-Za-z0-9+/]{40,}={0,2})){3,}/g,
    description: 'Large base64 block — may encode hidden executable code',
  },

  // ── High: shell execution ──
  {
    severity: 'high',
    category: 'Shell Execution',
    pattern: 'child_process import',
    regex: /require\s*\(\s*['"]child_process['"]\s*\)|from\s+['"]child_process['"]/g,
    description: 'Imports child_process module — can execute shell commands',
  },
  {
    severity: 'high',
    category: 'Shell Execution',
    pattern: 'exec/spawn call',
    regex: /\b(?:exec|spawn|execSync|execFileSync|fork)\s*\(/g,
    description: 'Shell execution function — can run arbitrary system commands',
  },

  // ── High: destructive file ops ──
  {
    severity: 'high',
    category: 'Destructive File Operation',
    pattern: 'fs.writeFile',
    regex: /\bfs(?:Promises)?\.writeFile\s*\(/g,
    description: 'fs.writeFile() — can overwrite files on disk',
  },
  {
    severity: 'high',
    category: 'Destructive File Operation',
    pattern: 'fs.unlink',
    regex: /\bfs(?:Promises)?\.unlink\s*\(/g,
    description: 'fs.unlink() — deletes files from disk',
  },
  {
    severity: 'high',
    category: 'Destructive File Operation',
    pattern: 'fs.rmdir / rm',
    regex: /\bfs(?:Promises)?\.(?:rmdir|rm)\s*\(/g,
    description: 'fs.rmdir()/rm() — deletes directories from disk',
  },
  {
    severity: 'high',
    category: 'Destructive File Operation',
    pattern: 'fs.chmod',
    regex: /\bfs(?:Promises)?\.chmod\s*\(/g,
    description: 'fs.chmod() — modifies file permissions',
  },
  {
    severity: 'high',
    category: 'Destructive File Operation',
    pattern: 'fs.rename',
    regex: /\bfs(?:Promises)?\.rename\s*\(/g,
    description: 'fs.rename() — moves or renames files',
  },

  // ── High: dynamic require/import ──
  {
    severity: 'high',
    category: 'Dynamic Require',
    pattern: 'dynamic require(variable)',
    regex: /require\s*\(\s*(?!['"` `])[^)]{1,80}\)/g,
    description: 'Dynamic require() with a variable argument — can load arbitrary modules at runtime',
  },
  {
    severity: 'high',
    category: 'Dynamic Import',
    pattern: 'dynamic import(variable)',
    regex: /\bimport\s*\(\s*(?!['"` `])[^)]{1,80}\)/g,
    description: 'Dynamic import() with a variable argument — can load arbitrary modules at runtime',
  },

  // ── High: credential harvesting ──
  {
    severity: 'high',
    category: 'Credential Harvesting',
    pattern: 'process.env access',
    regex: /\bprocess\.env\b/g,
    description: 'Accesses environment variables — may harvest API keys, tokens, or secrets',
  },

  // ── High: network calls ──
  {
    severity: 'high',
    category: 'Network Call',
    pattern: 'http.request',
    regex: /\bhttp\.request\s*\(/g,
    description: 'http.request() — makes outbound HTTP connections',
  },
  {
    severity: 'high',
    category: 'Network Call',
    pattern: 'https.request',
    regex: /\bhttps\.request\s*\(/g,
    description: 'https.request() — makes outbound HTTPS connections',
  },
  {
    severity: 'high',
    category: 'Network Call',
    pattern: 'net.connect',
    regex: /\bnet\.connect\s*\(/g,
    description: 'net.connect() — opens raw TCP socket connections',
  },
  {
    severity: 'high',
    category: 'Network Call',
    pattern: 'dgram (UDP)',
    regex: /\bdgram\b/g,
    description: 'UDP datagram socket usage — can exfiltrate data over UDP',
  },
  {
    severity: 'high',
    category: 'Network Call',
    pattern: 'fetch()',
    regex: /\bfetch\s*\(\s*(?!['"](?:https?:\/\/(?:localhost|127\.0\.0\.1)))[^)]{1,200}\)/g,
    description: 'fetch() to a non-localhost URL — makes outbound HTTP requests',
  },

  // ── Medium: file reads ──
  {
    severity: 'medium',
    category: 'File System Read',
    pattern: 'fs.readFile',
    regex: /\bfs(?:Promises)?\.readFile\s*\(/g,
    description: 'fs.readFile() — reads files from disk',
  },
  {
    severity: 'medium',
    category: 'File System Read',
    pattern: 'fs.readdir',
    regex: /\bfs(?:Promises)?\.readdir\s*\(/g,
    description: 'fs.readdir() — lists directory contents',
  },
  {
    severity: 'medium',
    category: 'File System Read',
    pattern: 'fs.stat',
    regex: /\bfs(?:Promises)?\.stat\s*\(/g,
    description: 'fs.stat() — reads file metadata',
  },

  // ── Medium: system info ──
  {
    severity: 'medium',
    category: 'System Info',
    pattern: 'os.homedir',
    regex: /\bos\.homedir\s*\(/g,
    description: "os.homedir() — discovers the current user's home directory",
  },
  {
    severity: 'medium',
    category: 'System Info',
    pattern: 'os.userInfo',
    regex: /\bos\.userInfo\s*\(/g,
    description: 'os.userInfo() — fetches username, uid, shell and other user details',
  },
  {
    severity: 'medium',
    category: 'System Info',
    pattern: 'os.hostname',
    regex: /\bos\.hostname\s*\(/g,
    description: 'os.hostname() — reads the machine hostname',
  },

  // ── Medium: crypto ──
  {
    severity: 'medium',
    category: 'Crypto Usage',
    pattern: 'crypto module',
    regex: /require\s*\(\s*['"]crypto['"]\s*\)|from\s+['"](?:node:)?crypto['"]/g,
    description: 'Uses the crypto module — could be for encryption or key generation',
  },

  // ── Medium: WebSocket ──
  {
    severity: 'medium',
    category: 'WebSocket',
    pattern: 'WebSocket connection',
    regex: /\bnew\s+WebSocket\s*\(/g,
    description: 'WebSocket connection — opens persistent two-way network channel',
  },

  // ── Low: logging ──
  {
    severity: 'low',
    category: 'Logging',
    pattern: 'console.log',
    regex: /\bconsole\.log\s*\(/g,
    description: 'console.log() — benign debug output',
  },
  {
    severity: 'low',
    category: 'Logging',
    pattern: 'console.error',
    regex: /\bconsole\.error\s*\(/g,
    description: 'console.error() — benign error output',
  },

  // ── Low: path ops ──
  {
    severity: 'low',
    category: 'Path Construction',
    pattern: 'path.join',
    regex: /\bpath\.join\s*\(/g,
    description: 'path.join() — constructs file paths',
  },
  {
    severity: 'low',
    category: 'Path Construction',
    pattern: 'path.resolve',
    regex: /\bpath\.resolve\s*\(/g,
    description: 'path.resolve() — resolves absolute file paths',
  },
];

// Max findings to report per severity (prevents flooding)
const MAX_FINDINGS: Record<Finding['severity'], number> = {
  critical: 50,
  high: 50,
  medium: 30,
  low: 10,
  info: 20,
};

// ─── Score & Grade (copied exactly from SDK) ───

export function computeScore(findings: Finding[]): number {
  let score = 100;
  for (const f of findings) {
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

// ─── Scannable file extensions ───

const SCANNABLE_EXTS = new Set(['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx']);

function isScannable(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return false;
  return SCANNABLE_EXTS.has(name.slice(dot).toLowerCase());
}

// ─── Scan a single file's text content ───

function scanFileContent(
  text: string,
  relPath: string,
  severityCounts: Record<Finding['severity'], number>,
): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split('\n');

  for (const def of PATTERNS) {
    const maxCount = MAX_FINDINGS[def.severity];
    if ((severityCounts[def.severity] ?? 0) >= maxCount) continue;

    // Reset lastIndex before scanning this file
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

// ─── BasedAgents DB lookup ───

interface AgentLookup {
  registered: boolean;
  verified: boolean;
  reputation_score: number | null;
  agent_id: string | null;
}

async function lookupBasedAgents(packageName: string, db: DBAdapter | null): Promise<AgentLookup> {
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
        return skills.some(
          s => s.name === packageName || s.name === packageName.replace(/^@/, '')
        );
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

// ─── NPM registry fetch ───

const MAX_TARBALL_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_TEXT_BYTES    = 10 * 1024 * 1024; // 10 MB total extracted text
const SCAN_TIMEOUT_MS   = 30_000;           // 30 seconds

interface NpmPackageMetadata {
  name: string;
  version: string;
  dist: {
    tarball: string;
    size?: number;
  };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
}

async function fetchNpmMetadata(packageName: string, version: string): Promise<NpmPackageMetadata> {
  // Encode scoped package names (@scope/pkg → @scope%2Fpkg for the registry URL path)
  const encodedName = packageName.startsWith('@')
    ? packageName.replace('/', '%2F')
    : packageName;

  const url = version === 'latest'
    ? `https://registry.npmjs.org/${encodedName}/latest`
    : `https://registry.npmjs.org/${encodedName}/${version}`;

  const res = await fetch(url);
  if (res.status === 404) throw new Error('PACKAGE_NOT_FOUND');
  if (!res.ok) throw new Error(`NPM_REGISTRY_ERROR:${res.status}`);

  const data = await res.json() as NpmPackageMetadata;
  if (!data.dist?.tarball) throw new Error('PACKAGE_NOT_FOUND');
  return data;
}

// ─── Main Worker Scanner ───

export interface ScanOptions {
  db?: DBAdapter | null;
  version?: string;
}

export async function scan(packageName: string, options: ScanOptions = {}): Promise<ScanReport> {
  const version = options.version || 'latest';
  const db = options.db ?? null;

  // Wrap the entire scan in a timeout
  const scanPromise = doScan(packageName, version, db);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('SCAN_TIMEOUT')), SCAN_TIMEOUT_MS)
  );

  return Promise.race([scanPromise, timeoutPromise]);
}

async function doScan(packageName: string, version: string, db: DBAdapter | null): Promise<ScanReport> {
  // 1. Fetch npm metadata
  const meta = await fetchNpmMetadata(packageName, version);
  const pkgVersion = meta.version;
  const tarballUrl = meta.dist.tarball;

  // Check published tarball size (Content-Length header)
  const headRes = await fetch(tarballUrl, { method: 'HEAD' });
  const contentLength = parseInt(headRes.headers.get('content-length') || '0', 10);
  if (contentLength > MAX_TARBALL_BYTES) {
    throw new Error(`TARBALL_TOO_LARGE:${contentLength}`);
  }

  // 2. Fetch tarball
  const tgzRes = await fetch(tarballUrl);
  if (!tgzRes.ok) throw new Error(`TARBALL_FETCH_ERROR:${tgzRes.status}`);
  if (!tgzRes.body) throw new Error('TARBALL_FETCH_ERROR:no_body');

  // 3. Decompress gzip → tar stream
  const ds = new DecompressionStream('gzip');
  const tarStream = tgzRes.body.pipeThrough(ds);

  // 4. Parse tar entries
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const findings: Finding[] = [];
  let filesScanned = 0;
  let totalFiles = 0;
  let totalTextBytes = 0;
  let packageSizeBytes = 0;
  let pkgJson: NpmPackageMetadata | null = null;

  const severityCounts: Record<Finding['severity'], number> = {
    critical: 0, high: 0, medium: 0, low: 0, info: 0,
  };

  for await (const entry of parseTar(tarStream, MAX_TARBALL_BYTES)) {
    if (entry.type !== 'file') continue;

    // npm packs files under "package/" — strip that prefix for relative paths
    const relPath = entry.name.replace(/^package\//, '');

    packageSizeBytes += entry.size;
    totalFiles++;

    // Parse package.json from root
    if (relPath === 'package.json' && !pkgJson) {
      try {
        pkgJson = JSON.parse(decoder.decode(entry.content)) as NpmPackageMetadata;
      } catch { /* ignore parse errors */ }
      continue;
    }

    if (!isScannable(relPath)) continue;
    if (totalTextBytes >= MAX_TEXT_BYTES) continue;

    const text = decoder.decode(entry.content);
    totalTextBytes += text.length;
    filesScanned++;

    const fileFindings = scanFileContent(text, relPath, severityCounts);
    findings.push(...fileFindings);
  }

  // 5. Info findings from package.json
  const infoFindings: Finding[] = [];

  const installScriptKeys = ['preinstall', 'install', 'postinstall', 'prepare'];
  const scriptsToCheck = pkgJson?.scripts ?? meta.scripts ?? {};
  const hasInstallScripts = installScriptKeys.some(k => scriptsToCheck[k]);

  if (hasInstallScripts) {
    for (const key of installScriptKeys) {
      const script = scriptsToCheck[key];
      if (script) {
        if ((severityCounts.info ?? 0) < MAX_FINDINGS.info) {
          infoFindings.push({
            severity: 'info',
            category: 'Install Script',
            pattern: key,
            file: 'package.json',
            line: 0,
            context: `"${key}": "${script}"`,
            description: `Package has a ${key} script that runs automatically on npm install`,
          });
          severityCounts.info = (severityCounts.info ?? 0) + 1;
        }
      }
    }
  }

  const binField = pkgJson?.bin ?? meta.bin;
  if (binField && (severityCounts.info ?? 0) < MAX_FINDINGS.info) {
    const binEntries = typeof binField === 'string' ? [binField] : Object.values(binField);
    infoFindings.push({
      severity: 'info',
      category: 'Package Metadata',
      pattern: 'bin entries',
      file: 'package.json',
      line: 0,
      context: `bin: ${JSON.stringify(binField)}`,
      description: `Package exposes ${binEntries.length} CLI bin entr${binEntries.length === 1 ? 'y' : 'ies'}`,
    });
    severityCounts.info = (severityCounts.info ?? 0) + 1;
  }

  const depCount =
    Object.keys(pkgJson?.dependencies ?? meta.dependencies ?? {}).length +
    Object.keys(pkgJson?.devDependencies ?? meta.devDependencies ?? {}).length;

  if ((severityCounts.info ?? 0) < MAX_FINDINGS.info) {
    infoFindings.push({
      severity: 'info',
      category: 'Package Metadata',
      pattern: 'dependency count',
      file: 'package.json',
      line: 0,
      context: `dependencies: ${depCount}`,
      description: `Package has ${depCount} total dependencies`,
    });
  }

  const allFindings = [...findings, ...infoFindings];

  // 6. Compute score (exclude info findings from scoring)
  let score = computeScore(allFindings.filter(f => f.severity !== 'info'));

  // 7. BasedAgents lookup
  const ba = await lookupBasedAgents(packageName, db);
  if (ba.registered) score = Math.min(100, score + 10);
  if (ba.verified)   score = Math.min(100, score + 10);

  const grade = computeGrade(score);

  return {
    package: packageName,
    version: pkgVersion,
    score,
    grade,
    findings: allFindings,
    metadata: {
      files_scanned: filesScanned,
      total_files: totalFiles,
      has_install_scripts: hasInstallScripts,
      dependency_count: depCount,
      package_size_bytes: packageSizeBytes,
    },
    basedagents: ba,
    scanned_at: new Date().toISOString(),
  };
}
