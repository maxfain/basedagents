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
    // Paste path stores the PROJECT service_role key (a JWT) — the daemon-side
    // preset refuses account-wide sbp_ tokens (Custody Fix 3). The automatic
    // path mints a per-project secret key instead, burnable by id.
    envVar: 'SUPABASE_SERVICE_ROLE_KEY',
    tokenUrl: 'https://supabase.com/dashboard/project/_/settings/api',
    steps: [
      'On the page that just opened, find "Project API keys"',
      'Reveal the  service_role  key for the project your agent works on',
      'Copy it (a long eyJ… value) and paste it below',
    ],
    placeholder: 'eyJ…',
    looksValid: (t) => t.trim().startsWith('eyJ') && t.trim().length >= 40,
    hint: 'Use the project service_role key (starts with eyJ), not your account token (sbp_…).',
    automatic: {
      command: 'npx basedagents keyring connect supabase',
      blurb:
        'Keyring can do this by itself on the computer where your agent lives: '
        + 'the first time, a browser window opens there — you sign in if asked and watch it work. '
        + 'It then mints a key scoped to one project, revocable on its own. After that, no window at all.',
      remote: true,
    },
  },
];
