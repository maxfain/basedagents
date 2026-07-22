/**
 * Connect-card presets (v0.1 = assisted paste; the Provisioner upgrades these
 * to one-click without changing shape). Deep link + 3 visual steps + shape
 * check. The REAL validation happens on the user's machine when the daemon
 * stores the token — the browser only checks that the paste looks right.
 */

export interface ProviderCard {
  id: string;
  label: string;
  envVar: string;
  tokenUrl: string;
  steps: [string, string, string];
  placeholder: string;
  looksValid: (token: string) => boolean;
  hint: string;
  /**
   * Provisioner path: a command the human runs on THEIR computer that mints a
   * scoped token automatically (browser once, API afterwards). When `remote`
   * is true the card also shows a "Do it for me" button that asks the machine
   * where the agent lives (via its watch loop) to run that same path.
   */
  automatic?: { command: string; blurb: string; remote?: boolean };
}

export const PROVIDER_CARDS: ProviderCard[] = [
  {
    id: 'vercel',
    label: 'Vercel',
    envVar: 'VERCEL_TOKEN',
    tokenUrl: 'https://vercel.com/account/settings/tokens',
    steps: [
      'Click "Create Token" on the page that just opened',
      'Name it  ba-claude-code  and pick the scope you use',
      'Copy the token and paste it below',
    ],
    placeholder: 'Paste your Vercel token',
    looksValid: (t) => t.trim().length >= 20,
    hint: 'Vercel tokens are long random strings (24+ characters).',
    automatic: {
      command: 'npx basedagents keyring connect vercel',
      blurb:
        'Keyring can do this by itself on the computer where your agent lives: '
        + 'the first time, a browser window opens there — you sign in if asked and watch it work. '
        + 'After that, no window at all.',
      remote: true,
    },
  },
  {
    id: 'supabase',
    label: 'Supabase',
    envVar: 'SUPABASE_ACCESS_TOKEN',
    tokenUrl: 'https://supabase.com/dashboard/account/tokens',
    steps: [
      'Click "Generate new token" on the page that just opened',
      'Name it  ba-claude-code',
      'Copy the token (starts with sbp_) and paste it below',
    ],
    placeholder: 'sbp_…',
    looksValid: (t) => t.trim().startsWith('sbp_') && t.trim().length >= 20,
    hint: 'Supabase access tokens start with sbp_.',
  },
];
