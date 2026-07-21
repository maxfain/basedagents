/**
 * Vercel token API client (PROVISIONER spec §1) — everything after bootstrap is
 * API-by-ID, authenticated with the provisioning credential.
 *
 * Endpoint matrix VERIFIED against production (2026-07) via pre-auth schema
 * validation (the API validates request bodies before auth, so the contract is
 * observable without a token):
 *   GET    /v2/user                  → whoami                       (exists)
 *   POST   /v3/user/tokens           → create; body is STRICTLY
 *          { name: string, expiresAt?: number(ms) } — additional properties are
 *          rejected ("should NOT have additional property"), which also proves
 *          this endpoint cannot mint team/project-scoped tokens today. Agent
 *          tokens are therefore account-scope classic; the credential card must
 *          say so honestly (§1 "record the actual blast radius").
 *   GET    /v5/user/tokens           → list                         (exists)
 *   DELETE /v3/user/tokens/{id}      → burn by id                   (exists)
 * Error shape: { error: { code, message } }. The weekly canary re-verifies all
 * of this with a real token; response-body field names below come from Vercel's
 * docs and are canary-checked.
 */

const API = 'https://api.vercel.com';

export class VercelApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(`Vercel API ${status} (${code}): ${message}`);
    this.name = 'VercelApiError';
  }
}

export interface VercelTokenMeta {
  id: string;
  name: string;
  /** ms epoch, absent = non-expiring (we never create those). */
  expiresAt?: number;
  activeAt?: number;
  createdAt?: number;
}

export interface MintResult {
  meta: VercelTokenMeta;
  /** The one-time secret. Callers must move it into the vault and drop it. */
  bearerToken: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class VercelApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = (json.error ?? {}) as { code?: string; message?: string };
      throw new VercelApiError(res.status, err.code ?? 'unknown', err.message ?? res.statusText);
    }
    return json as T;
  }

  /** Cheap validity probe — also the post-mint verification (§5 step 6). */
  async whoami(): Promise<{ uid?: string; user?: { username?: string; email?: string } }> {
    return this.request('GET', '/v2/user');
  }

  /** Mint a token. expiresInDays is converted to the API's ms-epoch expiresAt. */
  async createToken(name: string, expiresInDays: number): Promise<MintResult> {
    const expiresAt = Date.now() + Math.round(expiresInDays * 24 * 60 * 60 * 1000);
    const json = await this.request<{ token?: VercelTokenMeta; bearerToken?: string }>(
      'POST', '/v3/user/tokens', { name, expiresAt }
    );
    if (!json.bearerToken || !json.token?.id) {
      throw new VercelApiError(200, 'unexpected_shape', 'create-token response missing bearerToken/token.id');
    }
    return { meta: json.token, bearerToken: json.bearerToken };
  }

  async listTokens(): Promise<VercelTokenMeta[]> {
    const json = await this.request<{ tokens?: VercelTokenMeta[] }>('GET', '/v5/user/tokens');
    return json.tokens ?? [];
  }

  /** Burn by id. Missing tokens count as burned (the goal state is "gone"). */
  async deleteToken(id: string): Promise<'burned' | 'already_gone'> {
    try {
      await this.request('DELETE', `/v3/user/tokens/${encodeURIComponent(id)}`);
      return 'burned';
    } catch (err) {
      if (err instanceof VercelApiError && err.status === 404) return 'already_gone';
      throw err;
    }
  }
}
