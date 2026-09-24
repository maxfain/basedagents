/**
 * `Idempotency-Key` for write endpoints (agent-first plan §0.2). A client that
 * retries a POST with the same key gets the first response back instead of a
 * second write. Keys are scoped (to the signing agent, or an anonymous bucket)
 * and kept 24 h. The same key with a different body is a client bug: 422.
 *
 *   const idem = await beginIdempotent(db, scope, key, bodyText);
 *   if (idem.kind === 'replay') return c.json(idem.body, idem.status);
 *   if (idem.kind === 'conflict') return c.json({ error: 'idempotency_key_reused', ... }, 422);
 *   … do the write …
 *   await finishIdempotent(db, scope, key, bodyText, status, responseBody);
 */
import type { DBAdapter } from '../db/adapter.js';
import { sha256, bytesToHex } from '../crypto/index.js';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;

export type IdempotencyStart =
  | { kind: 'none' }
  | { kind: 'fresh' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'conflict' }
  | { kind: 'invalid' };

const hashBody = (body: string) => bytesToHex(sha256(new TextEncoder().encode(body)));

export async function beginIdempotent(db: DBAdapter, scope: string, key: string | undefined, body: string, nowIso: string): Promise<IdempotencyStart> {
  if (key === undefined || key === '') return { kind: 'none' };
  if (!KEY_RE.test(key)) return { kind: 'invalid' };
  const row = await db.get<{ request_hash: string; status: number; response: string; created_at: string }>(
    'SELECT request_hash, status, response, created_at FROM idempotency_keys WHERE scope = ? AND idem_key = ?', scope, key,
  );
  if (!row || Date.parse(row.created_at) < Date.parse(nowIso) - IDEMPOTENCY_TTL_MS) return { kind: 'fresh' };
  if (row.request_hash !== hashBody(body)) return { kind: 'conflict' };
  return { kind: 'replay', status: row.status, body: JSON.parse(row.response) };
}

export async function finishIdempotent(db: DBAdapter, scope: string, key: string | undefined, body: string, status: number, response: unknown, nowIso: string): Promise<void> {
  if (!key || !KEY_RE.test(key)) return;
  await db.run(
    `INSERT INTO idempotency_keys (scope, idem_key, request_hash, status, response, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, idem_key) DO UPDATE SET request_hash = excluded.request_hash, status = excluded.status, response = excluded.response, created_at = excluded.created_at`,
    scope, key, hashBody(body), status, JSON.stringify(response), nowIso,
  );
}

export async function sweepIdempotencyKeys(db: DBAdapter, nowIso: string): Promise<void> {
  await db.run('DELETE FROM idempotency_keys WHERE created_at < ?', new Date(Date.parse(nowIso) - IDEMPOTENCY_TTL_MS).toISOString());
}
