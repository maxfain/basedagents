/**
 * OAuthStore unit tests (SPEC §2/§3/§4/§8): every atomic single-use consume
 * returns changes===1 exactly once then null; owner-binding is set-once; refresh
 * rotation revokes the whole chain on reuse; and — the load-bearing invariant —
 * NO plaintext token/code ever lands in any table (hash-at-rest).
 *
 * Uses setupMcpTestDb() (owners(0023)+0025+0033+0034, foreign_keys ON) so the
 * owner FKs are real; owner fixtures are inserted straight on the raw handle.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { setupMcpTestDb } from './test-migrations.js';
import { OAuthStore } from './oauth-store.js';
import { sha256, bytesToHex } from '../crypto/index.js';

const RESOURCE = 'https://mcp.basedagents.ai/mcp';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'; // an S256 challenge

function sha256hex(input: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(input)));
}
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

let rawDb: Database.Database;
let store: OAuthStore;

/** Insert a bare owner row and return its id. */
function seedOwner(id: string, email?: string): string {
  rawDb
    .prepare(`INSERT INTO owners (id, email, status) VALUES (?, ?, 'active')`)
    .run(id, email ?? `${id}@example.com`);
  return id;
}

beforeEach(() => {
  const t = setupMcpTestDb();
  rawDb = t.rawDb;
  store = new OAuthStore(t.db);
});

describe('oauth_clients', () => {
  it('creates a public client and round-trips redirect_uris', async () => {
    const c = await store.createClient({ clientName: 'claude.ai', redirectUris: [REDIRECT] });
    expect(c.client_id).toMatch(/^oc_/);
    expect(c.token_endpoint_auth_method).toBe('none');
    const got = await store.getClient(c.client_id);
    expect(got?.redirect_uris).toEqual([REDIRECT]);
    expect(got?.grant_types).toEqual(['authorization_code', 'refresh_token']);
  });

  it('getClient returns null for an unknown id', async () => {
    expect(await store.getClient('oc_nope')).toBeNull();
  });

  it('touchClient stamps last_used_at; countClientsByIpSince feeds the DCR limiter', async () => {
    const c = await store.createClient({ redirectUris: [REDIRECT], regIpHash: 'ipx' });
    await store.touchClient(c.client_id, iso());
    expect((await store.getClient(c.client_id))?.last_used_at).not.toBeNull();
    expect(await store.countClientsByIpSince('ipx', iso(-1000))).toBe(1);
    expect(await store.countClientsByIpSince('other', iso(-1000))).toBe(0);
  });
});

describe('oauth_authorization_requests', () => {
  it('createAuthRequest persists params with owner_id NULL', async () => {
    const id = await store.createAuthRequest({
      clientId: 'oc_1', redirectUri: REDIRECT, codeChallenge: CHALLENGE,
      resource: RESOURCE, scope: 'registry:read board:post', state: 'st',
    });
    expect(id).toMatch(/^authreq_/);
    const row = await store.getAuthRequest(id);
    expect(row?.owner_id).toBeNull();
    expect(row?.scope).toBe('registry:read board:post');
    expect(row?.state).toBe('st');
  });

  it('setAuthRequestOwner binds once, then a second bind is rejected', async () => {
    seedOwner('ow_a');
    seedOwner('ow_b');
    const id = await store.createAuthRequest({
      clientId: 'oc_1', redirectUri: REDIRECT, codeChallenge: CHALLENGE, resource: RESOURCE, scope: 'registry:read',
    });
    expect(await store.setAuthRequestOwner(id, 'ow_a', iso())).toBe(true);
    // second attempt (login fixation) can't re-point owner_id
    expect(await store.setAuthRequestOwner(id, 'ow_b', iso())).toBe(false);
    expect((await store.getAuthRequest(id))?.owner_id).toBe('ow_a');
  });

  it('setAuthRequestOwner fails on an expired request', async () => {
    seedOwner('ow_a');
    const id = await store.createAuthRequest({
      clientId: 'oc_1', redirectUri: REDIRECT, codeChallenge: CHALLENGE,
      resource: RESOURCE, scope: 'registry:read', ttlSeconds: -1,
    });
    expect(await store.setAuthRequestOwner(id, 'ow_a', iso())).toBe(false);
  });

  it('consumeAuthRequest is single-use and requires a bound owner', async () => {
    seedOwner('ow_a');
    const id = await store.createAuthRequest({
      clientId: 'oc_1', redirectUri: REDIRECT, codeChallenge: CHALLENGE, resource: RESOURCE, scope: 'board:post',
    });
    // no owner yet → cannot consume
    expect(await store.consumeAuthRequest(id, iso())).toBeNull();
    await store.setAuthRequestOwner(id, 'ow_a', iso());
    const first = await store.consumeAuthRequest(id, iso());
    expect(first?.owner_id).toBe('ow_a');
    expect(first?.client_id).toBe('oc_1');
    // replay → null
    expect(await store.consumeAuthRequest(id, iso())).toBeNull();
  });
});

