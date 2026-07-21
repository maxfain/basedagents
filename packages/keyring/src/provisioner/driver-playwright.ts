/**
 * Playwright driver (PROVISIONER spec, header decision) — launchPersistentContext
 * on a dedicated Keyring browser profile, headful, using the system browser via
 * playwright-core channels (chrome → msedge → bundled chromium as a guided last
 * resort). playwright-core ships no browsers, keeping the npm package slim.
 *
 * Loaded via dynamic import so environments that never run `connect` (cloud
 * sandboxes, CI unit tests) pay nothing at require time.
 *
 * Headless is refused HERE, at the driver boundary (§2 "no headless
 * provisioning, ever"): no display → the exact sandbox-routing message. The
 * weekly canary satisfies this with xvfb — a real display server, headful
 * chrome, no code path difference.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Driver, RecipeLocator } from './types.js';

export const KEYRING_PROFILE_DIR = path.join(os.homedir(), '.basedagents', 'browser');

export const NO_DISPLAY_MESSAGE =
  'The Keyring browser needs a visible window and there is no display here — this is normal inside ' +
  'cloud agent sandboxes. Connect flows run on the OWNER\'s computer: ask your human to run ' +
  '`npx basedagents keyring connect vercel` on their machine (or approve the request in the console), ' +
  'then the minted token is granted back to you.';

function hasDisplay(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** Minimal structural types for the slice of playwright-core we drive. */
interface PwLocator {
  first(): PwLocator;
  waitFor(opts: { state: 'visible'; timeout: number }): Promise<void>;
  click(opts: { timeout: number }): Promise<void>;
  fill(value: string, opts: { timeout: number }): Promise<void>;
  selectOption(values: { label: string }, opts: { timeout: number }): Promise<string[]>;
  inputValue(opts: { timeout: number }): Promise<string>;
  textContent(opts: { timeout: number }): Promise<string | null>;
}
interface PwPage {
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  url(): string;
  getByRole(role: string, opts?: { name?: string }): PwLocator;
  locator(css: string): PwLocator;
}
interface PwContext {
  pages(): PwPage[];
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}

function toLocator(page: PwPage, loc: RecipeLocator): PwLocator {
  if (loc.role) return page.getByRole(loc.role, loc.name ? { name: loc.name } : undefined).first();
  if (loc.css) return page.locator(loc.css).first();
  throw new Error(`recipe locator for "${loc.description}" has neither role nor css`);
}

export class PlaywrightDriver implements Driver {
  private constructor(private readonly context: PwContext, private page: PwPage) {}

  /**
   * Launch the dedicated profile. Throws NO_DISPLAY_MESSAGE without a display —
   * callers surface it verbatim (it routes sandboxed agents to their owner).
   */
  static async launch(): Promise<PlaywrightDriver> {
    if (!hasDisplay()) throw new Error(NO_DISPLAY_MESSAGE);

    let chromium: {
      launchPersistentContext(dir: string, opts: Record<string, unknown>): Promise<PwContext>;
    };
    try {
      ({ chromium } = (await import('playwright-core')) as unknown as { chromium: typeof chromium });
    } catch {
      throw new Error(
        'playwright-core is not installed — reinstall @basedagents/keyring (it is a declared dependency).'
      );
    }

    mkdirSync(KEYRING_PROFILE_DIR, { recursive: true, mode: 0o700 });

    // System browser first (no download); bundled chromium only as guided last resort.
    const attempts: Array<Record<string, unknown>> = [
      { channel: 'chrome' },
      { channel: 'msedge' },
      {}, // playwright-managed chromium, if the user has installed it
    ];
    let context: PwContext | null = null;
    let lastErr: unknown;
    for (const extra of attempts) {
      try {
        context = await chromium.launchPersistentContext(KEYRING_PROFILE_DIR, {
          headless: false,
          viewport: null,
          // Playwright disables Chromium's OS sandbox by default (it passes
          // --no-sandbox, and the browser shows a scary warning banner). This
          // window drives the user's real provider session — keep the sandbox ON.
          chromiumSandbox: true,
          ...extra,
        });
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!context) {
      throw new Error(
        'No usable browser found. Install Google Chrome or Microsoft Edge, or run ' +
        `\`npx playwright install chromium\` once, then retry. (${(lastErr as Error)?.message ?? 'unknown error'})`
      );
    }
    const page = context.pages()[0] ?? (await context.newPage());
    return new PlaywrightDriver(context, page);
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  async currentUrl(): Promise<string> {
    return this.page.url();
  }

  async exists(locator: RecipeLocator, timeoutMs: number): Promise<boolean> {
    try {
      await toLocator(this.page, locator).waitFor({ state: 'visible', timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  async click(locator: RecipeLocator, timeoutMs: number): Promise<void> {
    await toLocator(this.page, locator).click({ timeout: timeoutMs });
  }

  async fill(locator: RecipeLocator, value: string, timeoutMs: number): Promise<void> {
    await toLocator(this.page, locator).fill(value, { timeout: timeoutMs });
  }

  async selectOption(locator: RecipeLocator, optionLabel: string, timeoutMs: number): Promise<void> {
    await toLocator(this.page, locator).selectOption({ label: optionLabel }, { timeout: timeoutMs });
  }

  async read(locator: RecipeLocator, timeoutMs: number): Promise<string> {
    const l = toLocator(this.page, locator);
    try {
      const v = await l.inputValue({ timeout: timeoutMs });
      if (v) return v;
    } catch { /* not an input — fall through to text */ }
    return (await l.textContent({ timeout: timeoutMs })) ?? '';
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}
