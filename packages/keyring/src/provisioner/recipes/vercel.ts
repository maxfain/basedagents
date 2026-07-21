/**
 * Vercel bootstrap recipe (PROVISIONER spec §5) — mints ONE classic
 * account-scope token: the provisioning credential. Agent tokens are never
 * minted here; they come from the API afterwards (§1 bootstrap-then-API).
 *
 * Recipes are data. Selector strategy (§4): accessibility roles + visible
 * labels first, CSS fallbacks second, checkpoint handoff as the safety net —
 * so UI drift degrades to "click it yourself", never to a crash. Drift is
 * caught by the weekly canary, not by users.
 *
 * URL facts verified against production (2026-07): /account/settings/tokens is
 * canonical (/account/tokens 308s to it); logged-out hits bounce through
 * /auth-redirect/…, which the login checkpoint absorbs.
 */

import type { Recipe } from '../types.js';

export const VERCEL_TOKENS_URL = 'https://vercel.com/account/settings/tokens';

export const vercelBootstrapRecipe: Recipe = {
  id: 'vercel-bootstrap',
  // v2 (field-tested 2026-07 against the live form): the Create Token form has
  // a REQUIRED Scope dropdown v1 missed, and the expiration control's visible
  // text is "Select Date", not "Expiration".
  version: 2,
  provider: 'vercel',
  allowedDomains: ['vercel.com'],
  login: {
    url: VERCEL_TOKENS_URL,
    // The tokens page shows its Create button only with a live session; a
    // logged-out visit lands on the login/auth-redirect flow where it's absent.
    loggedInProbe: { role: 'button', name: 'Create', description: 'the Create button on the Tokens page' },
    loggedOutHint:
      'Log in to Vercel in the open window (any method — email, GitHub, SSO). ' +
      'Nothing is watched or recorded while you do; press Continue when you are on the Tokens page.',
  },
  steps: [
    { id: 'open-tokens', kind: 'goto', url: VERCEL_TOKENS_URL },
    {
      id: 'open-create',
      kind: 'click',
      target: { role: 'button', name: 'Create', description: 'the Create button' },
      fallbacks: [{ css: 'button[type="submit"]', description: 'the Create button (fallback)' }],
    },
    {
      id: 'fill-name',
      kind: 'fill',
      target: { role: 'textbox', name: 'Token name', description: 'the token name field' },
      fallbacks: [
        { css: 'input[name="tokenName"]', description: 'the token name field (fallback)' },
        { css: 'form input[type="text"]', description: 'the token name field (fallback 2)' },
      ],
      param: 'token_name',
    },
    {
      // The live form REQUIRES a scope. The first option in the list is the
      // personal account (what provisioning needs); teams come after.
      id: 'open-scope',
      kind: 'click',
      target: { role: 'combobox', name: 'Scope', description: 'the Scope dropdown' },
      fallbacks: [{ css: 'text=Select scope', description: 'the Scope dropdown (fallback)' }],
    },
    {
      id: 'pick-scope',
      kind: 'click',
      target: {
        css: '[role="option"]',
        description: 'your personal account in the Scope list (the first option — pick your account, not a team)',
      },
    },
    {
      id: 'open-expiration',
      kind: 'click',
      target: { role: 'combobox', name: 'Expiration', description: 'the Expiration dropdown' },
      fallbacks: [
        { css: 'text=Select Date', description: 'the Expiration dropdown (fallback — its visible text)' },
        { css: 'select[name="expiry"]', description: 'the Expiration dropdown (fallback 2)' },
      ],
    },
    {
      id: 'pick-expiration',
      kind: 'click',
      target: { role: 'option', name: '90 days', description: 'the "90 days" expiration option' },
      fallbacks: [
        { css: 'text=/^90 ?days?$/i', description: 'the "90 days" option (fallback)' },
        { role: 'menuitem', name: '90 days', description: 'the "90 days" option (fallback 2)' },
      ],
    },
    {
      id: 'submit',
      kind: 'click',
      target: { role: 'button', name: 'Create Token', description: 'the Create Token submit button' },
      fallbacks: [{ role: 'button', name: 'Create', description: 'the submit button (fallback)' }],
    },
    {
      // The one-time value shown in the success dialog, straight DOM → vault.
      id: 'capture-token',
      kind: 'capture',
      target: { css: 'input[readonly]', description: 'the new token value in the dialog' },
      fallbacks: [
        { css: 'code', description: 'the new token value (fallback)' },
        { role: 'textbox', description: 'the new token value (fallback 2)' },
      ],
      secretKey: 'token_value',
      timeoutMs: 15_000,
    },
  ],
};
