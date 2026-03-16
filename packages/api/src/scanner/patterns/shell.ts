/**
 * Shell script pattern definitions for the universal scanner.
 */

import type { PatternDef } from '../core.js';

export const EXTENSIONS = new Set(['.sh', '.bash']);

export const PATTERNS: PatternDef[] = [
  // ── Critical ──
  {
    severity: 'critical',
    category: 'Remote Execution',
    pattern: 'curl | sh',
    regex: /curl\s+[^|]*\|\s*(?:sh|bash|sudo\s+(?:sh|bash))/g,
    description: 'Pipes remote content to shell — executes untrusted code',
  },
  {
    severity: 'critical',
    category: 'Remote Execution',
    pattern: 'wget | sh',
    regex: /wget\s+[^|]*\|\s*(?:sh|bash|sudo\s+(?:sh|bash))/g,
    description: 'Pipes remote content to shell — executes untrusted code',
  },
  {
    severity: 'critical',
    category: 'Privilege Escalation',
    pattern: 'chmod 777',
    regex: /chmod\s+777\b/g,
    description: 'chmod 777 — makes files world-readable/writable/executable',
  },

  // ── High ──
  {
    severity: 'high',
    category: 'Credential Access',
    pattern: 'cat credentials',
    regex: /cat\s+[^\n]*(?:\.ssh|\.aws|\.env|\.npmrc|credentials|password|token|secret)/gi,
    description: 'Reads credential files',
  },
  {
    severity: 'high',
    category: 'Data Exfiltration',
    pattern: 'curl POST with file',
    regex: /curl\s+[^\n]*(?:-d\s+@|-F\s+['"]?file=@|--data-binary\s+@)/g,
    description: 'Uploads file contents via curl — potential data exfiltration',
  },
  {
    severity: 'high',
    category: 'Destructive',
    pattern: 'rm -rf',
    regex: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\b/g,
    description: 'Recursive force delete',
  },
  {
    severity: 'high',
    category: 'Persistence',
    pattern: 'crontab modification',
    regex: /crontab\s+/g,
    description: 'Modifies cron jobs — can establish persistence',
  },
  {
    severity: 'high',
    category: 'Persistence',
    pattern: 'systemd service install',
    regex: /cp\s+[^\n]*\.service\s+.*systemd|systemctl\s+(?:enable|daemon-reload)/g,
    description: 'Installs a systemd service — establishes persistence',
  },

  // ── Medium ──
  {
    severity: 'medium',
    category: 'Environment Access',
    pattern: 'env var access',
    regex: /\$\{?(?:HOME|USER|PATH|SSH_AUTH_SOCK|AWS_|GITHUB_TOKEN|NPM_TOKEN)\}?/g,
    description: 'Accesses sensitive environment variables',
  },
  {
    severity: 'medium',
    category: 'Network Call',
    pattern: 'curl/wget download',
    regex: /(?:curl|wget)\s+(?:https?:\/\/)/g,
    description: 'Downloads content from the internet',
  },
];
