/**
 * Recipe engine (PROVISIONER spec §3–§4) — executes a versioned recipe against
 * an injected Driver, enforcing the invariants the spec calls non-negotiable:
 *
 *  - Domain lock: every navigation target AND every post-step location must be
 *    inside the recipe's allowlist, or the run aborts and the window closes.
 *  - Consent first: nothing navigates until the human approves the plan.
 *  - Login checkpoint: no recipe step executes while the user logs in.
 *  - Checkpoint handoff: a step that can't find its target pauses for the human
 *    instead of crashing; a failed CAPTURE degrades to assisted-paste.
 *  - Capture hygiene: secret values exist only in the returned `captured` map —
 *    never in transcripts, hooks.info() lines, or thrown errors.
 */

import type { Driver, EngineHooks, Recipe, RecipeLocator, RecipeStep, RunOutcome } from './types.js';

const DEFAULT_STEP_TIMEOUT_MS = 10_000;
const LOGIN_PROBE_TIMEOUT_MS = 6_000;
const LOGIN_MAX_ROUNDS = 20; // human retries; each round re-probes after Continue

/** Host allowed iff it equals an allowlisted domain or is a subdomain of one. */
export function hostAllowed(url: string, allowedDomains: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedDomains.some((d) => {
    const dom = d.toLowerCase();
    return host === dom || host.endsWith(`.${dom}`);
  });
}

/** The plain-words consent plan for a recipe run (no secrets, no selectors). */
export function describePlan(recipe: Recipe, purpose: string[]): string[] {
  return [
    `Open ${recipe.allowedDomains[0]} in the Keyring browser window (visible, on this computer).`,
    ...purpose,
    'Save the result straight into your local vault — it is never shown, logged, or sent anywhere else.',
    `The window can only visit: ${recipe.allowedDomains.join(', ')} — anything else aborts.`,
  ];
}

async function locate(
  driver: Driver,
  target: RecipeLocator,
  fallbacks: RecipeLocator[] | undefined,
  timeoutMs: number
): Promise<RecipeLocator | null> {
  if (await driver.exists(target, timeoutMs)) return target;
  for (const fb of fallbacks ?? []) {
    if (await driver.exists(fb, Math.min(timeoutMs, 3_000))) return fb;
  }
  return null;
}

export async function runRecipe(
  recipe: Recipe,
  driver: Driver,
  hooks: EngineHooks,
  params: Record<string, string>,
  purpose: string[]
): Promise<RunOutcome> {
  // Static validation BEFORE consent: a tampered recipe whose goto steps leave
  // the allowlist is refused outright, not discovered mid-run.
  for (const step of recipe.steps) {
    if (step.kind === 'goto' && !hostAllowed(step.url, recipe.allowedDomains)) {
      return { status: 'aborted', atStep: step.id, reason: `recipe step navigates outside the allowlist: ${step.url}` };
    }
  }
  if (!hostAllowed(recipe.login.url, recipe.allowedDomains)) {
    return { status: 'aborted', atStep: null, reason: 'recipe login page is outside the allowlist' };
  }

  if (!(await hooks.consent(describePlan(recipe, purpose)))) {
    return { status: 'aborted', atStep: null, reason: 'cancelled at consent' };
  }

  const transcript: Array<{ step: string; result: 'ok' | 'manual' }> = [];
  const captured = new Map<string, string>();

  const abort = async (atStep: string | null, reason: string): Promise<RunOutcome> => {
    try { await driver.close(); } catch { /* window already gone */ }
    return { status: 'aborted', atStep, reason };
  };

  const domainGuard = async (context: string): Promise<string | null> => {
    const url = await driver.currentUrl();
    if (!hostAllowed(url, recipe.allowedDomains)) {
      return `left the allowed domains (${context}) — aborting for safety`;
    }
    return null;
  };

  // ── Login checkpoint (§4): no steps run until a session exists. ──
  hooks.info('Checking for an existing session…');
  await driver.goto(recipe.login.url);
  let loggedIn = await driver.exists(recipe.login.loggedInProbe, LOGIN_PROBE_TIMEOUT_MS);
  let loginRounds = 0;
  while (!loggedIn) {
    if (++loginRounds > LOGIN_MAX_ROUNDS) return abort(null, 'login was not completed');
    const choice = await hooks.login(recipe.login.loggedOutHint);
    if (choice === 'abort') return abort(null, 'cancelled at login');
    const guard = await domainGuard('after login');
    if (guard) return abort(null, guard);
    loggedIn = await driver.exists(recipe.login.loggedInProbe, LOGIN_PROBE_TIMEOUT_MS);
  }
  hooks.info('Session found — running the recipe.');

  // ── Steps ──
  for (const step of recipe.steps) {
    const outcome = await runStep(step, driver, hooks, params, captured);
    if (outcome === 'aborted') return abort(step.id, 'cancelled at checkpoint');
    if (outcome === 'fallback_paste') {
      // Window intentionally left OPEN — the value is on the user's screen.
      return { status: 'fallback_paste', atStep: step.id, transcript };
    }
    transcript.push({ step: step.id, result: outcome });
    const guard = await domainGuard(`after step ${step.id}`);
    if (guard) return abort(step.id, guard);
  }

  await driver.close();
  return { status: 'completed', captured, transcript };
}

async function runStep(
  step: RecipeStep,
  driver: Driver,
  hooks: EngineHooks,
  params: Record<string, string>,
  captured: Map<string, string>
): Promise<'ok' | 'manual' | 'aborted' | 'fallback_paste'> {
  if (step.kind === 'goto') {
    await driver.goto(step.url);
    return 'ok';
  }

  const timeoutMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const found = await locate(driver, step.target, step.fallbacks, timeoutMs);

  if (step.kind === 'click') {
    if (found) {
      await driver.click(found, timeoutMs);
      return 'ok';
    }
    const choice = await hooks.checkpoint(
      step.id,
      `I can't find ${step.target.description}. Click it yourself in the window, then press Continue.`
    );
    return choice === 'continue' ? 'manual' : 'aborted';
  }

  if (step.kind === 'fill') {
    const value = params[step.param];
    if (value == null) throw new Error(`recipe references unknown param "${step.param}"`);
    if (found) {
      await driver.fill(found, value, timeoutMs);
      return 'ok';
    }
    const choice = await hooks.checkpoint(
      step.id,
      `I can't find ${step.target.description}. Type "${value}" into it yourself, then press Continue.`
    );
    return choice === 'continue' ? 'manual' : 'aborted';
  }

  // capture — the one step a human can't do by hand into our memory: a failed
  // capture degrades to the assisted-paste flow (§4: never a dead end).
  if (found) {
    const value = (await driver.read(found, timeoutMs)).trim();
    if (value.length > 0) {
      captured.set(step.secretKey, value);
      return 'ok';
    }
  }
  return 'fallback_paste';
}
