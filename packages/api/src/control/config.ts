/**
 * RP (Relying Party) configuration for the Keyring control plane.
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * CONTROL_PLANE.md §7: the WebAuthn RP ID is the registrable domain
 * `basedagents.ai` so passkeys registered on `app.basedagents.ai` keep working
 * across console subdomains; assertions verify `origin` against an allow-list.
 *
 * Read straight from the Worker `env` WITHOUT widening the open Bindings type —
 * we treat env as an opaque string map so control-plane-only vars
 * (KEYRING_RP_ID, KEYRING_ORIGINS) never leak into src/types.
 */

const DEFAULT_RP_ID = 'basedagents.ai';
const DEFAULT_ORIGINS = 'https://app.basedagents.ai,http://localhost:5173';
const RP_NAME = 'BasedAgents Keyring';

export interface RpConfig {
  rpId: string;
  rpName: string;
  origins: string[];
}

/**
 * Resolve the RP config from the Worker env. `env` is intentionally typed
 * `unknown` so no control-plane-only binding is added to the shared Bindings.
 */
export function rpConfig(env: unknown): RpConfig {
  const e = (env ?? {}) as Record<string, string | undefined>;
  const rpId = e.KEYRING_RP_ID || DEFAULT_RP_ID;
  const originsRaw = e.KEYRING_ORIGINS || DEFAULT_ORIGINS;
  const origins = originsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { rpId, rpName: RP_NAME, origins };
}
