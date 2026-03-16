/**
 * Rust pattern definitions for the universal scanner.
 */

import type { PatternDef } from '../core.js';

export const EXTENSIONS = new Set(['.rs']);

export const PATTERNS: PatternDef[] = [
  // ── Critical ──
  {
    severity: 'critical',
    category: 'Unsafe Code',
    pattern: 'unsafe block',
    regex: /\bunsafe\s*\{/g,
    description: 'unsafe block — bypasses Rust safety guarantees',
  },
  {
    severity: 'critical',
    category: 'Code Execution',
    pattern: 'std::process::Command',
    regex: /\bCommand::new\s*\(/g,
    description: 'Command::new() — executes external processes',
  },

  // ── High ──
  {
    severity: 'high',
    category: 'Shell Execution',
    pattern: 'shell command string',
    regex: /Command::new\s*\(\s*["'](?:sh|bash|cmd|powershell)/g,
    description: 'Spawns a shell process — can run arbitrary commands',
  },
  {
    severity: 'high',
    category: 'Destructive File Operation',
    pattern: 'fs::remove',
    regex: /\bfs::remove_(?:file|dir|dir_all)\s*\(/g,
    description: 'Filesystem deletion',
  },
  {
    severity: 'high',
    category: 'Network Call',
    pattern: 'raw socket',
    regex: /\bTcpStream::connect\b/g,
    description: 'Raw TCP connection',
  },
  {
    severity: 'high',
    category: 'FFI',
    pattern: 'extern "C"',
    regex: /\bextern\s+"C"\s*\{/g,
    description: 'FFI block — calls into C code, bypasses Rust safety',
  },

  // ── Medium ──
  {
    severity: 'medium',
    category: 'Environment Access',
    pattern: 'std::env',
    regex: /\bstd::env::(?:var|vars|args)\b/g,
    description: 'Environment variable or argument access',
  },
  {
    severity: 'medium',
    category: 'Network Call',
    pattern: 'reqwest/hyper',
    regex: /\b(?:reqwest|hyper)::(?:get|Client)\b/g,
    description: 'HTTP client usage',
  },
  {
    severity: 'medium',
    category: 'File System Read',
    pattern: 'fs::read',
    regex: /\bfs::(?:read|read_to_string|read_dir)\s*\(/g,
    description: 'Filesystem read operations',
  },
];
