#!/usr/bin/env node
/**
 * Supabase provisioner canary (spec §4/§8) — verifies, against the LIVE
 * provider, everything the unit suite can only fake:
 *
 *   1. API contract: list projects → mint a secret key (type+name) → list
 *      finds it → burn by id → list no longer finds it. Any shape drift —
 *      including the new-key name constraint — fails loudly with the step.
 *   2. Recipe page contract (logged-out half): the tokens URL redirect chain
 *      stays on-allowlist — i.e. the recipe's entry assumptions still hold.
 *      (A full logged-in browser mint needs a session no CI secret can carry
 *      safely; bootstrap-then-API makes the API path the one every connect
 *      after day one exercises.)
 *   3. Canary-secret scan (§8): no key value in anything this script prints.
 *
 * Requires SUPABASE_CANARY_TOKEN (a PAT for the test account) and a test
 * account with EXACTLY ONE project (mirrors the auto-pick default). Exits
 * nonzero on the first failed step; stdout names steps only, never values.
 */
import { SupabaseApi } from '../packages/keyring/dist/provisioner/supabase-api.js';
import { hostAllowed } from '../packages/keyring/dist/provisioner/engine.js';
import { supabaseBootstrapRecipe, SUPABASE_TOKENS_URL } from '../packages/keyring/dist/provisioner/recipes/supabase.js';

const token = process.env.SUPABASE_CANARY_TOKEN;
if (!token) { console.error('canary: SUPABASE_CANARY_TOKEN missing'); process.exit(2); }

let step = 'init';
const fail = (err) => { console.error(`canary: FAILED at step "${step}": ${err?.message ?? err}`); process.exit(1); };

try {
  const api = new SupabaseApi(token);

  step = 'list-projects';
  const projects = await api.listProjects();
  if (projects.length === 0) throw new Error('canary account has no projects — create one');
  const ref = projects[0].id;
  console.log(`canary: ✓ projects (${projects.length})`);

  step = 'mint-secret-key';
  const name = `ba_canary_${Date.now().toString(36)}`;
  const minted = await api.createSecretKey(ref, name, 'BasedAgents canary — safe to delete');
  if (!minted.id || !minted.apiKey) throw new Error('mint response shape drifted');
  if (!minted.apiKey.startsWith('sb_secret_')) throw new Error('minted key prefix drifted (expected sb_secret_)');
  console.log('canary: ✓ mint (id received, sb_secret_ prefix)');

  step = 'list-finds-minted';
  const listed = await api.listApiKeys(ref, false);
  if (!listed.some((k) => k.id === minted.id)) throw new Error('minted key missing from list');
  console.log('canary: ✓ list');

  step = 'burn';
  const burn = await api.deleteApiKey(ref, minted.id);
  if (burn !== 'burned') throw new Error(`expected 'burned', got '${burn}'`);
  const after = await api.listApiKeys(ref, false);
  if (after.some((k) => k.id === minted.id)) throw new Error('key still listed after burn');
  console.log('canary: ✓ burn by id');

  step = 'recipe-page-contract';
  const res = await fetch(SUPABASE_TOKENS_URL, { redirect: 'manual' });
  const loc = res.headers.get('location') ?? SUPABASE_TOKENS_URL;
  if (![301, 302, 307, 308, 200].includes(res.status)) throw new Error(`tokens URL returned ${res.status}`);
  if (!hostAllowed(new URL(loc, SUPABASE_TOKENS_URL).href, supabaseBootstrapRecipe.allowedDomains)) {
    throw new Error(`logged-out redirect left the allowlist: ${loc}`);
  }
  console.log('canary: ✓ tokens-page redirect stays on-allowlist');

  console.log('canary: all steps green');
} catch (err) {
  fail(err);
}
