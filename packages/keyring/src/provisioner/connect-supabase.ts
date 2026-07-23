/**
 * Supabase connect orchestration (PROVISIONER spec §1, §5) — bootstrap-then-API.
 *
 * The browser's job is bootstrap, once per account: mint ONE personal access
 * token (the provisioning credential, `sbp_…`). Everything after that is API
 * by id: mint per-agent SECRET KEYS (`sb_secret_…`, individually deletable),
 * verify, burn. Where Vercel's shape is account→tokens, Supabase's is
 * account→projects→keys, so a connect targets ONE PROJECT — auto-picked when
 * the account has exactly one, `--project <ref>` otherwise.
 *
 * Two honesty notes baked into the credential cards:
 *   - Supabase PATs and secret keys do not expire. The grant carries our own
 *     expiry leash, and the kill switch burns the key by id at the provider —
 *     but a minted key outlives its grant until burned.
 *   - Projects still on legacy JWT keys (no new-key API) degrade to the shared
 *     `service_role` key: project-wide, NOT individually revocable — the card
 *     says so, and burn reports "revoke only".
 */

import { randomBytes } from 'node:crypto';
import type { CredentialPublic, GrantConstraints } from '../types.js';
import type { RunOutcome } from './types.js';
import { runRecipe } from './engine.js';
import { supabaseBootstrapRecipe, SUPABASE_TOKENS_URL } from './recipes/supabase.js';
import { SupabaseApi, SupabaseApiError, supabaseProjectUrl } from './supabase-api.js';
import type { ConnectDeps, ConnectResult } from './connect.js';

export const SUPABASE_PROV_LABEL = 'Supabase provisioning token';
const AGENT_GRANT_EXPIRY_DAYS_DEFAULT = 30;

/** New-key names: lowercase alphanumeric + underscores (management-API constraint). */
const keySlug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'agent';

function api(deps: ConnectDeps, token: string): SupabaseApi {
  return new SupabaseApi(token, deps.fetchImpl);
}

/** Value-free description of why a captured string can't be a Supabase PAT. */
function capturedPatProblem(v: string): string | null {
  if (v.length === 0) return 'was empty';
  if (v.includes('…') || v.includes('*')) return `looks masked (${v.length} chars)`;
  if (/\s/.test(v)) return 'contains whitespace';
  if (!v.startsWith('sbp_')) return `does not start with sbp_ (${v.length} chars)`;
  if (v.length < 20) return `is too short to be a token (${v.length} chars)`;
  return null;
}

/**
 * Verify a candidate PAT, salvaging via assisted paste when it fails — the
 * dialog value is shown once and must not be thrown away. Distinguishes
 * auth-rejection (bad capture) from network failure (token likely fine).
 */
async function verifyOrSalvage(deps: ConnectDeps, candidate: string | null): Promise<string> {
  const verify = async (v: string): Promise<'ok' | 'rejected'> => {
    try {
      await api(deps, v).listProjects();
      return 'ok';
    } catch (err) {
      if (err instanceof SupabaseApiError && (err.status === 401 || err.status === 403)) return 'rejected';
      throw new Error(
        `Could not reach the Supabase API to verify the token (${(err as Error).message}). ` +
        'The token in the browser dialog is still valid — check your network and run connect again.'
      );
    }
  };

  if (candidate && (await verify(candidate)) === 'ok') return candidate;
  if (candidate) deps.hooks.info(`The captured value did not authenticate (${candidate.length} chars) — falling back to paste.`);

  for (let attempt = 0; attempt < 2; attempt++) {
    const pasted = (await deps.pasteFallback(
      'Copy the token shown in the browser window (sbp_…) and paste it here — it goes straight into your vault.'
    ))?.trim();
    if (!pasted) throw new Error('Connect cancelled during assisted paste — nothing was saved.');
    if ((await verify(pasted)) === 'ok') return pasted;
    deps.hooks.info('That value did not authenticate either — one more try.');
  }
  throw new Error('The pasted value was rejected by Supabase — nothing was saved. Run connect again.');
}

/** Drive the browser recipe to mint the PAT and return its verified value. */
async function browserMintPat(deps: ConnectDeps, tokenName: string): Promise<{
  value: string;
  transcript: Array<{ step: string; result: string }>;
}> {
  const outcome: RunOutcome = await runRecipe(
    supabaseBootstrapRecipe,
    deps.launchDriver, // engine launches AFTER consent (§3)
    deps.hooks,
    { token_name: tokenName },
    [
      `Keyring then creates a Supabase access token FOR you — named ${tokenName}. Nothing for you to click.`,
      'That token can mint per-project keys, so future connects need no browser at all.',
    ],
  );

  let value: string | null = null;
  let transcript: Array<{ step: string; result: string }> = [];
  if (outcome.status === 'completed') {
    const captured = (outcome.captured.get('token_value') ?? '').trim();
    transcript = outcome.transcript;
    const problem = capturedPatProblem(captured);
    if (problem) {
      deps.hooks.info(`The value I grabbed from the page ${problem} — falling back to paste.`);
    } else {
      value = captured;
    }
  } else if (outcome.status === 'fallback_paste') {
    transcript = [...outcome.transcript, { step: outcome.atStep, result: 'manual' }];
  } else {
    throw new Error(`Connect stopped: ${outcome.reason}`);
  }

  return { value: await verifyOrSalvage(deps, value), transcript };
}