describe('oauth_login_challenges', () => {
  it('consumeLoginChallenge returns owner+authreq once, then null (atomic single-use)', async () => {
    seedOwner('ow_a');
    const { token } = await store.createLoginChallenge({ ownerId: 'ow_a', authreqId: 'authreq_1' });
    const first = await store.consumeLoginChallenge(token, iso());
    expect(first).toEqual({ owner_id: 'ow_a', authreq_id: 'authreq_1' });
    expect(await store.consumeLoginChallenge(token, iso())).toBeNull();
  });

  it('rejects an expired challenge', async () => {
    seedOwner('ow_a');
    const { token } = await store.createLoginChallenge({ ownerId: 'ow_a', authreqId: 'authreq_1', ttlSeconds: -1 });
    expect(await store.consumeLoginChallenge(token, iso())).toBeNull();
  });
});

describe('oauth_auth_codes', () => {
  it('mint→consume returns the full binding, single-use, 60s TTL respected', async () => {
    seedOwner('ow_a');
    const { code } = await store.mintAuthCode({
      clientId: 'oc_1', ownerId: 'ow_a', redirectUri: REDIRECT,
      codeChallenge: CHALLENGE, resource: RESOURCE, scope: 'registry:read board:post',
    });
    const b = await store.consumeAuthCode(code, iso());
    expect(b).toEqual({
      client_id: 'oc_1', owner_id: 'ow_a', redirect_uri: REDIRECT,
      code_challenge: CHALLENGE, resource: RESOURCE, scope: 'registry:read board:post',
    });
    // replay → null (single-use)
    expect(await store.consumeAuthCode(code, iso())).toBeNull();
  });

  it('rejects a code consumed after its TTL', async () => {
    seedOwner('ow_a');
    const { code } = await store.mintAuthCode({
      clientId: 'oc_1', ownerId: 'ow_a', redirectUri: REDIRECT,
      codeChallenge: CHALLENGE, resource: RESOURCE, scope: 'registry:read',
    });
    // consume 61s in the future → expired
    expect(await store.consumeAuthCode(code, iso(61_000))).toBeNull();
  });
});

describe('oauth_access_tokens', () => {
  it('validateAccessToken resolves owner/scope while live; nulls when expired', async () => {
    seedOwner('ow_a');
    const { token } = await store.mintAccessToken({
      clientId: 'oc_1', ownerId: 'ow_a', resource: RESOURCE, scope: 'registry:read board:post',
    });
    const row = await store.validateAccessToken(token, iso());
    expect(row).toEqual({
      owner_id: 'ow_a', client_id: 'oc_1', resource: RESOURCE, scope: 'registry:read board:post',
    });
    // an hour + 1s later → expired
    expect(await store.validateAccessToken(token, iso(3_601_000))).toBeNull();
  });

  it('nulls a revoked token', async () => {
    seedOwner('ow_a');
    const { token } = await store.mintAccessToken({ clientId: 'oc_1', ownerId: 'ow_a', resource: RESOURCE, scope: 'registry:read' });
    rawDb.prepare(`UPDATE oauth_access_tokens SET revoked_at = ? WHERE token_hash = ?`).run(iso(), sha256hex(token));
    expect(await store.validateAccessToken(token, iso())).toBeNull();
  });
});

