/**
 * Atomic CRUD/consume over the six 0034 OAuth tables (SPEC §2/§3/§4/§8).
 *
 * This is the connector's ENTIRE credential surface — the cookieless MCP Worker
 * shares the agent-registry D1 but never mounts /v1/owner, so every security
 * decision the AS makes is one of the statements below.
 *
 * Two hard rules from the survey, enforced uniformly here:
 *
 *  1. NO plaintext at rest. Callers pass the PLAINTEXT token to consume/validate/
 *     rotate; the store hashes it (sha256hex) internally and only ever touches
 *     the hash column. Mint/create methods GENERATE the secret
 *     (base64url(randomBytes(32))), store its hash, and return the plaintext
 *     exactly once — it is never readable from the DB again.
 *
 *  2. NO transactions (D1/SQLite). Every single-use consume is ONE atomic
 *     conditional UPDATE — `SET consumed_at=? WHERE hash=? AND consumed_at IS
 *     NULL AND expires_at>?` — verified by `result.changes===1`. A preceding
 *     SELECT only fetches the bound params to RETURN; it is NEVER the gate. The
 *     UPDATE is the gate, so two concurrent consumes can never both see
 *     changes===1 (there is no read-then-write window). Mirrors the store.ts /
 *     consumeMagicLinkToken pattern exactly.
 *
 * Timestamps are ISO-8601 strings throughout; mint/create compute `now`
 * internally (like ControlStore.createMagicLinkToken) and take a ttlSeconds;
 * consume/validate/rotate/setOwner take an explicit `nowIso` so tests can drive
 * expiry deterministically.
 */
import type { DBAdapter } from '../db/adapter.js';
import { sha256, bytesToHex } from '../crypto/index.js';

const textEncoder = new TextEncoder();

