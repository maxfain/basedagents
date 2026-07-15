/**
 * Provisioner recipe model — see KEYRING_SPEC.md §6.
 *
 * A recipe teaches Keyring how to mint / capture / rotate / burn a credential
 * at one provider. Recipes are:
 *   - signed         — every recipe carries an author signature over its content
 *   - sandboxed      — a recipe may only touch the domains it declares, and may
 *                      only WRITE captured values into the vault, never read
 *                      existing ones
 *   - versioned      — each provider recipe is versioned independently
 *   - API-first      — where a provider has a real key-management API, the
 *                      recipe uses it; the browser path is the fallback for the
 *                      long tail of dashboard-only providers
 *
 * This package defines and validates recipe manifests. Executing them (via a
 * provider API client or a Playwright/CDP browser session on the user's own
 * machine) is the Provisioner's job and lives elsewhere.
 */

/** The four verbs every recipe may implement. Not all providers support all four. */
export type RecipeVerb = 'mint' | 'capture' | 'rotate' | 'burn';

/**
 * How a verb reaches the provider.
 *   'api'     — a real key-management API (preferred: AWS IAM, GitHub PATs, Stripe restricted keys)
 *   'browser' — automate the user's own authenticated browser session (dashboard-only providers)
 */
export type RecipeTransport = 'api' | 'browser';

/**
 * The sandbox a recipe is confined to. Enforced by the executor, declared here
 * so it is auditable before a recipe ever runs.
 */
export interface RecipeSandbox {
  /**
   * The only hosts this recipe may talk to — navigation targets for `browser`
   * transport, API hosts for `api` transport. Wildcards allowed on the leftmost
   * label only (e.g. "*.supabase.com").
   */
  domains: string[];
  /**
   * Recipes are write-only into the vault: they may hand Keyring a value they
   * just captured, but may never read existing sealed material. Always true;
   * present so the guarantee is explicit in every manifest.
   */
  vault_access: 'write-only';
}

/** A single declarative step in a verb procedure. The executor interprets these. */
export interface RecipeStep {
  /** e.g. "navigate", "click", "fill", "read_value", "api_call", "wait_for". */
  action: string;
  /** CSS/text selector, URL, or API path the action targets. */
  target?: string;
  /**
   * A value reference, never a literal secret. `{{scope}}`, `{{agent}}`,
   * `{{grant_id}}`, or `capture:<name>` to mark where the minted value is read.
   */
  value?: string;
  /** Human-readable note shown during visible execution. */
  note?: string;
}

/** The procedure for one verb: its transport and ordered steps. */
export interface RecipeProcedure {
  transport: RecipeTransport;
  steps: RecipeStep[];
}

/** The signature envelope proving who authored the recipe content. */
export interface RecipeSignature {
  /** base58 Ed25519 public key of the recipe author. */
  author_pubkey: string;
  /** base64 Ed25519 signature over the canonical recipe content (all fields except this one). */
  signature: string;
}

/**
 * A provider recipe manifest. The naming convention for minted keys is
 * `ba/{agent}/{grant-id}` so they are identifiable in the provider's own
 * dashboard.
 */
export interface RecipeManifest {
  /** Manifest schema version. */
  schema: 'basedagents-recipe/v1';
  /** Provider slug, e.g. "supabase", "vercel", "github". */
  provider: string;
  /** Recipe version (semver), independent per provider. */
  version: string;
  /** Human-facing provider name. */
  display_name: string;
  /** Default transport; individual procedures may override. */
  transport: RecipeTransport;
  /** The sandbox this recipe is confined to. */
  sandbox: RecipeSandbox;
  /** Scope descriptors this recipe can mint, e.g. ["read-only", "service-role"]. */
  scopes: string[];
  /** Verb → procedure. A recipe must implement at least `mint` and `burn`. */
  procedures: Partial<Record<RecipeVerb, RecipeProcedure>>;
  /** Author signature over the manifest content (omitted while drafting). */
  signature?: RecipeSignature;
}
