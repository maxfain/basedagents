/**
 * Tests for live certification (board spec §3 / §12.2).
 *
 * Two harnesses on purpose:
 *   - a bare DB with NO control-plane tables — the OSS deploy shape, where the
 *     probe must memoize `false` and every consumer degrades to uncertified
 *     instead of throwing "no such table";
 *   - a control DB (minimal `agents` + 0023 + 0025, the store.test.ts pattern
 *     — 0025 adds the credential `status` column the fragment filters on),
 *     where each leg of the 3-table EXISTS is flipped inactive one at a time
 *     to prove every revocation lever de-badges instantly (live, not
 *     snapshotted).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQLiteAdapter } from '../db/sqlite-adapter.js';
import {
  certifiedExistsSql,
  ownerCertifiedExistsSql,
  certificationTablesPresent,
  getCertifyingOwnerId,
  isCertified,
  resetCertificationProbeForTests,
} from './certification.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');
const MIGRATION_SQL =
  readFileSync(join(MIGRATIONS_DIR, '0023_owner_accounts.sql'), 'utf-8') +
  // 0025 adds owner_webauthn_credentials.status — the fragment's third leg.
  readFileSync(join(MIGRATIONS_DIR, '0025_owner_recovery.sql'), 'utf-8');

function makeBareDb(): { rawDb: Database.Database; db: SQLiteAdapter } {
  const rawDb = new Database(':memory:');
  rawDb.pragma('foreign_keys = ON');
  rawDb.exec(
    `CREATE TABLE agents (
       id TEXT PRIMARY KEY,
       name TEXT,
       status TEXT NOT NULL DEFAULT 'active'
     );`
  );
  return { rawDb, db: new SQLiteAdapter(rawDb) };
}

function makeControlDb(): { rawDb: Database.Database; db: SQLiteAdapter } {
  const made = makeBareDb();
  made.rawDb.exec(MIGRATION_SQL);
  return made;
}

let seq = 0;

/** Full certification chain: active owner + active passkey + active delegation. */
function certifyAgent(rawDb: Database.Database, agentId: string): { ownerId: string; delegationId: string; credentialRowId: string } {
  const n = ++seq;
  const ownerId = `ow_test${n}`;
  const credentialRowId = `cred_${n}`;
  rawDb.prepare(`INSERT INTO owners (id, status) VALUES (?, 'active')`).run(ownerId);
  rawDb
    .prepare(
      `INSERT INTO owner_webauthn_credentials (id, owner_id, credential_id, public_key, status)
       VALUES (?, ?, ?, ?, 'active')`
    )
    .run(credentialRowId, ownerId, `credid_${n}`, Buffer.from([1, 2, 3]));
  rawDb
    .prepare(
      `INSERT INTO action_assertions (id, owner_id, credential_id, action_type, action_hash, authenticator_data, client_data_json, signature, sequence, prev_hash, entry_hash)
       VALUES (?, ?, ?, 'agent.delegate', 'hash', 'ad', 'cdj', 'sig', 1, 'prev', 'entry')`
    )
    .run(`assert_${n}`, ownerId, `credid_${n}`);
  const delegationId = `del_${n}`;
  rawDb
    .prepare(
      `INSERT INTO delegations (id, owner_id, agent_id, status, authorizing_assertion_id)
       VALUES (?, ?, ?, 'active', ?)`
    )
    .run(delegationId, ownerId, agentId, `assert_${n}`);
  return { ownerId, delegationId, credentialRowId };
}

function insertAgent(rawDb: Database.Database, id: string): void {
  rawDb.prepare(`INSERT INTO agents (id, name) VALUES (?, ?)`).run(id, `agent-${id}`);
}

beforeEach(() => {
  resetCertificationProbeForTests();
});

