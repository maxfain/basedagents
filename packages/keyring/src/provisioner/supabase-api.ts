/**
 * Supabase management API client (PROVISIONER spec §1) — everything after
 * bootstrap is API-by-ID, authenticated with the provisioning credential (a
 * personal access token, `sbp_…`).
 *
 * Endpoint matrix (api.supabase.com v1; canary-checked — see
 * scripts/canary-supabase.mjs):
 *   GET    /v1/projects                        → list projects; also the
 *          cheap validity probe (Vercel's whoami equivalent).
 *   GET    /v1/projects/{ref}/api-keys?reveal=true
 *          → every key incl. values: NEW keys ({ type: 'publishable'|'secret',
 *            id, api_key }) and LEGACY JWTs ({ name: 'anon'|'service_role' }).
 *   POST   /v1/projects/{ref}/api-keys         → mint a NEW key; body
 *          { type: 'secret', name, description? } → { id, api_key: 'sb_secret_…' }.
 *          Per-key deletable — this is what makes per-agent revocation real.
 *   DELETE /v1/projects/{ref}/api-keys/{id}    → burn by id.
 * Error shape: { message } (sometimes { error }). Unlike Vercel tokens,
 * Supabase PATs and secret keys have NO expiry — the burn path is the only
 * provider-side leash, which is why minted keys must always carry their id.
 */

const API = 'https://api.supabase.com';

export class SupabaseApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(`Supabase API ${status}: ${message}`);
    this.name = 'SupabaseApiError';
  }
}

export interface SupabaseProject {
  /** The project ref — also the API-keys path segment and the *.supabase.co host. */
  id: string;
  name: string;
  status?: string;
}

export interface SupabaseApiKey {
  /** Present on NEW-style keys; legacy JWTs have no id and cannot be burned individually. */
  id?: string;
  /** Legacy: 'anon' | 'service_role'. New keys: the name given at mint. */
  name?: string;
  /** 'legacy' | 'publishable' | 'secret' (absent on some legacy responses). */
  type?: string;
  /** The key value — only populated with ?reveal=true or on mint. */
  api_key?: string;
}

/** The project's public URL — not a secret; agents need it beside the key. */
export function supabaseProjectUrl(ref: string): string {
  return `https://${ref}.supabase.co`;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class SupabaseApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
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
      const message =
        (typeof json.message === 'string' && json.message) ||
        (typeof json.error === 'string' && json.error) ||
        res.statusText;
      throw new SupabaseApiError(res.status, message);
    }
    return json as T;
  }

  /** Cheap validity probe AND the project roster — one call does both. */
  async listProjects(): Promise<SupabaseProject[]> {
    const json = await this.request<unknown>('GET', '/v1/projects');
    if (!Array.isArray(json)) throw new SupabaseApiError(200, 'projects response is not an array');
    return (json as Array<Record<string, unknown>>).map((p) => ({
      id: String(p.id ?? ''),
      name: String(p.name ?? ''),
      status: typeof p.status === 'string' ? p.status : undefined,
    }));
  }

  /** All keys for a project; reveal=true includes the values (mint-fallback path). */
  async listApiKeys(projectRef: string, reveal: boolean): Promise<SupabaseApiKey[]> {
    const q = reveal ? '?reveal=true' : '';
    const json = await this.request<unknown>('GET', `/v1/projects/${encodeURIComponent(projectRef)}/api-keys${q}`);
    if (!Array.isArray(json)) throw new SupabaseApiError(200, 'api-keys response is not an array');
    return json as SupabaseApiKey[];
  }

  /**
   * Mint a NEW secret key (`sb_secret_…`) — individually deletable, which is
   * the whole point. Name constraint observed in docs: lowercase alphanumeric
   * and underscores (the canary re-verifies).
   */
  async createSecretKey(projectRef: string, name: string, description?: string): Promise<{ id: string; apiKey: string }> {
    const json = await this.request<{ id?: string; api_key?: string }>(
      'POST',
      `/v1/projects/${encodeURIComponent(projectRef)}/api-keys`,
      { type: 'secret', name, ...(description ? { description } : {}) },
    );
    if (!json.id || !json.api_key) {
      throw new SupabaseApiError(200, 'create-key response missing id/api_key');
    }
    return { id: json.id, apiKey: json.api_key };
  }

  /** Burn by id. Missing keys count as burned (the goal state is "gone"). */
  async deleteApiKey(projectRef: string, id: string): Promise<'burned' | 'already_gone'> {
    try {
      await this.request('DELETE', `/v1/projects/${encodeURIComponent(projectRef)}/api-keys/${encodeURIComponent(id)}`);
      return 'burned';
    } catch (err) {
      if (err instanceof SupabaseApiError && err.status === 404) return 'already_gone';
      throw err;
    }
  }
}
