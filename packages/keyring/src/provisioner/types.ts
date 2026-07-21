/**
 * Provisioner v1 (PROVISIONER spec) — shared types.
 *
 * The engine is provider-generic and browser-agnostic: recipes are DATA, the
 * browser is a Driver implementation injected at the edge. That keeps every
 * behavior that matters (domain lock, checkpoints, capture hygiene) unit-testable
 * without a display, which is also why no secret value ever appears in any type
 * that leaves the engine except the explicit `captured` map.
 */

/** How to find one thing on a page. Accessibility-first; CSS is the fallback. */
export interface RecipeLocator {
  /** ARIA role, e.g. 'button', 'textbox', 'link'. */
  role?: string;
  /** Accessible name (visible label) to match with the role. */
  name?: string;
  /**
   * Playwright selector (CSS, `text=…`, `text=/regex/i`, …) — used when
   * role/name is absent, or as a fallback locator.
   */
  css?: string;
  /** Human words for checkpoint messages, e.g. "the Create button". */
  description: string;
}

export type RecipeStep =
  | { id: string; kind: 'goto'; url: string }
  | { id: string; kind: 'click'; target: RecipeLocator; fallbacks?: RecipeLocator[]; timeoutMs?: number }
  | {
      id: string;
      kind: 'fill';
      target: RecipeLocator;
      fallbacks?: RecipeLocator[];
      /** Key into the params map supplied to run() — never an inline value. */
      param: string;
      timeoutMs?: number;
    }
  | {
      /**
       * Choose an option in a NATIVE <select>. Clicking native dropdowns is
       * impossible for the driver (the OS renders the popup), so this maps to
       * Playwright's selectOption on the element itself.
       */
      id: string;
      kind: 'select';
      target: RecipeLocator;
      fallbacks?: RecipeLocator[];
      /** Exact visible label of the option, e.g. "90 Days". */
      optionLabel: string;
      timeoutMs?: number;
    }
  | {
      id: string;
      kind: 'capture';
      target: RecipeLocator;
      fallbacks?: RecipeLocator[];
      /** Key under which the captured secret is returned. Write-only: engines never log it. */
      secretKey: string;
      timeoutMs?: number;
    };

export interface Recipe {
  id: string;
  /** Bump on any step change; recorded in the AccessEvent detail. */
  version: number;
  provider: string;
  /**
   * Host allowlist — a navigation target (or post-step location) whose host is
   * not one of these (or a subdomain of one) aborts the run. Enforced by the
   * ENGINE, not the recipe, so a tampered recipe cannot widen it silently
   * (the engine also refuses recipes whose steps navigate elsewhere).
   */
  allowedDomains: string[];
  login: {
    /** Where the session check happens (usually the page the flow starts on). */
    url: string;
    /** Present only when logged in — e.g. the account avatar/menu. */
    loggedInProbe: RecipeLocator;
    /** Plain-words instruction for the login checkpoint. */
    loggedOutHint: string;
  };
  steps: RecipeStep[];
}

/**
 * The browser surface the engine drives. Implementations: PlaywrightDriver
 * (production) and FakeDriver (tests). All methods that look things up take a
 * timeout — the engine decides patience, the driver just obeys.
 */
export interface Driver {
  goto(url: string): Promise<void>;
  currentUrl(): Promise<string>;
  /** True if the locator resolves within the timeout. Never throws. */
  exists(locator: RecipeLocator, timeoutMs: number): Promise<boolean>;
  /** Throws if the locator cannot be resolved within the timeout. */
  click(locator: RecipeLocator, timeoutMs: number): Promise<void>;
  fill(locator: RecipeLocator, value: string, timeoutMs: number): Promise<void>;
  /** Native-<select> option pick by exact visible label. Throws if not applicable. */
  selectOption(locator: RecipeLocator, optionLabel: string, timeoutMs: number): Promise<void>;
  /** Read a value (input value or text content). Throws if unresolvable. */
  read(locator: RecipeLocator, timeoutMs: number): Promise<string>;
  close(): Promise<void>;
}

/** Interaction points with the human. All run in the CLI/console, never headless. */
export interface EngineHooks {
  /**
   * Show the plain-words plan; false = user cancelled (nothing has run yet).
   * The engine calls this exactly once, before any navigation.
   */
  consent(plan: string[]): Promise<boolean>;
  /** Login checkpoint — the window is open at the login page; wait for the human. */
  login(hint: string): Promise<'continue' | 'abort'>;
  /**
   * Step checkpoint (§4 handoff): the engine couldn't find the step's target;
   * the human completes the step by hand and presses Continue, or aborts.
   */
  checkpoint(stepId: string, message: string): Promise<'continue' | 'abort'>;
  /** Progress line. NEVER receives a secret value. */
  info(message: string): void;
}

export type RunOutcome =
  | {
      status: 'completed';
      /** secretKey → captured value. The ONLY place values exist. */
      captured: Map<string, string>;
      /** Step ids + how each resolved. Safe for AccessEvent detail (no values). */
      transcript: Array<{ step: string; result: 'ok' | 'manual' }>;
    }
  | { status: 'aborted'; atStep: string | null; reason: string }
  | {
      /**
       * A CAPTURE step could not be completed even by hand — degrade to the
       * assisted-paste flow (§4: never a dead end). The window is left open so
       * the human can copy the value from their own screen.
       */
      status: 'fallback_paste';
      atStep: string;
      transcript: Array<{ step: string; result: 'ok' | 'manual' }>;
    };
