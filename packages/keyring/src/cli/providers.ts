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
    envVar: 'SUPABASE_ACCESS_TOKEN',
    looksValid: (t) => t.trim().startsWith('sbp_') && t.trim().length >= 20,
    validate: (token) =>
      probe('Supabase', 'https://api.supabase.com/v1/projects', token, async (res) => {
        const projects = (await res.json()) as unknown[];
        return `valid — ${Array.isArray(projects) ? projects.length : '?'} project(s) visible`;
      }),
  },
};

/** Validate a pasted token for `provider`; unknown providers store as-is. */
export async function validateProviderToken(
  provider: string,
  token: string,
): Promise<{ ok: boolean; detail: string }> {
  const preset = PROVIDER_PRESETS[provider];
  if (!preset) return { ok: token.trim().length > 0, detail: token.trim() ? 'stored' : 'empty token' };
  if (preset.looksValid && !preset.looksValid(token)) {
    return { ok: false, detail: `that does not look like a ${preset.label} token` };
  }
  if (preset.validate) return preset.validate(token);
  return { ok: true, detail: 'stored' };
}

export function presetEnvVar(provider: string): string {
  return PROVIDER_PRESETS[provider]?.envVar ?? `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_TOKEN`;
}
