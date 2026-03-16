/**
 * CI/Config YAML pattern definitions for the universal scanner.
 */

import type { PatternDef } from '../core.js';

export const EXTENSIONS = new Set(['.yml', '.yaml']);

export const PATTERNS: PatternDef[] = [
  {
    severity: 'high',
    category: 'CI Injection',
    pattern: 'expression injection',
    regex: /\$\{\{\s*github\.event\.(?:issue|pull_request|comment)\.(?:body|title)\s*\}\}/g,
    description: 'GitHub Actions expression injection — user input in workflow commands',
  },
  {
    severity: 'high',
    category: 'CI Injection',
    pattern: 'pull_request_target + checkout',
    regex: /pull_request_target/g,
    description: 'pull_request_target event — can expose secrets to untrusted PR code',
  },
  {
    severity: 'medium',
    category: 'CI Permission',
    pattern: 'write-all permissions',
    regex: /permissions:\s*write-all/g,
    description: 'Overly broad CI permissions',
  },
];
