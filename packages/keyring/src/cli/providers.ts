/**
 * Provider presets for connect-card resolution (onboarding redesign Move 3).
 *
 * When the daemon pulls a browser-sealed connection, it opens the ciphertext
 * locally and — where the provider has a cheap read-only endpoint — VALIDATES
 * the token against the provider API before storing. Validation runs on the
 * user's machine only; the raw token never touches the control plane.
 *
 * v0.1 = assisted paste. The Provisioner (v0.2) upgrades these same presets
 * to mint/rotate/burn without changing this interface.
 */

export interface ProviderPreset {
  id: string;
  label: string;
  envVar: string;
  /**
   * The narrowest token to create (Custody Fix 3). Shown to the human so they
   * paste a project-scoped key, never an account-wide one.
   */
  scopeHint?: string;
  /**
   * Hard reject BEFORE any network call — returns a reason string when the
   * token is the wrong *kind* (e.g. an account-wide token where a project key
   * exists), or null to allow. This is how Fix 3 refuses account-wide tokens.
   */
  reject?: (token: string) => string | null;
  /** Cheap shape check before any network call. */
  looksValid?: (token: string) => boolean;
  /** Live check against the provider API (user's machine only). */
  validate?: (token: string) => Promise<{ ok: boolean; detail: string }>;
}

/** Cap on a provider probe. Also keeps a stalled provider from making Ctrl-C
 *  unresponsive during the connect-card watch loop. */
const PROBE_TIMEOUT_MS = 8000;

/**
 * Run a validation probe with a strict fail policy:
 *   2xx              → the token works.
 *   401 / 403        → the provider REJECTED the token (fail closed).
 *   429 / 5xx / other → transient (rate-limited, outage) → fail OPEN and store,
 *                       exactly like an unreachable provider. A provider
 *                       incident must never brand a valid token as bad, because
 *                       the daemon does not re-pull a resolved connection.
 *   network error / timeout → fail OPEN (store, validation skipped).
 */
async function probe(
  label: string,
  url: string,
  token: string,
  onOk: (res: Response) => Promise<string>,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token.trim()}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true, detail: await onOk(res) };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: `${label} rejected the token (HTTP ${res.status})` };
    }
    return { ok: true, detail: `stored (validation skipped — ${label} returned HTTP ${res.status})` };
  } catch {
    return { ok: true, detail: `stored (validation skipped — ${label} unreachable)` };
  }
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  vercel: {
    id: 'vercel',
    label: 'Vercel',
    envVar: 'VERCEL_TOKEN',
    scopeHint: 'Create a token scoped to the specific project (Account Settings → Tokens → Scope: this project), not a full-account token.',
    looksValid: (t) => t.trim().length >= 20,
    validate: (token) =>
      probe('Vercel', 'https://api.vercel.com/v2/user', token, async (res) => {
        const body = (await res.json()) as { user?: { username?: string } };
        return `valid — account ${body.user?.username ?? 'confirmed'}`;
      }),
  },
  supabase: {
    id: 'supabase',
    label: 'Supabase',
    // Fix 3: store the PROJECT service_role key, never the account access token.
    envVar: 'SUPABASE_SERVICE_ROLE_KEY',
    scopeHint: 'Use the PROJECT service_role key (Project → Settings → API), not your account access token (sbp_…). One project, and the kill switch can scope it.',
    // The account-wide personal access token (sbp_…) can create/delete projects
    // across your whole account — refuse it and demand a project-scoped key.
    reject: (t) =>
      t.trim().startsWith('sbp_')
        ? 'That is an account-wide Supabase access token (sbp_…). Paste the PROJECT service_role key instead (Project → Settings → API) so it is scoped to one project and revocable.'
        : null,
    // A project service_role key is a JWT (eyJ…).
    looksValid: (t) => t.trim().startsWith('eyJ') && t.trim().length >= 40,
  },
};

/** Validate a pasted token for `provider`; unknown providers store as-is. */
export async function validateProviderToken(
  provider: string,
  token: string,
): Promise<{ ok: boolean; detail: string }> {
  const preset = PROVIDER_PRESETS[provider];
  if (!preset) return { ok: token.trim().length > 0, detail: token.trim() ? 'stored' : 'empty token' };
  // Fix 3: refuse the wrong *kind* of token (e.g. account-wide) before anything else.
  if (preset.reject) {
    const reason = preset.reject(token);
    if (reason) return { ok: false, detail: reason };
  }
  if (preset.looksValid && !preset.looksValid(token)) {
    const hint = preset.scopeHint ? ` ${preset.scopeHint}` : '';
    return { ok: false, detail: `that does not look like a ${preset.label} token.${hint}` };
  }
  if (preset.validate) return preset.validate(token);
  return { ok: true, detail: 'stored' };
}

export function presetEnvVar(provider: string): string {
  return PROVIDER_PRESETS[provider]?.envVar ?? `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_TOKEN`;
}
