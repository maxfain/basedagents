/**
 * SQLite adapter — wraps better-sqlite3 for local dev / Node.js deployment.
 * Presents an async interface over the sync better-sqlite3 API.
 */
import type Database from 'better-sqlite3';
import type { DBAdapter } from './adapter.js';

export class SQLiteAdapter implements DBAdapter {
  constructor(private db: Database.Database) {}

  async get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null> {
    const row = this.db.prepare(sql).get(...params);
    return (row as T) ?? null;
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    const result = this.db.prepare(sql).run(...params);
    return { changes: result.changes };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }
}
