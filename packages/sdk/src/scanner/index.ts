/**
 * basedagents npm package security scanner
 *
 * Downloads an npm package tarball, extracts it, scans all JS/TS files
 * for dangerous patterns, and returns a structured trust report.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { rmSync } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { RegistryClient } from '../index.js';

// ─── Types ───

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

// ─── Pattern Definitions ───

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

  // ── High: credential exfiltration (env var in network call) ──
  {
    severity: 'high',
    category: 'Credential Exfiltration',
    pattern: 'env var in network call',
    regex: /(?:fetch|https?\.request|axios|got)\s*\([^)]*process\.env/g,
    description: 'Environment variable passed directly into a network call — potential credential exfiltration',
  },

  // ── High: raw sockets ──
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

  // ── Medium: environment access ──
  {
    severity: 'medium',
    category: 'Environment Access',
    pattern: 'process.env access',
    regex: /\bprocess\.env\b/g,
    description: 'Accesses environment variables — common for configuration',
  },

  // ── Medium: network calls ──
  {
    severity: 'medium',
    category: 'Network Call',
    pattern: 'http.request',
    regex: /\bhttp\.request\s*\(/g,
    description: 'http.request() — makes outbound HTTP connections',
  },
  {
    severity: 'medium',
    category: 'Network Call',
    pattern: 'https.request',
    regex: /\bhttps\.request\s*\(/g,
    description: 'https.request() — makes outbound HTTPS connections',
  },
  {
    severity: 'medium',
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
    description: 'os.homedir() — discovers the current user\'s home directory',
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

  // ── Low: crypto ──
  {
    severity: 'low',
    category: 'Crypto Usage',
    pattern: 'crypto module',
    regex: /require\s*\(\s*['"]crypto['"]\s*\)|from\s+['"](?:node:)?crypto['"]/g,
    description: 'Uses the crypto module — standard for encryption or key generation',
  },

  // ── Medium: WebSocket ──
  {
    severity: 'medium',
    category: 'WebSocket',
    pattern: 'WebSocket connection',
    regex: /\bnew\s+WebSocket\s*\(/g,
    description: 'WebSocket connection — opens persistent two-way network channel',
  },

  // ── Info: logging ──
  {
    severity: 'info',
    category: 'Logging',
    pattern: 'console.log',
    regex: /\bconsole\.log\s*\(/g,
    description: 'console.log() — benign debug output',
  },
  {
    severity: 'info',
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

// ─── Score & Grade ───

function computeScore(findings: Finding[]): number {
  // Deduplicate: same pattern + same file = count once
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

function computeGrade(score: number): ScanReport['grade'] {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

// ─── File Walker ───

function walkDir(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules inside the package
        if (entry.name === 'node_modules') continue;
        results.push(...walkDir(full));
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  } catch { /* ignore unreadable dirs */ }
  return results;
}

const SCANNABLE_EXTS = new Set(['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx']);

// ─── File Scanner ───

