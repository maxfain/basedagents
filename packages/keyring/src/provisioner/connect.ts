/**
 * Vercel connect orchestration (PROVISIONER spec §1, §5) — bootstrap-then-API.
 *
 * The browser's job is bootstrap, once per account: mint ONE classic
 * account-scope token (the provisioning credential, `prov_vercel`). Everything
 * after that is API by id: mint agent tokens, verify, rotate, burn. The browser
 * runs again only if the provisioning credential is burned, expired, or
 * rejected. First-connect runs both halves back-to-back, so day one ends with
 * the correct two-tier structure and the dashboard driven exactly once.
 */

import { randomBytes } from 'node:crypto';
import type { Keyring } from '../keyring.js';
import type { AgentKeypair } from '../crypto.js';
import type { CredentialPublic, GrantConstraints } from '../types.js';
import type { Driver, EngineHooks, RunOutcome } from './types.js';
import { runRecipe } from './engine.js';
import { vercelBootstrapRecipe } from './recipes/vercel.js';
import { VercelApi, VercelApiError } from './vercel-api.js';

export const PROV_LABEL = 'Vercel provisioning token';
const PROV_EXPIRY_DAYS = 90;
/** Auto-rotate the provisioning credential when this close to expiry (§1). */
const PROV_ROTATE_WINDOW_DAYS = 14;
const AGENT_TOKEN_EXPIRY_DAYS_DEFAULT = 30;

/**
 * Honest blast radius for API-minted agent tokens. The create endpoint's strict
 * schema (verified live: only {name, expiresAt} accepted) cannot mint team- or
 * project-scoped tokens — when Vercel's API grows narrower scopes, prefer them
 * here (§1: project > team > account) and update this string.
 */
export const VERCEL_AGENT_TOKEN_SCOPE = 'account-wide (Vercel classic — narrowest the token API can mint today)';

export interface ConnectDeps {
  kr: Keyring;
  owner: AgentKeypair;
  hooks: EngineHooks;
  /** Launches the real browser. Injected so tests never need a display. */
  launchDriver: () => Promise<Driver>;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /**
   * §4 assisted-paste degradation: called when the capture step failed but the
   * value is visible on the user's screen. Returns the pasted value (hidden
   * input in the CLI), or null to abort.
   */
  pasteFallback: (message: string) => Promise<string | null>;
}

