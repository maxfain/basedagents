/**
 * Supabase bootstrap recipe (PROVISIONER spec §5) — mints ONE personal access
 * token (`sbp_…`): the provisioning credential. Agent keys are never minted
 * here; they come from the management API afterwards (§1 bootstrap-then-API).
 *
 * Recipes are data. Selector strategy (§4): accessibility roles + visible
 * labels first, CSS fallbacks second, checkpoint handoff as the safety net —
 * so UI drift degrades to "click it yourself", never to a crash. Drift is
 * caught by the canary, not by users.
 *
 * v1 — selectors written from the documented dashboard flow (Account →
 * Access Tokens → "Generate new token" → name → token shown once with Copy)
 * and NOT yet field-verified on the live DOM; every step carries fallbacks
 * and the checkpoint absorbs whatever drifted. Bump the version on any step
 * change, as with vercel.ts.
 */

import type { Recipe } from '../types.js';

export const SUPABASE_TOKENS_URL = 'https://supabase.com/dashboard/account/tokens';

export const supabaseBootstrapRecipe: Recipe = {
  id: 'supabase-bootstrap',
  version: 1,
  provider: 'supabase',
  allowedDomains: ['supabase.com'],
  login: {
    url: SUPABASE_TOKENS_URL,
    // The tokens page shows its generate button only with a live session; a
    // logged-out visit lands on the sign-in flow where it is absent.
    loggedInProbe: {
      role: 'button',
      name: 'Generate new token',
      description: 'the Generate new token button on the Access Tokens page',
    },
    loggedOutHint:
      'Log in to Supabase in the open window (any method — email, GitHub, SSO). ' +
      'Nothing is watched or recorded while you do; press Continue when you are on the Access Tokens page.',
  },
  steps: [
    { id: 'open-tokens', kind: 'goto', url: SUPABASE_TOKENS_URL },
    {
      id: 'open-generate',
      kind: 'click',
      target: { role: 'button', name: 'Generate new token', description: 'the Generate new token button' },
      fallbacks: [
        { css: 'text=Generate new token', description: 'the Generate new token button (fallback)' },
        { css: 'text=Generate New Token', description: 'the Generate new token button (fallback 2)' },
      ],
    },
    {
      id: 'fill-name',
      kind: 'fill',
      target: { role: 'textbox', name: 'Name', description: 'the token name field' },
      fallbacks: [
        { css: '[role="dialog"] input[type="text"]', description: 'the token name field (fallback)' },
        { css: 'input[placeholder*="name" i]', description: 'the token name field (fallback 2)' },
      ],
      param: 'token_name',
    },
    {
      id: 'submit',
      kind: 'click',
      target: { role: 'button', name: 'Generate token', description: 'the Generate token button' },
      fallbacks: [
        { css: '[role="dialog"] button[type="submit"]', description: 'the Generate token button (fallback)' },
        { css: 'text=Generate token', description: 'the Generate token button (fallback 2)' },
      ],
    },
    {
      // The one-time `sbp_…` value shown after generation, straight DOM → vault.
      id: 'capture-token',
      kind: 'capture',
      // Dialog-scoped first — a wrong grab costs a whole run (vercel field lesson).
      target: { css: '[role="dialog"] input[readonly]', description: 'the new token value in the dialog' },
      fallbacks: [
        { css: '[role="dialog"] code', description: 'the new token value (fallback)' },
        { css: 'input[readonly]', description: 'the new token value (fallback 2)' },
        { css: 'code', description: 'the new token value (fallback 3)' },
      ],
      secretKey: 'token_value',
      // DOM shape of the reveal is the least stable part — but every token
      // reveal has a Copy button. Click it, read the clipboard.
      copyButton: { role: 'button', name: 'Copy', description: 'the Copy button in the dialog' },
      copyButtonFallbacks: [
        { css: '[aria-label="Copy"]', description: 'the Copy button (fallback)' },
        { css: 'text=Copy', description: 'the Copy button (fallback 2)' },
      ],
      timeoutMs: 15_000,
    },
  ],
};
