/**
 * Bridge into the api workspace's test harness — one documented reach across
 * the package boundary instead of a duplicated schema/signing stack.
 *
 * setupTestDb/createTestApp build the exact app + in-memory SQLite the api
 * suite tests (full inline migration set: messages, used_signatures,
 * board_posts, ...), so serving it over HTTP here exercises the real auth
 * middleware, replay guard, and board routes. Test-only: nothing under test/
 * is compiled (tsconfig includes src only) or published (package.json
 * "files").
 */
export { setupTestDb, createTestApp, createTestAgent } from '../../api/src/test-helpers.js';
export type { TestKeypair } from '../../api/src/test-helpers.js';
export type { SQLiteAdapter } from '../../api/src/db/sqlite-adapter.js';
export { bytesToHex } from '../../api/src/crypto/index.js';
