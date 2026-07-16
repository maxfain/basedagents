/**
 * Passkey E2E (coder brief Task 2): real Chromium, CDP virtual authenticator,
 * headless, CI-safe.
 *
 * Two servers, started by Playwright:
 *   - the real control-plane API on Node/SQLite (packages/api src/node.ts)
 *     with E2E=1 (mailer → test_outbox; /test/* endpoints exist) and
 *     RP ID `localhost` (WebAuthn requires the RP ID to match the page host);
 *   - the console via the vite dev server with VITE_API_URL='' so /v1 requests
 *     stay same-origin and proxy to the API (no CORS/cookie special-casing).
 *
 * The API database is recreated from scratch on every run.
 */
import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const API_PORT = 3000;
const CONSOLE_PORT = 5174;

// This container preinstalls Chromium at a fixed path; CI installs the
// version matching @playwright/test and uses default resolution.
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium';
const executablePath =
  !process.env.CI && existsSync(PREINSTALLED_CHROMIUM) ? PREINSTALLED_CHROMIUM : undefined;

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000, // full-journey scenarios (recovery) chain several passkey ceremonies over the vite dev server
  fullyParallel: false,
  workers: 1, // one shared API/database — keep scenarios deterministic
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: `http://localhost:${CONSOLE_PORT}`,
    trace: 'retain-on-failure',
    launchOptions: { executablePath },
  },
  webServer: [
    {
      command: `rm -rf .e2e-data && npx tsx src/node.ts`,
      cwd: '../api',
      port: API_PORT,
      reuseExistingServer: false,
      env: {
        E2E: '1',
        PORT: String(API_PORT),
        DATABASE_PATH: '.e2e-data/e2e.db',
        KEYRING_RP_ID: 'localhost',
        KEYRING_ORIGINS: `http://localhost:${CONSOLE_PORT}`,
        KEYRING_CONSOLE_ORIGIN: `http://localhost:${CONSOLE_PORT}`,
      },
    },
    {
      command: `npx vite --port ${CONSOLE_PORT} --strictPort`,
      port: CONSOLE_PORT,
      reuseExistingServer: false,
      env: { VITE_API_URL: '' },
    },
  ],
});