/** A valid provisioning PAT, bootstrapping via the browser if needed. */
async function ensureProvisioner(deps: ConnectDeps): Promise<{ value: string; browserRan: boolean }> {
  const { kr, owner, hooks } = deps;

  const existing = kr.findProvisioner('supabase');
  if (existing) {
    const value = kr.provisionerValue(owner, existing.credential_id);
    try {
      await api(deps, value).listProjects();
      return { value, browserRan: false };
    } catch (err) {
      if (!(err instanceof SupabaseApiError) || (err.status !== 401 && err.status !== 403)) throw err;
      hooks.info('The stored provisioning token was rejected by Supabase — re-running the one-time browser setup.');
      await kr.removeCredential(owner, existing.credential_id);
    }
  }

  // ── Bootstrap (browser, once per account) ──
  const tokenName = `ba/provisioning/${randomBytes(4).toString('hex')}`;
  const { value, transcript } = await browserMintPat(deps, tokenName);

  const credential = await kr.addCredential(owner, {
    label: SUPABASE_PROV_LABEL,
    provider: 'supabase',
    provisioner: true,
    scope: 'account (provisioning — can mint per-project Supabase keys)',
    // Supabase PATs carry NO provider-side id or expiry; the management API
    // cannot list or delete them, so rotation and burn are dashboard actions.
    rotation_policy: `manual — Supabase access tokens do not expire; revoke at ${SUPABASE_TOKENS_URL}`,
  }, value);

  await kr.recordProvisioner(owner, 'provisioner_bootstrap', {
    credentialId: credential.credential_id,
    context: 'connect supabase',
    detail: { recipe: supabaseBootstrapRecipe.id, recipe_version: supabaseBootstrapRecipe.version, token_name: tokenName, transcript },
  });

  return { value, browserRan: true };
}

/** Resolve the target project: --project wins; else exactly-one auto-picks. */
async function resolveProject(
  deps: ConnectDeps,
  provValue: string,
  requested: string | undefined,
): Promise<{ ref: string; name: string }> {
  const projects = await api(deps, provValue).listProjects();
  if (requested) {
    const hit = projects.find((p) => p.id === requested || p.name === requested);
    if (!hit) {
      const roster = projects.map((p) => `${p.id} (${p.name})`).join(', ') || '(none)';
      throw new Error(`No Supabase project "${requested}" in this account. Projects: ${roster}.`);
    }
    return { ref: hit.id, name: hit.name };
  }
  if (projects.length === 1) return { ref: projects[0].id, name: projects[0].name };
  if (projects.length === 0) {
    throw new Error('This Supabase account has no projects yet — create one at supabase.com/dashboard first.');
  }
  const roster = projects.map((p) => `${p.id} (${p.name})`).join(', ');
  throw new Error(`This account has ${projects.length} Supabase projects — pick one with --project <ref>. Projects: ${roster}.`);
}

/**
 * The whole §5 flow: ensure provisioner (browser at most once) → API-mint a
 * per-agent secret key for the project → grant. Legacy-key projects degrade
 * to the shared service_role key with the honesty recorded on the card.
 */
