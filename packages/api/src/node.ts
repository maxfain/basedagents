/**
 * Node.js entry point for local development.
 * Use: npx tsx src/node.ts
 */
import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import app from './index.js';
import { initDatabase } from './db/index.js';
import { SQLiteAdapter } from './db/sqlite-adapter.js';

const port = parseInt(process.env['PORT'] || '3000', 10);
const dbPath = process.env['DATABASE_PATH'] || './data/registry.db';

// Ensure data directory exists
mkdirSync('./data', { recursive: true });

// Initialize database and set adapter via module-level variable
const sqliteDb = initDatabase(dbPath);

// Inject the adapter into the app's middleware
// We do this by setting a module-level ref that index.ts checks
import type { DBAdapter } from './db/adapter.js';

// @ts-expect-error — reaching into app internals for local dev
app._nodeAdapter = new SQLiteAdapter(sqliteDb);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`🔑 BasedAgents API running at http://localhost:${info.port}`);
});
