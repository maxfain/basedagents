/**
 * Database adapter interface.
 * Abstracts over better-sqlite3 (Node.js) and Cloudflare D1.
 * All methods are async to accommodate D1's async API.
 */
export interface DBAdapter {
  /** Get a single row (or null if not found). */
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null>;

  /** Get all matching rows. */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;

  /** Run a mutation (INSERT/UPDATE/DELETE). Returns change count. */
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;

  /** Execute raw SQL (e.g. multi-statement schema). */
  exec(sql: string): Promise<void>;
}
