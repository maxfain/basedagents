/**
 * The migration list the Node runner (src/node.ts) replays — shared with the
 * schema tests (board-schema.test.ts, tasks-schema.test.ts) so "what node.ts
 * applies" is defined in exactly one place.
 *
 * The runner replays the FULL chain (0001 … latest) in file order, each file
 * inside its own better-sqlite3 transaction. Nothing is skipped: schema.sql is
 * 0001 modulo comments, and the earlier gap-list approach (schema.sql + 0021 +
 * ≥0023) left the local DB without tasks/submissions/delivery_receipts,
 * chain.entry_type (0008) and used_signatures (0013) — so any migration that
 * ALTERs those tables threw `no such table` at E2E boot.
 */
import { readdirSync } from 'node:fs';

/**
 * Columns the runner adds AFTER the chain, each guarded (try/catch on
 * `duplicate column name`). Neither has a migration: prod already carries both
 * (added by hand), so a new migration file would fail there with a duplicate
 * column. OSS deploys add them with `wrangler d1 execute` — see GOTCHAS.md
 * "Manual columns".
 */
export const RUNNER_LOCAL_STATEMENTS: readonly string[] = [
  'ALTER TABLE agents ADD COLUMN webhook_url TEXT', // no migration defines it (test-helpers.ts only)
  'ALTER TABLE agents ADD COLUMN reputation_override REAL', // SECURITY_AUDIT.md, no migration either
];

/** Every `*.sql` file in `dir`, sorted by name (0001_initial.sql first). */
export function runnerMigrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * The runner files that sort strictly before `name` — an "existing deploy"
 * that has everything up to (but excluding) that migration. `name` may be a
 * full file name (`'0033_board.sql'`) or just the numeric prefix (`'0035'`).
 */
export function migrationFilesBefore(dir: string, name: string): string[] {
  return runnerMigrationFiles(dir).filter((f) => f < name);
}
