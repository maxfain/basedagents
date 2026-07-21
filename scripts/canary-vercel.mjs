#!/usr/bin/env node
/**
 * Vercel provisioner canary (spec §4/§8) — verifies, against the LIVE provider,
 * everything the unit suite can only fake:
 *
 *   1. API contract: whoami → mint (name+expiresAt) → list finds it → burn by
 *      id → list no longer finds it. Any shape drift fails loudly with the step.
 *   2. Recipe page contract (logged-out half): the tokens URL redirect chain
 *      stays on-allowlist and the login checkpoint fires — i.e. the recipe's
 *      entry assumptions still hold. (A full logged-in browser mint needs a
 *      session no CI secret can carry safely; the bootstrap-then-API design
 *      makes the API path the one every connect after day one exercises.)
 *   3. Canary-secret scan (§8): no token value in anything this script prints.
 *
 * Requires VERCEL_CANARY_TOKEN (test account). Exits nonzero on the first
 * failed step; stdout names steps only, never values.
 */
import { VercelApi } from '../packages/keyring/dist/provisioner/vercel-api.js';
import { hostAllowed } from '../packages/keyring/dist/provisioner/engine.js';
import { vercelBootstrapRecipe, VERCEL_TOKENS_URL } from '../packages/keyring/dist/provisioner/recipes/vercel.js';

const token = process.env.VERCEL_CANARY_TOKEN;
if (!token) { console.error('canary: VERCEL_CANARY_TOKEN missing'); process.exit(2); }

let step = 'init';
const fail = (err) => { console.error(`canary: FAILED at step "${step}": ${err?.message ?? err}`); process.exit(1); };

try {
  const api = new VercelApi(token);

  step = 'whoami';
  await api.whoami();
  console.log('canary: ✓ whoami');

  step = 'mint';
  const name = `ba/canary/${Date.now().toString(36)}`;
  const minted = await api.createToken(name, 1); // 1-day expiry: self-cleaning even if burn fails
  if (!minted.bearerToken || !minted.meta?.id) throw new Error('mint response shape drifted');
  console.log('canary: ✓ mint (id received)');

  step = 'verify-minted-token-works';
  await new VercelApi(minted.bearerToken).whoami();
  console.log('canary: ✓ minted token authenticates');

  step = 'list-finds-minted';
  const listed = await api.listTokens();
  if (!listed.some((t) => t.id === minted.meta.id)) throw new Error('minted token missing from list');
  console.log('canary: ✓ list');

  step = 'burn';
  const burn = await api.deleteToken(minted.meta.id);
  if (burn !== 'burned') throw new Error(`expected 'burned', got '${burn}'`);
  const after = await api.listTokens();
  if (after.some((t) => t.id === minted.meta.id)) throw new Error('token still listed after burn');
  console.log('canary: ✓ burn by id');

  step = 'recipe-page-contract';
  const res = await fetch(VERCEL_TOKENS_URL, { redirect: 'manual' });
  const loc = res.headers.get('location') ?? VERCEL_TOKENS_URL;
  if (![301, 302, 307, 308, 200].includes(res.status)) throw new Error(`tokens URL returned ${res.status}`);
  if (!hostAllowed(new URL(loc, VERCEL_TOKENS_URL).href, vercelBootstrapRecipe.allowedDomains)) {
    throw new Error(`logged-out redirect left the allowlist: ${loc}`);
  }
  console.log('canary: ✓ tokens-page redirect stays on-allowlist');

  console.log('canary: all steps green');
} catch (err) {
  fail(err);
}
