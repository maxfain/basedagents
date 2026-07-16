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

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  vercel: {
    id: 'vercel',
    label: 'Vercel',
    envVar: 'VERCEL_TOKEN',
    looksValid: (t) => t.trim().length >= 20,
    validate: async (token) => {
      try {
        const res = await fetch('https://api.vercel.com/v2/user', {
          headers: { Authorization: `Bearer ${token.trim()}` },
        });
        if (res.ok) {
          const body = (await res.json()) as { user?: { username?: string } };
          return { ok: true, detail: `valid — account ${body.user?.username ?? 'confirmed'}` };
        }
        return { ok: false, detail: `Vercel rejected the token (HTTP ${res.status})` };
      } catch {
        return { ok: true, detail: 'stored (validation skipped — Vercel unreachable)' };
      }
    },
  },
  supabase: {
    id: 'supabase',
    label: 'Supabase',
    envVar: 'SUPABASE_ACCESS_TOKEN',
    looksValid: (t) => t.trim().startsWith('sbp_') && t.trim().length >= 20,
    validate: async (token) => {
      try {
        const res = await fetch('https://api.supabase.com/v1/projects', {
          headers: { Authorization: `Bearer ${token.trim()}` },
        });
        if (res.ok) {
          const projects = (await res.json()) as unknown[];
          return { ok: true, detail: `valid — ${Array.isArray(projects) ? projects.length : '?'} project(s) visible` };
        }
        return { ok: false, detail: `Supabase rejected the token (HTTP ${res.status})` };
      } catch {
        return { ok: true, detail: 'stored (validation skipped — Supabase unreachable)' };
      }
    },
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
