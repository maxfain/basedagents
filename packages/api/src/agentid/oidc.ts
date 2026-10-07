/**
 * AgentID OIDC client — PKCE, authorization-code exchange, and id_token
 * verification, all Workers-native (WebCrypto + @noble, no jose/Node).
 *
 * BasedAgents is a CONFIDENTIAL OIDC client here (client_id + secret, Basic auth
 * at the token endpoint), distinct from the registry's own MCP OAuth *server*
 * (mcp/oauth.ts). AgentID signs id_tokens with ES256 (ECDSA P-256); a JWS/JWT
 * ES256 signature is raw r‖s (IEEE P1363, 64 bytes) — exactly what
 * crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'}) expects, so the signature
 * bytes are passed straight through with NO DER re-encoding (that is the WebAuthn
 * path, the reverse of this one).
 *
 * Verification is strict and fails closed by throwing AgentIdOidcError:
 *   1. header.alg MUST be ES256 (reject alg:none / HS256 key-confusion before
 *      ever importing the key, and only ever import it as an ECDSA verify key).
 *   2. signature verifies against the issuer JWKS key named by `kid`.
 *   3. iss === configured issuer (exact string).
 *   4. aud contains our client_id.
 *   5. exp not passed, iat not in the future (±60s skew).
 *   6. nonce equals the one we generated (constant-time compare).
 */

import { sha256, bytesToHex } from '../crypto/index.js';
import { base64urlEncode, base64urlDecode, timingSafeEqual } from '../mcp/websec.js';
import type { AgentIdConfig } from './index.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** ±60s, matching the AgentSig window and the repo's AUTH_MAX_CLOCK_SKEW. */
const CLOCK_SKEW_S = 60;
/** JWKS are cached per isolate for this long; a kid miss forces one refetch. */
const JWKS_TTL_MS = 10 * 60 * 1000;

export class AgentIdOidcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentIdOidcError';
  }
}

/** The subset of id_token claims we read. AgentID omits a claim when not granted. */
export interface AgentIdClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  azp?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  owner_sub?: string;
  owner_name?: string;
  owner_email?: string;
  [k: string]: unknown;
}

export interface AgentIdTokenResponse {
  id_token: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

interface JwkEc {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  kid?: string;
  alg?: string;
  use?: string;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** A fresh high-entropy URL-safe token (state / nonce / id suffix). */
export function randomToken(bytes = 32): string {
  return base64urlEncode(randomBytes(bytes));
}

/** sha256 hex of a utf-8 string (state-at-rest hashing). */
export function sha256hex(input: string): string {
  return bytesToHex(sha256(enc.encode(input)));
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** PKCE S256: verifier = 43-char base64url(32 bytes); challenge = base64url(sha256(ascii(verifier))). */
export function createPkce(): Pkce {
  const verifier = base64urlEncode(randomBytes(32));
  const challenge = base64urlEncode(sha256(enc.encode(verifier)));
  return { verifier, challenge };
}

/** Build the AgentID authorize URL the owner opens in a browser. */
export function buildAuthorizeUrl(
  cfg: AgentIdConfig,
  params: { state: string; nonce: string; codeChallenge: string },
): string {
  const u = new URL(cfg.authorizeUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('scope', cfg.scopes);
  u.searchParams.set('state', params.state);
  u.searchParams.set('nonce', params.nonce);
  u.searchParams.set('code_challenge', params.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

/** Module-level fetch override for tests (scripts the token + JWKS endpoints). */
let testFetch: typeof fetch | undefined;

/** JWKS cache shared across requests, keyed by JWKS URL — a per-request client
 *  instance would otherwise refetch the keys on every link completion. */
interface JwksEntry {
  fetchedAt: number;
  keys: Map<string, JwkEc>;
  anon: JwkEc[];
}
const jwksCacheByUrl = new Map<string, JwksEntry>();

export function setAgentIdFetchForTests(f: typeof fetch | undefined): void {
  testFetch = f;
  // Keep tests hermetic: a scripted (or cleared) fetch must not see another
  // test's cached keys. Production never calls this, so the cache persists there.
  jwksCacheByUrl.clear();
}

/**
 * A confidential OIDC client for one AgentID config. A single `fetchImpl` serves
 * both the token POST and the JWKS GET so tests mock both through one function.
 */
export class AgentIdOidcClient {
  private readonly cfg: AgentIdConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: AgentIdConfig, fetchImpl?: typeof fetch) {
    this.cfg = cfg;
    // Global fetch needs no `this` binding on Workers/undici; an injected impl
    // (a test's vi.fn) is used verbatim.
    this.fetchImpl = fetchImpl ?? testFetch ?? fetch;
  }

  /** Exchange an authorization code for tokens (Basic client auth + PKCE). */
  async exchangeCode(code: string, codeVerifier: string): Promise<AgentIdTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.cfg.redirectUri,
      code_verifier: codeVerifier,
    });
    const authorization = 'Basic ' + btoa(`${this.cfg.clientId}:${this.cfg.clientSecret}`);
    let res: Response;
    try {
      res = await this.fetchImpl(this.cfg.tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          authorization,
        },
        body: body.toString(),
      });
    } catch (err) {
      throw new AgentIdOidcError(`token endpoint unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AgentIdOidcError(`token endpoint returned ${res.status}: ${text.slice(0, 200)}`);
    }
    let json: AgentIdTokenResponse;
    try {
      json = (await res.json()) as AgentIdTokenResponse;
    } catch {
      throw new AgentIdOidcError('token endpoint returned non-JSON');
    }
    if (!json || typeof json.id_token !== 'string') {
      throw new AgentIdOidcError('token response is missing id_token');
    }
    return json;
  }

  /** Fetch + cache the issuer JWKS (module-level, keyed by URL); refetch on a cold
   *  cache, stale TTL, or when forced (kid rotation). */
  private async loadJwks(force: boolean): Promise<JwksEntry> {
    const cached = jwksCacheByUrl.get(this.cfg.jwksUrl);
    if (!force && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached;
    let res: Response;
    try {
      res = await this.fetchImpl(this.cfg.jwksUrl, { headers: { accept: 'application/json' } });
    } catch (err) {
      throw new AgentIdOidcError(`JWKS endpoint unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) throw new AgentIdOidcError(`JWKS endpoint returned ${res.status}`);
    let doc: { keys?: JwkEc[] };
    try {
      doc = (await res.json()) as { keys?: JwkEc[] };
    } catch {
      throw new AgentIdOidcError('JWKS endpoint returned non-JSON');
    }
    const keys = new Map<string, JwkEc>();
    const anon: JwkEc[] = [];
    for (const k of doc.keys ?? []) {
      // Only EC P-256 SIGNING keys are usable for ES256: exclude encryption keys
      // (use:'enc') and any key advertising a non-ES256 alg (key-misuse guard).
      if (k.kty !== 'EC' || (k.crv && k.crv !== 'P-256') || !k.x || !k.y) continue;
      if (k.use && k.use !== 'sig') continue;
      if (k.alg && k.alg !== 'ES256') continue;
      if (k.kid) keys.set(k.kid, k);
      else anon.push(k);
    }
    const entry: JwksEntry = { fetchedAt: Date.now(), keys, anon };
    jwksCacheByUrl.set(this.cfg.jwksUrl, entry);
    return entry;
  }

