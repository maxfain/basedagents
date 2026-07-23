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
 *
 * `spec.optionalValue` flags accept a value but don't demand one: with a
 * following non-flag argument they land in `values`, bare (or right before
 * another `--flag`) they land in `switches` and the command picks its default.
 * Field-hit: bare `--watch` is a reasonable thing to type, and "requires a
 * value" taught nobody what kind of value.
 */
export function parseFlags(
  args: string[],
  spec: { value?: string[]; switch?: string[]; optionalValue?: string[] } = {},
): ParsedFlags {
  const valueFlags = new Set(spec.value ?? []);
  const switchFlags = new Set(spec.switch ?? []);
  const optionalValueFlags = new Set(spec.optionalValue ?? []);
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
      } else if (optionalValueFlags.has(name)) {
        const value = args[i + 1];
        if (value === undefined || value.startsWith('--')) {
          parsed.switches.add(name);
        } else {
          parsed.values[name] = value;
          i++;
        }
      } else if (switchFlags.has(name)) {
        parsed.switches.add(name);
      } else {
        // The fourth wall (field-hit): a setup prompt written against a newer
        // release supplies a flag this npx-cached copy predates — npx reuses
        // its cached tree for a bare package spec and never re-resolves, so
        // "Unknown option" on a prompt-supplied flag usually means STALE CLI,
        // not a bad prompt. Say so; only @latest busts the cache.
        throw new CliError(
          `Unknown option: ${arg}\n` +
            `  If a setup prompt supplied this flag, this may be an older, npx-cached copy ` +
            `of the CLI (run \`based --version\` to see which). The latest version runs with:\n` +
            `    npx @basedagents/keyring@latest <command>`,
        );
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

/**
 * Render rows as aligned columns, two spaces between columns. `log` selects the
 * output sink — pass `console.error` to keep stdout clean (e.g. for `based run`).
 */
export function printTable(rows: string[][], indent = '  ', log: (line: string) => void = console.log): void {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, cell.length); });
  }
  for (const row of rows) {
    const line = row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ');
    log((indent + line).trimEnd());
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

/** Match a full ISO-8601 date or datetime (bare numbers deliberately excluded). */
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Accept a duration like 30m / 24h / 7d / 2w or a full ISO-8601 timestamp, and
 * return the resolved instant as ISO. Bare numbers are rejected (they parse to
 * arbitrary past dates), and the result must be strictly in the future.
 */
export function parseExpires(value: string): string {
  const trimmed = value.trim();
  let parsedMs: number;
  const match = /^(\d+)\s*([smhdw])$/.exec(trimmed);
  if (match) {
    parsedMs = Date.now() + parseInt(match[1], 10) * DURATION_UNIT_MS[match[2]];
  } else if (ISO_8601_RE.test(trimmed)) {
    parsedMs = Date.parse(trimmed);
    if (Number.isNaN(parsedMs)) {
      throw new CliError(`Invalid expiry "${value}" — use an ISO-8601 timestamp or a duration like 30m, 24h, 7d, 2w`);
    }
  } else {
    throw new CliError(
      `Invalid expiry "${value}" — use a duration like 30m, 24h, 7d, 2w or a full ISO-8601 timestamp (e.g. 2026-08-01T00:00:00Z)`
    );
  }
  if (parsedMs <= Date.now()) {
    throw new CliError(`Expiry "${value}" must be in the future`);
  }
  return new Date(parsedMs).toISOString();
}

/** The honest revocation summary — what revoke/kill does and does not do. */
export function printRevocationNotes(): void {
  console.log('  • New leases: blocked immediately (sealed copy deleted from the vault).');
  console.log('  • Outstanding leases: expire within their TTL (≤15 minutes by default).');
  console.log('  • Provider-side keys: minted ones are burned by id next; pasted ones still work until revoked at the provider.');
}
