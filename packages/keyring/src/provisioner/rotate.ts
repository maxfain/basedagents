/**
 * Key rotation (PROVISIONER spec §1 "mint / verify / rotate / burn") — the
 * API-only half of the provisioner: mint a fresh provider-side key, swap the
 * vault secret (updateCredentialSecret re-seals to the owner AND every active
 * grantee, so agents pick up the new value on their next lease), then burn
 * the old key by id. No browser, ever: rotation runs on the provisioning
 * credential, so if that is missing or rejected the answer is "run
 * `based connect <provider>` first", not a window.
 *
 * Order matters and is deliberate: mint → swap → burn. A failure after mint
 * leaves TWO working keys (annoying, visible, self-healing on retry); burning
 * before the swap could leave ZERO (an outage). The old key is only destroyed
 * once the vault holds the new one.
 *
 * Honesty: only MINTED keys rotate (they carry a provider_key_id). Pasted
 * tokens and legacy Supabase service_role keys get a plain-words refusal that
 * names the manual path — never a silent no-op.
 */

import { randomBytes } from 'node:crypto';
import type { Keyring } from '../keyring.js';
import type { AgentKeypair } from '../crypto.js';
import { VercelApi, scopeSlugFrom403 } from './vercel-api.js';
import { SupabaseApi } from './supabase-api.js';

export interface RotateDeps {
  kr: Keyring;
  owner: AgentKeypair;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  info?: (message: string) => void;
}

export interface RotateResult {
  credentialId: string;
  provider: string;
  oldProviderKeyId: string;
  newProviderKeyId: string;
  /** Provider-side expiry of the NEW key (Vercel only; Supabase keys never expire). */
  expiresAt?: string;
}

const VERCEL_ROTATED_EXPIRY_DAYS = 30;

const hex8 = (): string => randomBytes(4).toString('hex');

/** Rotate one minted provider key in place. Throws with a plain-words reason when it cannot. */
export async function rotateProviderCredential(deps: RotateDeps, credentialRef: string): Promise<RotateResult> {
  const { kr, owner } = deps;
  const info = deps.info ?? (() => {});

  const cred = kr.credentialsView().find(
    (c) => c.credential_id === credentialRef || c.label === credentialRef || c.env_var === credentialRef,
  );
  if (!cred) throw new Error(`No credential "${credentialRef}" in this vault.`);
  if (cred.provisioner) {
    throw new Error('That is the provisioning token itself — reconnecting rotates it (`based connect <provider>`), and Supabase PATs rotate in the dashboard.');
  }
  if (cred.provider !== 'vercel' && cred.provider !== 'supabase') {
    throw new Error(`"${cred.label}" was pasted by hand (${cred.provider ?? 'no provider'}) — rotate it at the provider, then run \`based update-secret ${cred.credential_id}\` with the new value.`);
  }
  if (!cred.provider_key_id) {
    throw new Error(
      cred.provider === 'supabase'
        ? `"${cred.label}" is the shared legacy service_role key — rotate it in the Supabase dashboard (Project → Settings → API), then \`based update-secret ${cred.credential_id}\`. Re-running \`based connect supabase\` upgrades it to a per-agent key that CAN rotate here.`
        : `"${cred.label}" was not minted by Keyring (no provider-side id) — rotate it at the provider, then \`based update-secret ${cred.credential_id}\`.`,
    );
  }

  const prov = kr.findProvisioner(cred.provider);
  if (!prov) {
    throw new Error(`No ${cred.provider} provisioning token in this vault — run \`based connect ${cred.provider}\` once to set it up.`);
  }
  const provValue = kr.provisionerValue(owner, prov.credential_id);
  const oldKeyId = cred.provider_key_id;

  let newSecret: string;
  let newKeyId: string;
  let expiresAt: string | undefined;

  if (cred.provider === 'vercel') {
    const name = `ba/rotated/${hex8()}`;
    info(`Minting replacement Vercel token ${name}…`);
    const client = new VercelApi(provValue, deps.fetchImpl, prov.provider_team);
    let minted;
    try {
      minted = await client.createToken(name, VERCEL_ROTATED_EXPIRY_DAYS);
    } catch (err) {
      // Team-scoped provisioning tokens name their scope in the refusal.
      const slug = scopeSlugFrom403(err);
      if (!slug || slug === prov.provider_team) throw err;
      minted = await new VercelApi(provValue, deps.fetchImpl, slug).createToken(name, VERCEL_ROTATED_EXPIRY_DAYS);
    }
    // Verify before swapping — a bad mint must never replace a working secret.
    await new VercelApi(minted.bearerToken, deps.fetchImpl).whoami();
    newSecret = minted.bearerToken;
    newKeyId = minted.meta.id;
    expiresAt = minted.meta.expiresAt ? new Date(minted.meta.expiresAt).toISOString() : undefined;
  } else {
    const projectRef = cred.provider_team;
    if (!projectRef) {
      throw new Error(`"${cred.label}" has no project ref recorded — re-run \`based connect supabase\` to replace it.`);
    }
    const name = `ba_rotated_${hex8()}`;
    info(`Minting replacement Supabase key ${name} for project ${projectRef}…`);
    // The mint response is authoritative — a project secret key cannot call
    // the management API, so there is no cheap out-of-band verify here.
    const minted = await new SupabaseApi(provValue, deps.fetchImpl).createSecretKey(
      projectRef, name, `BasedAgents Keyring rotation of ${cred.label}`,
    );
    newSecret = minted.apiKey;
    newKeyId = minted.id;
  }

  // Swap: re-seals to owner + every active grantee in one locked write.
  await kr.updateCredentialSecret(owner, cred.credential_id, newSecret);
  await kr.updateCredentialMeta(owner, cred.credential_id, {
    provider_key_id: newKeyId,
    provider_expires_at: expiresAt,
  });

  // Burn the old key LAST — the vault already holds the working replacement.
  let oldBurn: string;
  try {
    oldBurn = cred.provider === 'vercel'
      ? await new VercelApi(provValue, deps.fetchImpl, prov.provider_team).deleteToken(oldKeyId)
      : await new SupabaseApi(provValue, deps.fetchImpl).deleteApiKey(cred.provider_team as string, oldKeyId);
  } catch (err) {
    oldBurn = `burn failed: ${(err as Error).message}`;
    info(`The old key could not be destroyed at ${cred.provider} (${oldBurn}) — the vault already uses the new one; delete the old key in the provider dashboard.`);
  }

  await kr.recordProvisioner(owner, 'provisioner_rotate', {
    credentialId: cred.credential_id,
    context: `rotate ${cred.provider} key`,
    detail: { old_key_id: oldKeyId, new_key_id: newKeyId, old_burn: oldBurn, expires_at: expiresAt ?? null },
  });

  info(`Rotated ${cred.label}: new key active, old key ${oldBurn === 'burned' || oldBurn === 'already_gone' ? 'destroyed' : oldBurn}.`);
  return { credentialId: cred.credential_id, provider: cred.provider, oldProviderKeyId: oldKeyId, newProviderKeyId: newKeyId, expiresAt };
}