function scanFile(filePath: string, relPath: string, severityCounts: Record<Finding['severity'], number>): Finding[] {
  const findings: Finding[] = [];
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return findings;
  }

  const lines = content.split('\n');

  for (const def of PATTERNS) {
    const currentCount = severityCounts[def.severity] ?? 0;
    const maxCount = MAX_FINDINGS[def.severity];
    if (currentCount >= maxCount) continue;

    // Reset lastIndex before each file scan
    def.regex.lastIndex = 0;

    const seenLines = new Set<number>();

    for (let i = 0; i < lines.length; i++) {
      if (severityCounts[def.severity] >= maxCount) break;

      const line = lines[i];
      // Reset lastIndex for each line
      def.regex.lastIndex = 0;
      const match = def.regex.exec(line);
      if (!match) continue;
      if (seenLines.has(i)) continue;
      seenLines.add(i);

      // Build context: the line itself, trimmed
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

// ─── Package.json Info ───

interface PkgJson {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
}

function readPackageJson(dir: string): PkgJson | null {
  try {
    const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf-8');
    return JSON.parse(raw) as PkgJson;
  } catch {
    return null;
  }
}

function getPackageDirSize(dir: string): number {
  let total = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        total += getPackageDirSize(full);
      } else if (e.isFile()) {
        try { total += fs.statSync(full).size; } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return total;
}

// ─── BasedAgents Registry Lookup ───

interface AgentLookup {
  registered: boolean;
  verified: boolean;
  reputation_score: number | null;
  agent_id: string | null;
}

async function lookupBasedAgents(packageName: string): Promise<AgentLookup> {
  try {
    const client = new RegistryClient();
    const results = await client.fetchJson<{
      agents: Array<{
        id: string;
        status: string;
        reputation_score: number;
        verification_count: number;
        skills?: Array<{ name: string; registry?: string }>;
      }>;
    }>(`/v1/agents/search?q=${encodeURIComponent(packageName)}&limit=5`);

    const match = results.agents?.find(a =>
      a.skills?.some(s => s.name === packageName || s.name === packageName.replace(/^@/, ''))
    ) ?? results.agents?.[0];

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

// ─── Main Scanner ───

export interface ScanOptions {
  apiUrl?: string;
}

export async function scan(packageSpec: string, options: ScanOptions = {}): Promise<ScanReport> {
  const tmpDir = `/tmp/basedagents-scan-${Date.now()}-${randomBytes(8).toString('hex')}`;

  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    // 1. Download tarball via npm pack
    let tarballPath: string;
    try {
      const output = execFileSync(
        'npm',
        ['pack', packageSpec, '--pack-destination', tmpDir, '--json'],
        { encoding: 'utf-8', timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();

      // npm pack --json returns an array
      let packResult: Array<{ filename: string }>;
      try {
        packResult = JSON.parse(output) as Array<{ filename: string }>;
        tarballPath = path.join(tmpDir, packResult[0].filename);
      } catch {
        // Fallback: find the .tgz in tmpDir
        const tgzFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.tgz'));
        if (!tgzFiles.length) throw new Error('No tarball found after npm pack');
        tarballPath = path.join(tmpDir, tgzFiles[0]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('npm pack')) {
        throw new Error(`Package not found or npm pack failed: ${packageSpec}`);
      }
      throw err;
    }

    const tarballSize = fs.statSync(tarballPath).size;

    // 2. Extract tarball
    const extractDir = path.join(tmpDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    execFileSync('tar', ['xzf', tarballPath, '-C', extractDir], { timeout: 30_000 });

    // npm packs files under a "package/" subdirectory
    const packageDir = path.join(extractDir, 'package');
    const rootDir = fs.existsSync(packageDir) ? packageDir : extractDir;

    // 3. Read package.json
    const pkg = readPackageJson(rootDir);
    const pkgName = pkg?.name ?? packageSpec;
    const pkgVersion = pkg?.version ?? 'unknown';

    const installScriptKeys = ['preinstall', 'install', 'postinstall', 'prepare'];
    const hasInstallScripts = installScriptKeys.some(k => pkg?.scripts?.[k]);
    const depCount = Object.keys(pkg?.dependencies ?? {}).length + Object.keys(pkg?.devDependencies ?? {}).length;

    // 4. Scan install scripts as findings
    const infoFindings: Finding[] = [];
    if (hasInstallScripts) {
      for (const key of installScriptKeys) {
        const script = pkg?.scripts?.[key];
        if (script) {
          infoFindings.push({
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

    // Bin entries
    if (pkg?.bin) {
      const binEntries = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin);
      infoFindings.push({
        severity: 'info',
        category: 'Package Metadata',
        pattern: 'bin entries',
        file: 'package.json',
        line: 0,
        context: `bin: ${JSON.stringify(pkg.bin)}`,
        description: `Package exposes ${binEntries.length} CLI bin entr${binEntries.length === 1 ? 'y' : 'ies'}`,
      });
    }

    // Dep count info
    infoFindings.push({
      severity: 'info',
      category: 'Package Metadata',
      pattern: 'dependency count',
      file: 'package.json',
      line: 0,
      context: `dependencies: ${depCount}`,
      description: `Package has ${depCount} total dependencies`,
    });

    // 5. Walk and scan files
    const allFiles = walkDir(rootDir);
    const scannableFiles = allFiles.filter(f => SCANNABLE_EXTS.has(path.extname(f)));

    const severityCounts: Record<Finding['severity'], number> = {
      critical: 0, high: 0, medium: 0, low: 0, info: infoFindings.length,
    };

    const codeFindings: Finding[] = [];
    for (const filePath of scannableFiles) {
      const relPath = path.relative(rootDir, filePath);
      const found = scanFile(filePath, relPath, severityCounts);
      codeFindings.push(...found);
    }

    const allFindings = [...codeFindings, ...infoFindings];

    // 6. Compute score
    let score = computeScore(allFindings.filter(f => f.severity !== 'info'));

    // 7. BasedAgents lookup
    const ba = await lookupBasedAgents(pkgName);
    if (ba.registered) score = Math.min(100, score + 10);
    if (ba.verified)   score = Math.min(100, score + 10);

    const grade = computeGrade(score);
    const packageSize = getPackageDirSize(rootDir);

    return {
      package: pkgName,
      version: pkgVersion,
      score,
      grade,
      findings: allFindings,
      metadata: {
        files_scanned: scannableFiles.length,
        total_files: allFiles.length,
        has_install_scripts: hasInstallScripts,
        dependency_count: depCount,
        package_size_bytes: packageSize,
      },
      basedagents: ba,
      scanned_at: new Date().toISOString(),
    };
  } finally {
    // Cleanup temp directory
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* best-effort cleanup */ }
  }
}
