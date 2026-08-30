/**
 * backfill-skeletons.ts — one-off name_skeleton backfill (board spec §4).
 *
 * Migration 0033 added agents.name_skeleton but the migrations dir is raw SQL
 * and can't run the skeleton function, so existing rows start NULL
 * (grandfathered — register/complete only enforces collisions against rows
 * that HAVE a skeleton). This script closes that gap: it computes skeletons
 * for the NULL rows and emits UPDATE statements for wrangler d1 execute.
 *
 * Two-step by design — the Worker's D1 binding isn't reachable from a local
 * script, and generated SQL gets a human review step before touching prod:
 *
 *   npx wrangler d1 execute basedagents --remote --json \
 *     --command "SELECT id, name FROM agents WHERE name_skeleton IS NULL" > /tmp/agents.json
 *   npx tsx scripts/backfill-skeletons.ts /tmp/agents.json > /tmp/backfill.sql
 *   npx wrangler d1 execute basedagents --remote --file /tmp/backfill.sql
 *
 * Duplicate skeletons among EXISTING rows are reported on stderr but still
 * written: those look-alikes already coexist and neither can be evicted —
 * the point of the backfill is that no NEW registrant can join them.
 */

import { readFileSync } from 'fs';
import { nameSkeleton } from '../src/lib/skeleton.js';

interface AgentRow { id: string; name: string }

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npx tsx scripts/backfill-skeletons.ts <agents.json>');
  console.error('  (agents.json = wrangler d1 execute --json output of: SELECT id, name FROM agents WHERE name_skeleton IS NULL)');
  process.exit(1);
}

const parsed = JSON.parse(readFileSync(inputPath, 'utf8')) as unknown;
// wrangler --json wraps rows as [{results: [...], success, meta}]; accept a
// bare row array too so hand-built fixtures work.
const rows: AgentRow[] = Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null && 'results' in (parsed[0] as object)
  ? (parsed as Array<{ results: AgentRow[] }>).flatMap(batch => batch.results)
  : (parsed as AgentRow[]);

/** SQL string literal — single quotes doubled; names are arbitrary Unicode. */
function sqlQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

const seen = new Map<string, string>(); // skeleton -> first name claiming it
let count = 0;
for (const row of rows) {
  if (!row || typeof row.id !== 'string' || typeof row.name !== 'string') continue;
  const skeleton = nameSkeleton(row.name);
  const prior = seen.get(skeleton);
  if (prior !== undefined) {
    console.error(`WARN: '${row.name}' and '${prior}' share skeleton '${skeleton}' — pre-existing look-alikes, both kept`);
  } else {
    seen.set(skeleton, row.name);
  }
  // Guarded on IS NULL so re-running against a stale export never clobbers a
  // skeleton written by a registration that happened after the SELECT.
  console.log(`UPDATE agents SET name_skeleton = ${sqlQuote(skeleton)} WHERE id = ${sqlQuote(row.id)} AND name_skeleton IS NULL;`);
  count++;
}
console.error(`${count} UPDATE statements written`);