describe('certificationTablesPresent — OSS probe', () => {
  it('returns false when the control-plane tables are absent, without throwing', async () => {
    const { db } = makeBareDb();
    expect(await certificationTablesPresent(db)).toBe(false);
    // isCertified rides the same probe — degraded, not broken.
    expect(await isCertified(db, 'ag_anyone')).toBe(false);
  });

  it('memoizes per isolate: tables created after a false probe stay invisible until reset', async () => {
    const { rawDb, db } = makeBareDb();
    expect(await certificationTablesPresent(db)).toBe(false);
    rawDb.exec(MIGRATION_SQL);
    // Still false: the probe answers once per isolate (table presence never
    // changes mid-flight in production — only tests can do this).
    expect(await certificationTablesPresent(db)).toBe(false);
    resetCertificationProbeForTests();
    expect(await certificationTablesPresent(db)).toBe(true);
  });

  it('does NOT memoize a TRANSIENT first-probe error (review fix): re-probes next call', async () => {
    // A connection blip on the very first probe must degrade only that one
    // request — not cache "tables absent" and de-certify the whole isolate.
    const control = makeControlDb();
    let calls = 0;
    const flaky = {
      get: async (sql: string, ...args: unknown[]) => {
        calls += 1;
        if (calls === 1) throw new Error('D1_ERROR: Network connection lost');
        return control.db.get(sql, ...(args as never[]));
      },
    } as unknown as SQLiteAdapter;

    // First call: transient error → false, but nothing memoized.
    expect(await certificationTablesPresent(flaky)).toBe(false);
    // Second call: re-probes (not stuck on the cached false) and sees the tables.
    expect(await certificationTablesPresent(flaky)).toBe(true);
  });

  it('DOES memoize a genuine missing-table error (OSS deploy)', async () => {
    let calls = 0;
    const missing = {
      get: async () => {
        calls += 1;
        throw new Error('SQLITE_ERROR: no such table: delegations');
      },
    } as unknown as SQLiteAdapter;

    expect(await certificationTablesPresent(missing)).toBe(false);
    expect(await certificationTablesPresent(missing)).toBe(false);
    // Memoized after the first definitive answer — the second call never re-probed.
    expect(calls).toBe(1);
  });
});

describe('isCertified — the 3-table EXISTS, live', () => {
  it('is true only while delegation, owner, and a passkey are ALL active', async () => {
    const { rawDb, db } = makeControlDb();
    insertAgent(rawDb, 'ag_cert');
    const { ownerId, delegationId, credentialRowId } = certifyAgent(rawDb, 'ag_cert');
    expect(await isCertified(db, 'ag_cert')).toBe(true);

    // Each flip is a real revocation lever; each must de-badge on the very
    // next read (no snapshot, no per-agent caching) and restore the same way.
    rawDb.prepare(`UPDATE delegations SET status = 'revoked' WHERE id = ?`).run(delegationId);
    expect(await isCertified(db, 'ag_cert')).toBe(false);
    rawDb.prepare(`UPDATE delegations SET status = 'active' WHERE id = ?`).run(delegationId);
    expect(await isCertified(db, 'ag_cert')).toBe(true);

    rawDb.prepare(`UPDATE owners SET status = 'suspended' WHERE id = ?`).run(ownerId);
    expect(await isCertified(db, 'ag_cert')).toBe(false);
    rawDb.prepare(`UPDATE owners SET status = 'active' WHERE id = ?`).run(ownerId);
    expect(await isCertified(db, 'ag_cert')).toBe(true);

    rawDb.prepare(`UPDATE owner_webauthn_credentials SET status = 'revoked' WHERE id = ?`).run(credentialRowId);
    expect(await isCertified(db, 'ag_cert')).toBe(false);
    rawDb.prepare(`UPDATE owner_webauthn_credentials SET status = 'active' WHERE id = ?`).run(credentialRowId);
    expect(await isCertified(db, 'ag_cert')).toBe(true);
  });

  it('is false for an agent with no delegation at all', async () => {
    const { rawDb, db } = makeControlDb();
    insertAgent(rawDb, 'ag_lone');
    expect(await isCertified(db, 'ag_lone')).toBe(false);
  });
});

