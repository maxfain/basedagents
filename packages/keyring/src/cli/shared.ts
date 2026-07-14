/**
 * Shared CLI plumbing — flag parsing, keypair loading, output formatting.
 *
 * Conventions (match packages/sdk/src/cli): manual argv parsing, no
 * arg-parsing dependencies, plain console output, process.exitCode.
 */

import { loadKeypairFile } from '../store.js';
import type { AgentKeypair } from '../crypto.js';
import type { VaultFile, GrantConstraints } from '../types.js';

/** A user-facing CLI error — printed as `Error: <message>`, never a stack trace. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export interface ParsedFlags {
  /** Non-flag arguments, in order. */
  positional: string[];
  /** `--flag <value>` pairs. */
  values: Record<string, string>;
  /** Boolean switches that were present. */
  switches: Set<string>;
  /** Everything after a bare `--`, verbatim (the child command for `based run`). */
  rest: string[];
}

/**
 * Tiny argv parser: `--flag value` for flags listed in `spec.value`, bare
 * `--flag` for flags in `spec.switch`, everything after `--` into `rest`.
 * Unknown `--flags` are an error so typos never pass silently.
 */
export function parseFlags(args: string[], spec: { value?: string[]; switch?: string[] } = {}): ParsedFlags {
  const valueFlags = new Set(spec.value ?? []);
  const switchFlags = new Set(spec.switch ?? []);
  const parsed: ParsedFlags = { positional: [], values: {}, switches: new Set(), rest: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      parsed.rest = args.slice(i + 1);
      break;
    }
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (valueFlags.has(name)) {
        const value = args[i + 1];
        if (value === undefined) throw new CliError(`Option --${name} requires a value`);
        parsed.values[name] = value;
        i++;
      } else if (switchFlags.has(name)) {
        parsed.switches.add(name);
      } else {
        throw new CliError(`Unknown option: ${arg}`);
      }
    } else {
      parsed.positional.push(arg);
    }
  }
  return parsed;
}

/** Load a keypair file with a clean error message on failure. */
export function loadKeypairChecked(filePath: string): AgentKeypair {
  try {
    return loadKeypairFile(filePath);
  } catch (err) {
    throw new CliError(`Could not load keypair ${filePath}: ${(err as Error).message}`);
  }
}

// ─── Formatting ───

/** "2026-07-14T08:01:22.123Z" → "2026-07-14 08:01:22" */
export function formatTime(iso: string | undefined): string {
  if (!iso) return '-';
  return iso.replace('T', ' ').slice(0, 19);
}

export function shortAgentId(agentId: string): string {
  return agentId.length <= 15 ? agentId : `${agentId.slice(0, 11)}…`;
}

/** Friendly display for an agent: "owner", the identity name, or a shortened ID. */
export function agentDisplay(vault: VaultFile, agentId: string): string {
  if (agentId === vault.owner.agent_id) return 'owner';
  return vault.identities[agentId]?.name ?? shortAgentId(agentId);
}

/** Render rows as aligned columns, two spaces between columns. */
export function printTable(rows: string[][], indent = '  '): void {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, cell.length); });
  }
  for (const row of rows) {
    const line = row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ');
    console.log((indent + line).trimEnd());
  }
}

export function describeConstraints(constraints: GrantConstraints): string {
  const parts: string[] = [];
  if (constraints.expires_at) parts.push(`expires ${formatTime(constraints.expires_at)}`);
  if (constraints.max_lease_ttl_seconds !== undefined) parts.push(`max TTL ${constraints.max_lease_ttl_seconds}s`);
  if (constraints.max_uses !== undefined) parts.push(`max uses ${constraints.max_uses}`);
  if (constraints.project) parts.push(`project ${constraints.project}`);
  return parts.join(' · ');
}

// ─── Value parsing ───

export function parsePositiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliError(`${flag} must be a positive integer (got "${value}")`);
  }
  return n;
}

const DURATION_UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Accept an ISO timestamp or a duration like 90m / 24h / 7d; return ISO. */
export function parseExpires(value: string): string {
  const match = /^(\d+)\s*([smhdw])$/.exec(value.trim());
  if (match) {
    const ms = parseInt(match[1], 10) * DURATION_UNIT_MS[match[2]];
    return new Date(Date.now() + ms).toISOString();
  }
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  throw new CliError(`Invalid expiry "${value}" — use an ISO timestamp or a duration like 90m, 24h, 7d`);
}

/** The honest revocation summary — what revoke/kill does and does not do. */
export function printRevocationNotes(): void {
  console.log('  • New leases: blocked immediately (sealed copy deleted from the vault).');
  console.log('  • Outstanding leases: expire within their TTL (≤15 minutes by default).');
  console.log('  • Provider-side key: still exists until rotated or burned — Provisioner lands in v0.2.');
}
