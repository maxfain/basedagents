/**
 * JavaScript/TypeScript pattern definitions for the universal scanner.
 * Moved from scanner/index.ts — same patterns, now source-agnostic.
 */

import type { PatternDef } from '../core.js';

export const EXTENSIONS = new Set(['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx']);

export const PATTERNS: PatternDef[] = [
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

  // ── Low: file write/delete ops ──
  // These are standard filesystem operations used by countless legitimate tools
  // (MCP servers, build tools, CLI utilities, editors). Flagged for awareness
  // but not inherently malicious — context matters more than presence.
  {
    severity: 'low',
    category: 'File System Write',
    pattern: 'fs.writeFile',
    regex: /\bfs(?:Promises)?\.writeFile\s*\(/g,
    description: 'fs.writeFile() — writes or overwrites files on disk',
  },
  {
    severity: 'low',
    category: 'File System Write',
    pattern: 'fs.unlink',
    regex: /\bfs(?:Promises)?\.unlink\s*\(/g,
    description: 'fs.unlink() — deletes files from disk',
  },
  {
    severity: 'low',
    category: 'File System Write',
    pattern: 'fs.rmdir / rm',
    regex: /\bfs(?:Promises)?\.(?:rmdir|rm)\s*\(/g,
    description: 'fs.rmdir()/rm() — removes directories',
  },
  {
    severity: 'low',
    category: 'File System Write',
    pattern: 'fs.chmod',
    regex: /\bfs(?:Promises)?\.chmod\s*\(/g,
    description: 'fs.chmod() — modifies file permissions',
  },
  {
    severity: 'low',
    category: 'File System Write',
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

  // ── Low: environment access ──
  {
    severity: 'low',
    category: 'Environment Access',
    pattern: 'process.env access',
    regex: /\bprocess\.env\b/g,
    description: 'Accesses environment variables — common for configuration',
  },

  // ── Low: network calls ──
  // Outbound HTTP is normal for any API client, tool, or MCP server.
  // Only flag high when combined with credential exfiltration (handled above).
  {
    severity: 'low',
    category: 'Network Call',
    pattern: 'http.request',
    regex: /\bhttp\.request\s*\(/g,
    description: 'http.request() — makes outbound HTTP connections',
  },
  {
    severity: 'low',
    category: 'Network Call',
    pattern: 'https.request',
    regex: /\bhttps\.request\s*\(/g,
    description: 'https.request() — makes outbound HTTPS connections',
  },
  {
    severity: 'low',
    category: 'Network Call',
    pattern: 'fetch()',
    regex: /\bfetch\s*\(\s*(?!['"](?:https?:\/\/(?:localhost|127\.0\.0\.1)))[^)]{1,200}\)/g,
    description: 'fetch() to a non-localhost URL — makes outbound HTTP requests',
  },

  // ── Info: file reads ──
  {
    severity: 'info',
    category: 'File System Read',
    pattern: 'fs.readFile',
    regex: /\bfs(?:Promises)?\.readFile\s*\(/g,
    description: 'fs.readFile() — reads files from disk',
  },
  {
    severity: 'info',
    category: 'File System Read',
    pattern: 'fs.readdir',
    regex: /\bfs(?:Promises)?\.readdir\s*\(/g,
    description: 'fs.readdir() — lists directory contents',
  },
  {
    severity: 'info',
    category: 'File System Read',
    pattern: 'fs.stat',
    regex: /\bfs(?:Promises)?\.stat\s*\(/g,
    description: 'fs.stat() — reads file metadata',
  },

  // ── Low: system info ──
  {
    severity: 'low',
    category: 'System Info',
    pattern: 'os.homedir',
    regex: /\bos\.homedir\s*\(/g,
    description: "os.homedir() — discovers the current user's home directory",
  },
  {
    severity: 'low',
    category: 'System Info',
    pattern: 'os.userInfo',
    regex: /\bos\.userInfo\s*\(/g,
    description: 'os.userInfo() — fetches username, uid, shell and other user details',
  },
  {
    severity: 'low',
    category: 'System Info',
    pattern: 'os.hostname',
    regex: /\bos\.hostname\s*\(/g,
    description: 'os.hostname() — reads the machine hostname',
  },

  // ── Info: crypto ──
  {
    severity: 'info',
    category: 'Crypto Usage',
    pattern: 'crypto module',
    regex: /require\s*\(\s*['"]crypto['"]\s*\)|from\s+['"](?:node:)?crypto['"]/g,
    description: 'Uses the crypto module — standard for encryption or key generation',
  },

  // ── Low: WebSocket ──
  {
    severity: 'low',
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

  // ── Info: path ops ──
  {
    severity: 'info',
    category: 'Path Construction',
    pattern: 'path.join',
    regex: /\bpath\.join\s*\(/g,
    description: 'path.join() — constructs file paths',
  },
  {
    severity: 'info',
    category: 'Path Construction',
    pattern: 'path.resolve',
    regex: /\bpath\.resolve\s*\(/g,
    description: 'path.resolve() — resolves absolute file paths',
  },
];
