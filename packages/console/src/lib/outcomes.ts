/**
 * Provider → outcome phrasing for the novice surfaces.
 *
 * A base-case user doesn't know what a provider is; they know what they want
 * to happen. So an ask is described by WHAT IT LETS THE AGENT DO ("put your
 * site live"), with the service name as a quiet detail — never by the name of
 * the thing it unlocks.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */

export interface AskPhrase {
  /** The outcome, as a verb phrase: "put your site live". */
  action: string;
  /** The service name to show as a detail ("Vercel"), or null when unknown. */
  via: string | null;
}

const KNOWN: Record<string, [action: string, via: string]> = {
  vercel: ['put your site live', 'Vercel'],
  netlify: ['put your site live', 'Netlify'],
  supabase: ['use your database', 'Supabase'],
  neon: ['use your database', 'Neon'],
  stripe: ['see and take payments', 'Stripe'],
  github: ['work with your code', 'GitHub'],
  openai: ['use AI on your account', 'OpenAI'],
  anthropic: ['use AI on your account', 'Anthropic'],
  openrouter: ['use AI on your account', 'OpenRouter'],
};

/** Phrase an ask by outcome; falls back to "use {label}" for unknown services. */
export function askPhrase(provider: string | null, label: string): AskPhrase {
  const hit = KNOWN[(provider ?? '').toLowerCase()];
  if (hit) return { action: hit[0], via: hit[1] };
  return { action: `use ${label}`, via: null };
}