  private async resolveKey(kid: string | undefined): Promise<JwkEc> {
    let jwks = await this.loadJwks(false);
    const pick = (): JwkEc | undefined => {
      if (kid) return jwks.keys.get(kid);
      // No kid: only safe when the issuer publishes exactly one usable key.
      const all = [...jwks.keys.values(), ...jwks.anon];
      return all.length === 1 ? all[0] : undefined;
    };
    let jwk = pick();
    if (!jwk) {
      // Key rotation: refetch once before giving up.
      jwks = await this.loadJwks(true);
      jwk = pick();
    }
    if (!jwk) {
      throw new AgentIdOidcError(
        kid ? `no JWKS key matches kid=${kid}` : 'id_token has no kid and the JWKS is ambiguous',
      );
    }
    return jwk;
  }

  /**
   * Verify an AgentID id_token end to end and return its claims. Throws
   * AgentIdOidcError on ANY failure (signature, claims, or shape).
   */
  async verifyIdToken(idToken: string, opts: { nonce: string }): Promise<AgentIdClaims> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new AgentIdOidcError('id_token is not a compact JWS');
    const [h, p, s] = parts;

    let header: { alg?: string; kid?: string; typ?: string };
    let claims: AgentIdClaims;
    try {
      header = JSON.parse(dec.decode(base64urlDecode(h)));
    } catch {
      throw new AgentIdOidcError('id_token header is not valid base64url JSON');
    }
    // alg confusion guard: decide BEFORE touching the key material.
    if (header.alg !== 'ES256') throw new AgentIdOidcError(`unexpected id_token alg: ${header.alg}`);
    try {
      claims = JSON.parse(dec.decode(base64urlDecode(p)));
    } catch {
      throw new AgentIdOidcError('id_token payload is not valid base64url JSON');
    }

    const jwk = await this.resolveKey(header.kid);
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
    } catch (err) {
      throw new AgentIdOidcError(`JWKS key is not a valid P-256 key: ${(err as Error).message}`);
    }
    // raw r‖s (64 bytes) — pass directly, no DER. Copy into a fresh
    // ArrayBuffer-backed view so the type is BufferSource (not ArrayBufferLike).
    let sig: Uint8Array<ArrayBuffer>;
    try {
      sig = new Uint8Array(base64urlDecode(s));
    } catch {
      throw new AgentIdOidcError('id_token signature is not valid base64url');
    }
    const data = new Uint8Array(enc.encode(`${h}.${p}`));
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data);
    if (!ok) throw new AgentIdOidcError('id_token signature is invalid');

    // ── Claims ──
    if (claims.iss !== this.cfg.issuer) {
      throw new AgentIdOidcError(`id_token iss mismatch: ${String(claims.iss)}`);
    }
    const audOk = Array.isArray(claims.aud)
      ? claims.aud.includes(this.cfg.clientId)
      : claims.aud === this.cfg.clientId;
    if (!audOk) throw new AgentIdOidcError('id_token aud does not include our client_id');
    // OIDC Core 3.1.3.7: if azp is present it MUST be our client_id, and when aud
    // carries multiple values azp is required — otherwise a token authorized for a
    // different party that merely co-lists our client_id would be accepted.
    const azp = typeof claims.azp === 'string' ? claims.azp : undefined;
    if (azp !== undefined && azp !== this.cfg.clientId) {
      throw new AgentIdOidcError('id_token azp is not our client_id');
    }
    if (Array.isArray(claims.aud) && claims.aud.length > 1 && azp === undefined) {
      throw new AgentIdOidcError('id_token has multiple aud values without azp');
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || now > claims.exp + CLOCK_SKEW_S) {
      throw new AgentIdOidcError('id_token is expired');
    }
    if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > now) {
      throw new AgentIdOidcError('id_token iat is in the future');
    }
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
      throw new AgentIdOidcError('id_token has no sub');
    }
    if (typeof claims.nonce !== 'string' || !timingSafeEqual(claims.nonce, opts.nonce)) {
      throw new AgentIdOidcError('id_token nonce does not match');
    }
    return claims;
  }
}