export interface ConnectResult {
  credential: CredentialPublic;
  grantId: string;
  agentId: string;
  tokenName: string;
  scope: string;
  expiresAt: string;
  /** True when this run had to drive the browser (bootstrap). */
  browserRan: boolean;
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'agent';

function api(deps: ConnectDeps, token: string): VercelApi {
  return new VercelApi(token, deps.fetchImpl);
}

/** A valid provisioning token value, bootstrapping via the browser if needed. */
async function ensureProvisioner(deps: ConnectDeps): Promise<{ value: string; browserRan: boolean }> {
  const { kr, owner, hooks } = deps;

  const existing = kr.findProvisioner('vercel');
  if (existing) {
    const value = kr.provisionerValue(owner, existing.credential_id);
    try {
      await api(deps, value).whoami();
      const rotated = await maybeRotateProvisioner(deps, existing, value);
      return { value: rotated ?? value, browserRan: false };
    } catch (err) {
      if (!(err instanceof VercelApiError) || (err.status !== 401 && err.status !== 403)) throw err;
      hooks.info('The stored provisioning token was rejected by Vercel — re-running the one-time browser setup.');
      await kr.removeCredential(owner, existing.credential_id);
    }
  }

  // ── Bootstrap (browser, once per account) ──
  const tokenName = `ba/provisioning/${randomBytes(4).toString('hex')}`;
  const outcome: RunOutcome = await runRecipe(
    vercelBootstrapRecipe,
    deps.launchDriver, // engine launches AFTER consent (§3)
    hooks,
    { token_name: tokenName },
    [
      `Keyring then creates a Vercel token FOR you — named ${tokenName}, expiring in ${PROV_EXPIRY_DAYS} days. Nothing for you to click.`,
      'That token can mint other tokens, so future connects need no browser at all.',
    ]
  );

  let value: string | null = null;
  let transcript: Array<{ step: string; result: string }> = [];
  if (outcome.status === 'completed') {
    const captured = (outcome.captured.get('token_value') ?? '').trim();
    transcript = outcome.transcript;
    // DOM capture can grab a masked display ("vc_ab…"), a copy-button label, or
    // the wrong readonly input entirely — sanity-check the SHAPE before trusting
    // it, and report only value-free diagnostics (length / masking), never the
    // string itself.
    const problem = capturedShapeProblem(captured);
    if (problem) {
      hooks.info(`The value I grabbed from the page ${problem} — falling back to paste.`);
    } else {
      value = captured;
    }
  } else if (outcome.status === 'fallback_paste') {
    transcript = [...outcome.transcript, { step: outcome.atStep, result: 'manual' }];
  } else {
    throw new Error(`Connect stopped: ${outcome.reason}`);
  }

  // §5 step 6 — verify immediately; a bad capture must not be enshrined. The
  // token on the user's screen is shown ONCE, so a failed capture/verify must
  // degrade to paste — never discard a valid visible token.
  value = await verifyOrSalvage(deps, value);

  // Find the provider-side id so burn/rotate work by id.
  const client = api(deps, value);
  const tokens = await client.listTokens();
  const meta = tokens.find((t) => t.name === tokenName);

  const credential = await kr.addCredential(deps.owner, {
    label: PROV_LABEL,
    provider: 'vercel',
    provisioner: true,
    scope: 'account (provisioning — can mint Vercel tokens)',
    provider_key_id: meta?.id,
    provider_expires_at: meta?.expiresAt ? new Date(meta.expiresAt).toISOString() : undefined,
    rotation_policy: `auto-rotate ${PROV_ROTATE_WINDOW_DAYS}d before expiry`,
  }, value);

  await kr.recordProvisioner(deps.owner, 'provisioner_bootstrap', {
    credentialId: credential.credential_id,
    context: 'connect vercel',
    detail: { recipe: vercelBootstrapRecipe.id, recipe_version: vercelBootstrapRecipe.version, token_name: tokenName, transcript },
  });

  // Earlier failed bootstrap attempts each left an orphaned ba/provisioning/*
  // token at the provider. Now that a working one exists, sweep the strays —
  // name-prefixed only, never the current token, never anything user-made.
  try {
    const strays = tokens.filter((t) => t.name.startsWith('ba/provisioning/') && t.name !== tokenName);
    for (const stray of strays) await client.deleteToken(stray.id);
    if (strays.length > 0) hooks.info(`Cleaned up ${strays.length} stray provisioning token(s) from earlier attempts.`);
  } catch { /* cosmetic cleanup — never fail the connect over it */ }

  return { value, browserRan: true };
}

/** Value-free description of why a captured string can't be a real token. */
function capturedShapeProblem(v: string): string | null {
  if (v.length === 0) return 'was empty';
  if (v.includes('…') || v.includes('*')) return `looks masked (${v.length} chars)`;
  if (/\s/.test(v)) return 'contains whitespace';
  if (v.length < 20) return `is too short to be a token (${v.length} chars)`;
  return null;
}

/**
 * Verify a candidate token, salvaging via assisted paste when it fails — the
 * dialog value is shown once and must not be thrown away. Distinguishes
 * auth-rejection (bad capture) from network failure (token likely fine).
 */
async function verifyOrSalvage(deps: ConnectDeps, candidate: string | null): Promise<string> {
  const verify = async (v: string): Promise<'ok' | 'rejected'> => {
    try {
      await api(deps, v).whoami();
      return 'ok';
    } catch (err) {
      if (err instanceof VercelApiError && (err.status === 401 || err.status === 403)) return 'rejected';
      throw new Error(
        `Could not reach the Vercel API to verify the token (${(err as Error).message}). ` +
        'The token in the browser dialog is still valid — check your network and run connect again.'
      );
    }
  };

  if (candidate && (await verify(candidate)) === 'ok') return candidate;
  if (candidate) deps.hooks.info(`The captured value did not authenticate (${candidate.length} chars) — falling back to paste.`);

  for (let attempt = 0; attempt < 2; attempt++) {
    const pasted = (await deps.pasteFallback(
      'Copy the token shown in the browser window and paste it here — it goes straight into your vault.'
    ))?.trim();
    if (!pasted) throw new Error('Connect cancelled during assisted paste — nothing was saved.');
    if ((await verify(pasted)) === 'ok') return pasted;
    deps.hooks.info('That value did not authenticate either — one more try.');
  }
  throw new Error('The pasted value was rejected by Vercel — nothing was saved. Run connect again.');
}

/** §1: rotating the provisioning credential with itself — one mint + one burn. */
async function maybeRotateProvisioner(
  deps: ConnectDeps,
  existing: CredentialPublic,
  value: string
): Promise<string | null> {
  if (!existing.provider_expires_at) return null;
  const msLeft = Date.parse(existing.provider_expires_at) - Date.now();
  if (msLeft > PROV_ROTATE_WINDOW_DAYS * 24 * 60 * 60 * 1000) return null;

  deps.hooks.info('Provisioning token nears expiry — rotating it via the API (no browser needed).');
  const client = api(deps, value);
  const tokenName = `ba/provisioning/${randomBytes(4).toString('hex')}`;
  const minted = await client.createToken(tokenName, PROV_EXPIRY_DAYS);
  await api(deps, minted.bearerToken).whoami(); // verify before swapping
  await deps.kr.updateCredentialSecret(deps.owner, existing.credential_id, minted.bearerToken);
  await deps.kr.updateCredentialMeta(deps.owner, existing.credential_id, {
    provider_key_id: minted.meta.id,
    provider_expires_at: minted.meta.expiresAt ? new Date(minted.meta.expiresAt).toISOString() : undefined,
  });
  const oldBurn = existing.provider_key_id ? await client.deleteToken(existing.provider_key_id) : 'already_gone';
  await deps.kr.recordProvisioner(deps.owner, 'provisioner_rotate', {
    credentialId: existing.credential_id,
    context: 'auto-rotate before expiry',
    detail: { new_token_id: minted.meta.id, old_token_id: existing.provider_key_id ?? null, old_burn: oldBurn },
  });
  return minted.bearerToken;
}

/** The whole §5 flow: ensure provisioner (browser at most once) → API-mint an agent token → grant. */
export async function connectVercel(
  deps: ConnectDeps,
  opts: { agentRef: string; agentName?: string; expiryDays?: number }
): Promise<ConnectResult> {
  const { kr, owner } = deps;
  const days = opts.expiryDays ?? AGENT_TOKEN_EXPIRY_DAYS_DEFAULT;
  const { value: provValue, browserRan } = await ensureProvisioner(deps);

  const grant8 = randomBytes(4).toString('hex');
  const tokenName = `ba/${slug(opts.agentName ?? opts.agentRef)}/${grant8}`;
  deps.hooks.info(`Minting ${tokenName} via the Vercel API (${days}-day expiry)…`);
  const minted = await api(deps, provValue).createToken(tokenName, days);
  const expiresAtIso = new Date(minted.meta.expiresAt ?? Date.now() + days * 86_400_000).toISOString();

  const credential = await kr.addCredential(owner, {
    label: `Vercel token (${opts.agentName ?? opts.agentRef})`,
    provider: 'vercel',
    env_var: 'VERCEL_TOKEN',
    scope: VERCEL_AGENT_TOKEN_SCOPE,
    provider_key_id: minted.meta.id,
    provider_expires_at: expiresAtIso,
  }, minted.bearerToken);

  const constraints: GrantConstraints = { expires_at: expiresAtIso };
  const grant = await kr.createGrant(owner, credential.credential_id, opts.agentRef, constraints);

  await kr.recordProvisioner(owner, 'provisioner_mint', {
    credentialId: credential.credential_id,
    context: `connect vercel for ${opts.agentRef}`,
    detail: {
      token_id: minted.meta.id,
      token_name: tokenName,
      scope: VERCEL_AGENT_TOKEN_SCOPE,
      expires_at: expiresAtIso,
      grant_id: grant.grant_id,
      browser_ran: browserRan,
    },
  });

  return {
    credential,
    grantId: grant.grant_id,
    agentId: grant.agent_id,
    tokenName,
    scope: VERCEL_AGENT_TOKEN_SCOPE,
    expiresAt: expiresAtIso,
    browserRan,
  };
}

/**
 * Kill-switch integration (§6): burn every Vercel token an agent holds, by
 * provider id, via the provisioning credential. Returns per-token status.
 */
export async function burnVercelTokensForAgent(
  deps: Pick<ConnectDeps, 'kr' | 'owner' | 'fetchImpl'>,
  credentialIds: string[]
): Promise<Array<{ credential_id: string; label: string; result: string }>> {
  const { kr, owner } = deps;
  const prov = kr.findProvisioner('vercel');
  const results: Array<{ credential_id: string; label: string; result: string }> = [];
  const all = kr.credentialsView();

  for (const id of credentialIds) {
    const cred = all.find((c) => c.credential_id === id);
    if (!cred || cred.provider !== 'vercel' || cred.provisioner) continue;
    if (!cred.provider_key_id) {
      results.push({ credential_id: id, label: cred.label, result: 'no provider id — revoke only (burn it in the Vercel dashboard)' });
      continue;
    }
    if (!prov) {
      results.push({ credential_id: id, label: cred.label, result: 'no provisioning token — revoke only (burn it in the Vercel dashboard)' });
      continue;
    }
    try {
      const value = kr.provisionerValue(owner, prov.credential_id);
      const status = await new VercelApi(value, deps.fetchImpl).deleteToken(cred.provider_key_id);
      results.push({ credential_id: id, label: cred.label, result: status });
      await kr.recordProvisioner(owner, 'provisioner_burn', {
        credentialId: id,
        context: 'kill switch',
        detail: { token_id: cred.provider_key_id, status },
      });
    } catch (err) {
      results.push({ credential_id: id, label: cred.label, result: `burn failed: ${(err as Error).message}` });
    }
  }
  return results;
}