/** sha256 hex of a utf-8 string — the at-rest form of every token/code/id. */
function sha256hex(input: string): string {
  return bytesToHex(sha256(textEncoder.encode(input)));
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** URL-safe base64 without padding — the secret/id encoding used repo-wide. */
function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A fresh high-entropy secret: base64url(randomBytes(32)) ≈ 256 bits. */
function newSecret(): string {
  return base64urlEncode(randomBytes(32));
}

/** A prefixed public identifier (client_id 'oc_…', authreq 'authreq_…'). */
function newId(prefix: string): string {
  return `${prefix}${base64urlEncode(randomBytes(24))}`;
}

function isoIn(seconds: number, from = Date.now()): string {
  return new Date(from + seconds * 1000).toISOString();
}

// ── TTLs (SPEC §2/§3) ──
export const AUTH_REQUEST_TTL_S = 10 * 60; // +10m
export const LOGIN_CHALLENGE_TTL_S = 15 * 60; // +15m
export const AUTH_CODE_TTL_S = 60; // +60s single-use
export const ACCESS_TOKEN_TTL_S = 60 * 60; // +1h
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60; // +30d

// ── Row/return shapes ──
export interface OAuthClient {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[]; // parsed from the stored JSON array
  token_endpoint_auth_method: string;
  grant_types: string[];
  registration_source: string;
  reg_ip_hash: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface AuthRequestRow {
  id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scope: string;
  state: string | null;
  owner_id: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

/** The tuple every downstream step must re-verify against (§2/§3/§6). */
export interface AuthCodeBinding {
  client_id: string;
  owner_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scope: string;
}

export interface AccessTokenRow {
  owner_id: string;
  client_id: string;
  resource: string;
  scope: string;
}

/** rotateRefreshToken outcome — the sentinel the token endpoint maps to a grant. */
export type RotateResult =
  | { status: 'ok'; refresh_token: string; owner_id: string; client_id: string; resource: string; scope: string }
  | { status: 'reused' } // presented an already-consumed token → chain revoked
  | { status: 'invalid' }; // unknown / revoked / expired

// Narrow raw-row typing without pulling a helper: every column we read is TEXT.
type Raw = Record<string, unknown>;
const s = (v: unknown): string => String(v);
const ns = (v: unknown): string | null => (v == null ? null : String(v));

export class OAuthStore {
  constructor(private db: DBAdapter) {}

  // ─────────────────────────── oauth_clients ───────────────────────────

  /**
   * Register a public DCR client (RFC 7591, no secret). redirect_uris is stored
   * as a JSON array and later matched by EXACT byte comparison. Returns the full
   * parsed client (the caller echoes client_id + registration metadata).
   */
  async createClient(input: {
    clientName?: string | null;
    redirectUris: string[];
    regIpHash?: string | null;
    registrationSource?: string;
    metadata?: unknown;
  }): Promise<OAuthClient> {
    const clientId = newId('oc_');
    const now = new Date().toISOString();
    const grantTypes = ['authorization_code', 'refresh_token'];
    await this.db.run(
      `INSERT INTO oauth_clients
         (client_id, client_name, redirect_uris, token_endpoint_auth_method,
          grant_types, registration_source, reg_ip_hash, metadata, created_at, last_used_at)
       VALUES (?, ?, ?, 'none', ?, ?, ?, ?, ?, NULL)`,
      clientId,
      input.clientName ?? null,
      JSON.stringify(input.redirectUris),
      JSON.stringify(grantTypes),
      input.registrationSource ?? 'dcr',
      input.regIpHash ?? null,
      input.metadata == null ? null : JSON.stringify(input.metadata),
      now,
    );
    return {
      client_id: clientId,
      client_name: input.clientName ?? null,
      redirect_uris: input.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: grantTypes,
      registration_source: input.registrationSource ?? 'dcr',
      reg_ip_hash: input.regIpHash ?? null,
      created_at: now,
      last_used_at: null,
    };
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const r = await this.db.get<Raw>(
      `SELECT client_id, client_name, redirect_uris, token_endpoint_auth_method,
              grant_types, registration_source, reg_ip_hash, created_at, last_used_at
       FROM oauth_clients WHERE client_id = ?`,
      clientId,
    );
    if (!r) return null;
    return {
      client_id: s(r.client_id),
      client_name: ns(r.client_name),
      redirect_uris: JSON.parse(s(r.redirect_uris)) as string[],
      token_endpoint_auth_method: s(r.token_endpoint_auth_method),
      grant_types: JSON.parse(s(r.grant_types)) as string[],
      registration_source: s(r.registration_source),
      reg_ip_hash: ns(r.reg_ip_hash),
      created_at: s(r.created_at),
      last_used_at: ns(r.last_used_at),
    };
  }

  /** Stamp last_used_at (GC signal for never-used clients). Not security-critical. */
  async touchClient(clientId: string, nowIso: string): Promise<void> {
    await this.db.run(`UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?`, nowIso, clientId);
  }

  /** Count clients registered from one IP hash since a cutoff (DCR rate limit feed). */
  async countClientsByIpSince(regIpHash: string, sinceIso: string): Promise<number> {
    const r = await this.db.get<Raw>(
      `SELECT COUNT(*) AS n FROM oauth_clients WHERE reg_ip_hash = ? AND created_at > ?`,
      regIpHash,
      sinceIso,
    );
    return Number(r?.n ?? 0);
  }

  // ──────────────────── oauth_authorization_requests ────────────────────

  /** Persist the full /authorize request; owner_id starts NULL. Returns authreq_id. */
  async createAuthRequest(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    resource: string;
    scope: string;
    state?: string | null;
    ttlSeconds?: number;
  }): Promise<string> {
    const id = newId('authreq_');
    const now = Date.now();
    await this.db.run(
      `INSERT INTO oauth_authorization_requests
         (id, client_id, redirect_uri, code_challenge, resource, scope, state,
          owner_id, created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
      id,
      input.clientId,
      input.redirectUri,
      input.codeChallenge,
      input.resource,
      input.scope,
      input.state ?? null,
      new Date(now).toISOString(),
      isoIn(input.ttlSeconds ?? AUTH_REQUEST_TTL_S, now),
    );
    return id;
  }

  async getAuthRequest(id: string): Promise<AuthRequestRow | null> {
    const r = await this.db.get<Raw>(
      `SELECT id, client_id, redirect_uri, code_challenge, resource, scope, state,
              owner_id, created_at, expires_at, consumed_at
       FROM oauth_authorization_requests WHERE id = ?`,
      id,
    );
    if (!r) return null;
    return {
      id: s(r.id),
      client_id: s(r.client_id),
      redirect_uri: s(r.redirect_uri),
      code_challenge: s(r.code_challenge),
      resource: s(r.resource),
      scope: s(r.scope),
      state: ns(r.state),
      owner_id: ns(r.owner_id),
      created_at: s(r.created_at),
      expires_at: s(r.expires_at),
      consumed_at: ns(r.consumed_at),
    };
  }

  /**
   * Bind the authenticated owner to the request — set EXACTLY ONCE, atomically:
   * WHERE owner_id IS NULL (a second magic-link consume can't re-point it) AND
   * unexpired. Returns true iff this call did the write (login-fixation defense,
   * §3 step 3).
   */
  async setAuthRequestOwner(id: string, ownerId: string, nowIso: string): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE oauth_authorization_requests SET owner_id = ?
       WHERE id = ? AND owner_id IS NULL AND expires_at > ?`,
      ownerId,
      id,
      nowIso,
    );
    return res.changes === 1;
  }

  /**
   * Single-use consume at /oauth/decision (Allow): requires the owner already
   * bound and the row unconsumed + unexpired. The atomic UPDATE is the gate;
   * the SELECT only fetches the tuple the code will be bound to. Returns the
   * bound request or null (already consumed / no owner / expired).
   */
  async consumeAuthRequest(id: string, nowIso: string): Promise<AuthRequestRow | null> {
    const row = await this.getAuthRequest(id);
    if (!row) return null;
    const res = await this.db.run(
      `UPDATE oauth_authorization_requests SET consumed_at = ?
       WHERE id = ? AND consumed_at IS NULL AND owner_id IS NOT NULL AND expires_at > ?`,
      nowIso,
      id,
      nowIso,
    );
    if (res.changes !== 1) return null;
    return { ...row, consumed_at: nowIso };
  }

  // ───────────────────── oauth_login_challenges ─────────────────────

  /**
   * Mint the AS's OWN magic-link challenge (purpose-isolated from the console).
   * Generates the link token, stores only its hash, returns the plaintext for
   * the email URL. Bound to authreq_id so the click resumes that exact request.
   */
  async createLoginChallenge(input: {
    ownerId: string;
    authreqId: string;
    ttlSeconds?: number;
  }): Promise<{ token: string }> {
    const token = newSecret();
    const now = Date.now();
    await this.db.run(
      `INSERT INTO oauth_login_challenges
         (token_hash, owner_id, authreq_id, created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      sha256hex(token),
      input.ownerId,
      input.authreqId,
      new Date(now).toISOString(),
      isoIn(input.ttlSeconds ?? LOGIN_CHALLENGE_TTL_S, now),
    );
    return { token };
  }

  /**
   * Atomically consume the magic-link challenge by the PLAINTEXT token. Returns
   * {owner_id, authreq_id} or null. Single-use via changes===1.
   */
  async consumeLoginChallenge(
    token: string,
    nowIso: string,
  ): Promise<{ owner_id: string; authreq_id: string } | null> {
    const hash = sha256hex(token);
    const r = await this.db.get<Raw>(
      `SELECT owner_id, authreq_id FROM oauth_login_challenges
       WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
      hash,
      nowIso,
    );
    if (!r) return null;
    const res = await this.db.run(
      `UPDATE oauth_login_challenges SET consumed_at = ?
       WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
      nowIso,
      hash,
      nowIso,
    );
    if (res.changes !== 1) return null;
    return { owner_id: s(r.owner_id), authreq_id: s(r.authreq_id) };
  }

  // ─────────────────────────── oauth_auth_codes ───────────────────────────

  /**
   * Mint a 60-second single-use authorization code bound to the full tuple.
   * Generates the code, stores only its hash, returns the plaintext for the
   * redirect. The token exchange re-verifies every binding.
   */
  async mintAuthCode(input: {
    clientId: string;
    ownerId: string;
    redirectUri: string;
    codeChallenge: string;
    resource: string;
    scope: string;
    ttlSeconds?: number;
  }): Promise<{ code: string }> {
    const code = newSecret();
    const now = Date.now();
    await this.db.run(
      `INSERT INTO oauth_auth_codes
         (code_hash, client_id, owner_id, redirect_uri, code_challenge, resource,
          scope, created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      sha256hex(code),
      input.clientId,
      input.ownerId,
      input.redirectUri,
      input.codeChallenge,
      input.resource,
      input.scope,
      new Date(now).toISOString(),
      isoIn(input.ttlSeconds ?? AUTH_CODE_TTL_S, now),
    );
    return { code };
  }

  /**
   * Atomically consume an auth code by PLAINTEXT. Returns the binding tuple the
   * token endpoint must re-verify (client_id, redirect_uri, code_challenge,
   * resource, scope) + owner_id, or null (replayed / expired / unknown).
   */
  async consumeAuthCode(code: string, nowIso: string): Promise<AuthCodeBinding | null> {
    const hash = sha256hex(code);
    const r = await this.db.get<Raw>(
      `SELECT client_id, owner_id, redirect_uri, code_challenge, resource, scope
       FROM oauth_auth_codes WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
      hash,
      nowIso,
    );
    if (!r) return null;
    const res = await this.db.run(
      `UPDATE oauth_auth_codes SET consumed_at = ?
       WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
      nowIso,
      hash,
      nowIso,
    );
    if (res.changes !== 1) return null;
    return {
      client_id: s(r.client_id),
      owner_id: s(r.owner_id),
      redirect_uri: s(r.redirect_uri),
      code_challenge: s(r.code_challenge),
      resource: s(r.resource),
      scope: s(r.scope),
    };
  }

  // ────────────────────────── oauth_access_tokens ──────────────────────────

  /** Mint a 1h access token; store only its hash; return the plaintext bearer. */
  async mintAccessToken(input: {
    clientId: string;
    ownerId: string;
    resource: string;
    scope: string;
    ttlSeconds?: number;
  }): Promise<{ token: string; expiresIn: number }> {
    const token = newSecret();
    const ttl = input.ttlSeconds ?? ACCESS_TOKEN_TTL_S;
    const now = Date.now();
    await this.db.run(
      `INSERT INTO oauth_access_tokens
         (token_hash, client_id, owner_id, resource, scope, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      sha256hex(token),
      input.clientId,
      input.ownerId,
      input.resource,
      input.scope,
      new Date(now).toISOString(),
      isoIn(ttl, now),
    );
    return { token, expiresIn: ttl };
  }

  /**
   * Resolve a PLAINTEXT bearer to its owner/scope — the /mcp middleware's gate.
   * A pure lookup (NOT a consume): valid only while not revoked and unexpired.
   * The caller still re-asserts resource===MCP_RESOURCE_URL every request.
   */
  async validateAccessToken(token: string, nowIso: string): Promise<AccessTokenRow | null> {
    const r = await this.db.get<Raw>(
      `SELECT owner_id, client_id, resource, scope FROM oauth_access_tokens
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
      sha256hex(token),
      nowIso,
    );
    if (!r) return null;
    return {
      owner_id: s(r.owner_id),
      client_id: s(r.client_id),
      resource: s(r.resource),
      scope: s(r.scope),
    };
  }

  // ────────────────────────── oauth_refresh_tokens ──────────────────────────

  /** Mint a 30d refresh token; store only its hash; return the plaintext. */
  async mintRefreshToken(input: {
    clientId: string;
    ownerId: string;
    resource: string;
    scope: string;
    ttlSeconds?: number;
  }): Promise<{ token: string }> {
    const token = newSecret();
    const now = Date.now();
    await this.db.run(
      `INSERT INTO oauth_refresh_tokens
         (token_hash, client_id, owner_id, resource, scope, created_at, expires_at,
          rotated_to, consumed_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      sha256hex(token),
      input.clientId,
      input.ownerId,
      input.resource,
      input.scope,
      new Date(now).toISOString(),
      isoIn(input.ttlSeconds ?? REFRESH_TOKEN_TTL_S, now),
    );
    return { token };
  }

  /**
   * Rotate a refresh token WITH REUSE DETECTION (§8):
   *
   *  - unknown / revoked / expired      → {status:'invalid'}
   *  - already CONSUMED (replay = theft) → walk `rotated_to` from the presented
   *    row forward and revoke the entire successor chain, forcing full re-auth →
   *    {status:'reused'}
   *  - live + unconsumed                 → atomically consume it (SET consumed_at,
   *    rotated_to=<new hash>; changes===1 is the gate), then mint the successor →
   *    {status:'ok', refresh_token, …binding}
   *
   * Consume-THEN-insert ordering: if a concurrent rotate already won the atomic
   * consume, changes!==1 and we mint no successor (no orphan valid token). The
   * caller mints the paired access token from the returned binding.
   */
  async rotateRefreshToken(token: string, nowIso: string): Promise<RotateResult> {
    const presentedHash = sha256hex(token);
    const row = await this.db.get<Raw>(
      `SELECT client_id, owner_id, resource, scope, expires_at, rotated_to,
              consumed_at, revoked_at
       FROM oauth_refresh_tokens WHERE token_hash = ?`,
      presentedHash,
    );
    if (!row) return { status: 'invalid' };

    // Reuse of an already-rotated token = the legit holder rotated forward and
    // an attacker is replaying the old one. Revoke the whole chain we can reach.
    if (row.consumed_at != null) {
      await this.revokeRefreshChain(presentedHash, nowIso);
      return { status: 'reused' };
    }
    if (row.revoked_at != null || s(row.expires_at) <= nowIso) {
      return { status: 'invalid' };
    }

    const binding = {
      client_id: s(row.client_id),
      owner_id: s(row.owner_id),
      resource: s(row.resource),
      scope: s(row.scope),
    };
    const successor = newSecret();
    const successorHash = sha256hex(successor);

    // ATOMIC gate: only the caller that flips consumed_at (changes===1) proceeds
    // to mint the successor; a concurrent rotate that already consumed it loses.
    const res = await this.db.run(
      `UPDATE oauth_refresh_tokens SET consumed_at = ?, rotated_to = ?
       WHERE token_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      nowIso,
      successorHash,
      presentedHash,
      nowIso,
    );
    if (res.changes !== 1) return { status: 'invalid' };

    await this.db.run(
      `INSERT INTO oauth_refresh_tokens
         (token_hash, client_id, owner_id, resource, scope, created_at, expires_at,
          rotated_to, consumed_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      successorHash,
      binding.client_id,
      binding.owner_id,
      binding.resource,
      binding.scope,
      nowIso,
      isoIn(REFRESH_TOKEN_TTL_S, Date.parse(nowIso)),
    );
    return { status: 'ok', refresh_token: successor, ...binding };
  }

  /**
   * Revoke a refresh token and every successor reachable via `rotated_to`
   * (theft response). Each revoke is its own conditional UPDATE; the visited set
   * guards a malformed self-referential chain from looping forever.
   */
  private async revokeRefreshChain(startHash: string, nowIso: string): Promise<void> {
    const visited = new Set<string>();
    let cursor: string | null = startHash;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const here: string = cursor;
      const r: Raw | null = await this.db.get<Raw>(
        `SELECT rotated_to FROM oauth_refresh_tokens WHERE token_hash = ?`,
        here,
      );
      await this.db.run(
        `UPDATE oauth_refresh_tokens SET revoked_at = ?
         WHERE token_hash = ? AND revoked_at IS NULL`,
        nowIso,
        here,
      );
      cursor = r ? ns(r.rotated_to) : null;
    }
  }
}