export async function connectSupabase(
  deps: ConnectDeps,
  opts: { agentRef: string; agentName?: string; expiryDays?: number; projectRef?: string },
): Promise<ConnectResult & { projectRef: string; projectUrl: string }> {
  const { kr, owner } = deps;
  const days = opts.expiryDays ?? AGENT_GRANT_EXPIRY_DAYS_DEFAULT;

  // Validate the grantee BEFORE any minting: a provider-side key is an
  // external side effect, and an unknown identity must fail here — not after
  // a key already exists at Supabase (vercel field lesson).
  const agentId = kr.resolveAgent(kr.vault(), opts.agentRef);

  const prov = await ensureProvisioner(deps);
  const project = await resolveProject(deps, prov.value, opts.projectRef);
  const projectUrl = supabaseProjectUrl(project.ref);

  const keyName = `ba_${keySlug(opts.agentName ?? opts.agentRef)}_${randomBytes(4).toString('hex')}`;
  deps.hooks.info(`Minting secret key ${keyName} for project ${project.ref} via the Supabase API…`);

  // The mint ladder: new-style secret key (per-agent, burnable by id) → the
  // legacy shared service_role key (reveal), scope honesty on the card.
  let secretValue: string;
  let providerKeyId: string | undefined;
  let envVar: string;
  let scope: string;
  try {
    const minted = await api(deps, prov.value).createSecretKey(
      project.ref, keyName, `BasedAgents Keyring key for ${opts.agentName ?? opts.agentRef}`,
    );
    secretValue = minted.apiKey;
    providerKeyId = minted.id;
    envVar = 'SUPABASE_SECRET_KEY';
    scope = `project ${project.ref} (${projectUrl}) — secret key, burnable by id`;
  } catch (err) {
    if (!(err instanceof SupabaseApiError) || err.status < 400 || err.status >= 500) throw err;
    deps.hooks.info('This project cannot mint new-style keys — falling back to its service_role key (shared, not individually revocable).');
    const keys = await api(deps, prov.value).listApiKeys(project.ref, true);
    const serviceRole = keys.find((k) => k.name === 'service_role' && k.api_key);
    if (!serviceRole?.api_key) {
      throw new Error(`Supabase would not mint a key for project ${project.ref} and no service_role key was readable — nothing was saved. (${(err as Error).message})`);
    }
    secretValue = serviceRole.api_key;
    providerKeyId = undefined; // legacy JWTs cannot be burned individually
    envVar = 'SUPABASE_SERVICE_ROLE_KEY';
    scope = `project ${project.ref} (${projectUrl}) — LEGACY service_role: shared, revoke = rotate in the dashboard`;
  }

  const expiresAtIso = new Date(Date.now() + days * 86_400_000).toISOString();

  let credential: CredentialPublic | undefined;
  let grant;
  try {
    credential = await kr.addCredential(owner, {
      label: `Supabase key (${opts.agentName ?? opts.agentRef} · ${project.name || project.ref})`,
      provider: 'supabase',
      env_var: envVar,
      scope,
      provider_key_id: providerKeyId,
      // provider_team doubles as the provider-side container (Vercel: teamId;
      // Supabase: project ref) — burn needs it to address the key.
      provider_team: project.ref,
    }, secretValue);

    // Supabase keys never expire provider-side; the grant is OUR leash.
    const constraints: GrantConstraints = { expires_at: expiresAtIso };
    grant = await kr.createGrant(owner, credential.credential_id, agentId, constraints);
  } catch (err) {
    // Compensating rollback: a minted provider-side key must not outlive a
    // failed vault write — burn it and drop the half-written credential.
    try { if (credential) await kr.removeCredential(owner, credential.credential_id); } catch { /* best effort */ }
    try { if (providerKeyId) await api(deps, prov.value).deleteApiKey(project.ref, providerKeyId); } catch { /* best effort */ }
    throw err;
  }

  await kr.recordProvisioner(owner, 'provisioner_mint', {
    credentialId: credential.credential_id,
    context: `connect supabase for ${opts.agentRef}`,
    detail: {
      key_id: providerKeyId ?? null,
      key_name: keyName,
      project_ref: project.ref,
      scope,
      grant_expires_at: expiresAtIso,
      grant_id: grant.grant_id,
      browser_ran: prov.browserRan,
    },
  });

  return {
    credential,
    grantId: grant.grant_id,
    agentId: grant.agent_id,
    tokenName: keyName,
    scope,
    expiresAt: expiresAtIso,
    browserRan: prov.browserRan,
    projectRef: project.ref,
    projectUrl,
  };
}

/**
 * Kill-switch integration (§6): burn every minted Supabase key an agent holds,
 * by id, via the provisioning credential. Legacy service_role credentials have
 * no id — those report "revoke only" with the dashboard pointer.
 */
export async function burnSupabaseKeysForAgent(
  deps: Pick<ConnectDeps, 'kr' | 'owner' | 'fetchImpl'>,
  credentialIds: string[],
): Promise<Array<{ credential_id: string; label: string; result: string }>> {
  const { kr, owner } = deps;
  const prov = kr.findProvisioner('supabase');
  const results: Array<{ credential_id: string; label: string; result: string }> = [];
  const all = kr.credentialsView();

  for (const id of credentialIds) {
    const cred = all.find((c) => c.credential_id === id);
    if (!cred || cred.provider !== 'supabase' || cred.provisioner) continue;
    if (!cred.provider_key_id || !cred.provider_team) {
      results.push({ credential_id: id, label: cred.label, result: 'no provider id — revoke only (rotate the key in the Supabase dashboard)' });
      continue;
    }
    if (!prov) {
      results.push({ credential_id: id, label: cred.label, result: 'no provisioning token — revoke only (delete the key in the Supabase dashboard)' });
      continue;
    }
    try {
      const value = kr.provisionerValue(owner, prov.credential_id);
      const status = await new SupabaseApi(value, deps.fetchImpl).deleteApiKey(cred.provider_team, cred.provider_key_id);
      results.push({ credential_id: id, label: cred.label, result: status });
      await kr.recordProvisioner(owner, 'provisioner_burn', {
        credentialId: id,
        context: 'kill switch',
        detail: { key_id: cred.provider_key_id, project_ref: cred.provider_team, status },
      });
    } catch (err) {
      results.push({ credential_id: id, label: cred.label, result: `burn failed: ${(err as Error).message}` });
    }
  }
  return results;
}