describe('getCertifyingOwnerId — the write-tier pool lookup', () => {
  it('degrades to null on an OSS DB (rides the probe, no throw)', async () => {
    const { db } = makeBareDb();
    expect(await getCertifyingOwnerId(db, 'ag_anyone')).toBe(null);
  });

  it('resolves the certifying owner, and drops to null with each revocation lever', async () => {
    const { rawDb, db } = makeControlDb();
    insertAgent(rawDb, 'ag_pooled');
    const { ownerId, delegationId, credentialRowId } = certifyAgent(rawDb, 'ag_pooled');

    expect(await getCertifyingOwnerId(db, 'ag_pooled')).toBe(ownerId);

    // Every leg that de-badges must also dissolve the pool mapping — an agent
    // must never keep drawing from a revoked owner's certified bucket.
    rawDb.prepare(`UPDATE delegations SET status = 'revoked' WHERE id = ?`).run(delegationId);
    expect(await getCertifyingOwnerId(db, 'ag_pooled')).toBe(null);
    rawDb.prepare(`UPDATE delegations SET status = 'active' WHERE id = ?`).run(delegationId);

    rawDb.prepare(`UPDATE owners SET status = 'suspended' WHERE id = ?`).run(ownerId);
    expect(await getCertifyingOwnerId(db, 'ag_pooled')).toBe(null);
    rawDb.prepare(`UPDATE owners SET status = 'active' WHERE id = ?`).run(ownerId);

    rawDb.prepare(`UPDATE owner_webauthn_credentials SET status = 'revoked' WHERE id = ?`).run(credentialRowId);
    expect(await getCertifyingOwnerId(db, 'ag_pooled')).toBe(null);
  });

  it('maps an agent certified by two owners to ONE stable pool (oldest delegation)', async () => {
    const { rawDb, db } = makeControlDb();
    insertAgent(rawDb, 'ag_shared');
    const first = certifyAgent(rawDb, 'ag_shared');
    const second = certifyAgent(rawDb, 'ag_shared');
    // CURRENT_TIMESTAMP has second resolution — both rows usually collide, so
    // pin distinct created_at values to make the oldest-first pick explicit.
    rawDb.prepare(`UPDATE delegations SET created_at = '2026-01-01 00:00:00' WHERE id = ?`).run(first.delegationId);
    rawDb.prepare(`UPDATE delegations SET created_at = '2026-01-02 00:00:00' WHERE id = ?`).run(second.delegationId);

    expect(await getCertifyingOwnerId(db, 'ag_shared')).toBe(first.ownerId);
    // Repeat reads never flip between the two owners' buckets.
    expect(await getCertifyingOwnerId(db, 'ag_shared')).toBe(first.ownerId);
  });
});

describe('ownerCertifiedExistsSql — the Verified-human fragment', () => {
  it('is true only while the owner is active AND holds an active passkey', async () => {
    const { rawDb, db } = makeControlDb();
    insertAgent(rawDb, 'ag_ownercheck');
    const { ownerId, credentialRowId } = certifyAgent(rawDb, 'ag_ownercheck');

    const check = async (): Promise<number> =>
      (await db.get<{ ok: number }>(`SELECT ${ownerCertifiedExistsSql('?')} AS ok`, ownerId))!.ok;

    expect(await check()).toBe(1);

    rawDb.prepare(`UPDATE owner_webauthn_credentials SET status = 'revoked' WHERE id = ?`).run(credentialRowId);
    expect(await check()).toBe(0);
    rawDb.prepare(`UPDATE owner_webauthn_credentials SET status = 'active' WHERE id = ?`).run(credentialRowId);

    rawDb.prepare(`UPDATE owners SET status = 'suspended' WHERE id = ?`).run(ownerId);
    expect(await check()).toBe(0);
  });
});

describe('certifiedExistsSql — column-parameterized row fragment', () => {
  it('flags certified rows in a list query via a trusted column name', async () => {
    const { rawDb, db } = makeControlDb();
    insertAgent(rawDb, 'ag_a_certified');
    insertAgent(rawDb, 'ag_b_plain');
    certifyAgent(rawDb, 'ag_a_certified');

    const rows = await db.all<{ id: string; certified: number }>(
      `SELECT a.id, ${certifiedExistsSql('a.id')} AS certified FROM agents a ORDER BY a.id`
    );
    expect(rows).toEqual([
      { id: 'ag_a_certified', certified: 1 },
      { id: 'ag_b_plain', certified: 0 },
    ]);
  });
});
