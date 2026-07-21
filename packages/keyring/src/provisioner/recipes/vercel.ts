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
  // v4 (field-tested 2026-07, three live runs): inline form, Scope is a
  // search-input with a placeholder attribute (v3 fixed — confirmed working),
  // and Expiration is a NATIVE <select> whose OS popup can't be clicked —
  // handled with a selectOption step. Options observed live:
  // 1 Hour / 1 Day / 7 Days / 30 Days / 60 Days / 90 Days / 180 Days / 1 Year /
  // No Expiration. Submit is "Create".
  version: 4,
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
      // The Create Token form is INLINE on the tokens page (field-verified) —
      // there is no opener button; v1/v2's "open-create" click was hitting the
      // SUBMIT button prematurely, which is where the red validation errors
      // came from. First interaction is the name field itself.
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
      // REQUIRED scope. The control is a SEARCH-STYLE input whose "Select
      // scope" is a placeholder attribute (field-verified) — placeholders are
      // invisible to role-name and text= locators, hence the [placeholder=…]
      // primary. First option in the opened list = the personal account.
      id: 'open-scope',
      kind: 'click',
      target: { css: '[placeholder="Select scope"]', description: 'the Scope dropdown' },
      fallbacks: [
        { role: 'combobox', name: 'Scope', description: 'the Scope dropdown (fallback)' },
        { css: 'text=Select scope', description: 'the Scope dropdown (fallback 2)' },
      ],
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
      // Expiration is a NATIVE <select> (field-verified: OS-rendered menu with
      // options "1 Hour … 90 Days … No Expiration"). Native popups cannot be
      // clicked by the driver — selectOption on the element is the only way.
      id: 'set-expiration',
      kind: 'select',
      target: { css: 'select:has-text("Select Date")', description: 'the Expiration dropdown' },
      fallbacks: [
        { role: 'combobox', name: 'Expiration', description: 'the Expiration dropdown (fallback)' },
        { css: 'select', description: 'the Expiration dropdown (fallback 2)' },
      ],
      optionLabel: '90 Days',
    },
    {
      id: 'submit',
      kind: 'click',
      // Field-verified: the inline form's submit is labeled "Create".
      target: { role: 'button', name: 'Create', description: 'the Create button' },
      fallbacks: [{ role: 'button', name: 'Create Token', description: 'the Create button (fallback)' }],
    },
    {
      // The one-time value shown in the success dialog, straight DOM → vault.
      id: 'capture-token',
      kind: 'capture',
      // Dialog-scoped first: the page itself has other readonly inputs, and a
      // wrong grab costs a whole run (field-tested).
      target: { css: '[role="dialog"] input[readonly]', description: 'the new token value in the dialog' },
      fallbacks: [
        { css: '[role="dialog"] code', description: 'the new token value (fallback)' },
        { css: 'input[readonly]', description: 'the new token value (fallback 2)' },
        { css: 'code', description: 'the new token value (fallback 3)' },
      ],
      secretKey: 'token_value',
      timeoutMs: 15_000,
    },
  ],
};
