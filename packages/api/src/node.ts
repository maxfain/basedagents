/**
 * Node.js entry point — local development and the Playwright E2E server.
 * Use: npx tsx src/node.ts
 *
 * Differences from the Workers deployment, all deliberate:
 *   - SQLite (better-sqlite3) instead of D1, registered via setNodeAdapter
 *     (the previous `app._nodeAdapter` injection was dead code — nothing read it);
 *   - schema.sql covers the open registry only, so the control-plane
 *     migrations (0023+) are applied here, tracked in a _migrations table
 *     (they contain non-idempotent ALTERs — never re-run one);
 *   - process.env is passed as the Hono env, so KEYRING_RP_ID /
 *     KEYRING_ORIGINS / E2E / Stripe vars work exactly like Worker vars.
 *     E2E runs set: E2E=1 KEYRING_RP_ID=localhost
 *     KEYRING_ORIGINS=http://localhost:5174 KEYRING_CONSOLE_ORIGIN=http://localhost:5174
 */
import { serve } from '@hono/node-server';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import app, { setNodeAdapter } from './index.js';
import { initDatabase } from './db/index.js';
import { SQLiteAdapter } from './db/sqlite-adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const port = parseInt(process.env['PORT'] || '3000', 10);
const dbPath = process.env['DATABASE_PATH'] || './data/registry.db';

mkdirSync(dirname(dbPath) === '.' ? './data' : dirname(dbPath), { recursive: true });

const sqliteDb = initDatabase(dbPath);

// schema.sql predates a few registry migrations it never absorbed — apply the
// idempotent ones the shared middleware depends on (rate limiting).
sqliteDb.exec(readFileSync(join(__dirname, '..', 'migrations', '0021_rate_limit_table.sql'), 'utf-8'));

// Apply control-plane migrations (0023+) exactly once each.
sqliteDb.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
const migrationsDir = join(__dirname, '..', 'migrations');
const controlMigrations = readdirSync(migrationsDir)
  .filter((f) => f >= '0023' && f.endsWith('.sql'))
  .sort();
for (const file of controlMigrations) {
  const done = sqliteDb.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(file);
  if (done) continue;
  sqliteDb.exec(readFileSync(join(migrationsDir, file), 'utf-8'));
  sqliteDb.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(file);
  console.log(`applied migration ${file}`);
}

setNodeAdapter(new SQLiteAdapter(sqliteDb));

serve({ fetch: (req) => app.fetch(req, process.env as unknown as Record<string, unknown>), port }, (info) => {
  console.log(`🔑 BasedAgents API running at http://localhost:${info.port}${process.env['E2E'] === '1' ? ' (E2E mode)' : ''}`);
});
