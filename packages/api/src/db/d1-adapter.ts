/**
 * D1 adapter — wraps Cloudflare D1 for Workers deployment.
 */
import type { DBAdapter } from './adapter.js';

export class D1Adapter implements DBAdapter {
  constructor(private db: D1Database) {}

  async get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null> {
    const result = await this.db.prepare(sql).bind(...params).first<T>();
    return result ?? null;
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    const result = await this.db.prepare(sql).bind(...params).all<T>();
    return result.results;
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    const result = await this.db.prepare(sql).bind(...params).run();
    return { changes: (result.meta as Record<string, unknown>)['changes'] as number ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }
}
