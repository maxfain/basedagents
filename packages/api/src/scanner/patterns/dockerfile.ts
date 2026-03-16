/**
 * Dockerfile pattern definitions for the universal scanner.
 */

import type { PatternDef } from '../core.js';

// Dockerfile has no standard extension — matched by basename in core.ts
export const EXTENSIONS = new Set<string>();

export const PATTERNS: PatternDef[] = [
  {
    severity: 'high',
    category: 'Privilege',
    pattern: 'USER root',
    regex: /^\s*USER\s+root\s*$/gm,
    description: 'Container runs as root',
  },
  {
    severity: 'high',
    category: 'Remote Execution',
    pattern: 'curl pipe to shell',
    regex: /RUN\s+.*curl\s+[^|]*\|\s*(?:sh|bash)/g,
    description: 'Installs software by piping curl to shell in container build',
  },
  {
    severity: 'medium',
    category: 'Secret Exposure',
    pattern: 'ARG/ENV with secret',
    regex: /(?:ARG|ENV)\s+(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)\b/gi,
    description: 'Secret passed as build arg or env — may be cached in layer',
  },
];