describe('oauth_refresh_tokens — rotation + reuse detection', () => {
  it('rotates: consumes the old, issues a fresh token carrying the binding', async () => {
    seedOwner('ow_a');
    const { token: r0 } = await store.mintRefreshToken({
      clientId: 'oc_1', ownerId: 'ow_a', resource: RESOURCE, scope: 'board:post',
    });
    const res = await store.rotateRefreshToken(r0, iso());
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') throw new Error('unreachable');
    expect(res.owner_id).toBe('ow_a');
    expect(res.scope).toBe('board:post');
    expect(res.refresh_token).not.toBe(r0);
    // the successor rotates cleanly too
    expect((await store.rotateRefreshToken(res.refresh_token, iso())).status).toBe('ok');
  });

  it('unknown / revoked / expired → invalid', async () => {
    seedOwner('ow_a');
    expect((await store.rotateRefreshToken('never-minted', iso())).status).toBe('invalid');
    const { token } = await store.mintRefreshToken({ clientId: 'oc_1', ownerId: 'ow_a', resource: RESOURCE, scope: 'board:post', ttlSeconds: -1 });
    expect((await store.rotateRefreshToken(token, iso())).status).toBe('invalid');
  });

  it('REUSE of a consumed token revokes the ENTIRE successor chain', async () => {
    seedOwner('ow_a');
    const { token: r0 } = await store.mintRefreshToken({ clientId: 'oc_1', ownerId: 'ow_a', resource: RESOURCE, scope: 'board:post' });
    const s1 = await store.rotateRefreshToken(r0, iso());
    if (s1.status !== 'ok') throw new Error('unreachable');
    const s2 = await store.rotateRefreshToken(s1.refresh_token, iso());
    if (s2.status !== 'ok') throw new Error('unreachable');

    // attacker replays the ORIGINAL (already consumed) token → reuse detected
    const reuse = await store.rotateRefreshToken(r0, iso());
    expect(reuse.status).toBe('reused');

    // every token in the chain (r0, s1, s2) is now revoked → all invalid
    expect((await store.rotateRefreshToken(s1.refresh_token, iso())).status).not.toBe('ok');
    expect((await store.rotateRefreshToken(s2.refresh_token, iso())).status).toBe('invalid');
    const live = rawDb.prepare(`SELECT COUNT(*) AS n FROM oauth_refresh_tokens WHERE revoked_at IS NULL`).get() as { n: number };
    expect(live.n).toBe(0);
  });
});

describe('hash-at-rest', () => {
  it('never persists any plaintext token/code — only sha256hex is stored', async () => {
    seedOwner('ow_a');
    const authreqId = await store.createAuthRequest({
      clientId: 'oc_1', redirectUri: REDIRECT, codeChallenge: CHALLENGE, resource: RESOURCE, scope: 'board:post',
    });
    await store.setAuthRequestOwner(authreqId, 'ow_a', iso());
    const { token: lt } = await store.createLoginChallenge({ ownerId: 'ow_a', authreqId });
    const { code } = await store.mintAuthCode({ clientId: 'oc_1', ownerId: 'ow_a', redirectUri: REDIRECT, codeChallenge: CHALLENGE, resource: RESOURCE, scope: 'board:post' });
    const { token: at } = await store.mintAccessToken({ clientId: 'oc_1', ownerId: 'ow_a', resource: RESOURCE, scope: 'board:post' });
    const { token: rt } = await store.mintRefreshToken({ clientId: 'oc_1', ownerId: 'ow_a', resource: RESOURCE, scope: 'board:post' });

    const plaintext = [lt, code, at, rt];
    // dump every row of the token-bearing tables and assert no plaintext appears
    const tables = ['oauth_login_challenges', 'oauth_auth_codes', 'oauth_access_tokens', 'oauth_refresh_tokens'];
    for (const t of tables) {
      const rows = rawDb.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
      const blob = JSON.stringify(rows);
      for (const p of plaintext) expect(blob.includes(p)).toBe(false);
    }
    // and the stored hashes DO match sha256hex(plaintext) → lookups work by hash only
    const cRow = rawDb.prepare(`SELECT code_hash FROM oauth_auth_codes`).get() as { code_hash: string };
    expect(cRow.code_hash).toBe(sha256hex(code));
  });
});
