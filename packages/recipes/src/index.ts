/**
 * @basedagents/recipes — the open Provisioner recipe library.
 *
 * Community-contributed, signed, sandboxed recipes that teach Keyring how to
 * mint / capture / rotate / burn credentials at each provider. Coverage of the
 * long tail is the Provisioner's moat — which is exactly why this library is
 * open source (Apache-2.0) and auditable.
 *
 * See KEYRING_SPEC.md §6 and LICENSING.md.
 */

export type {
  RecipeManifest,
  RecipeProcedure,
  RecipeStep,
  RecipeSandbox,
  RecipeSignature,
  RecipeVerb,
  RecipeTransport,
} from './types.js';

import type { RecipeManifest, RecipeVerb } from './types.js';

/** Every verb a recipe may implement. */
export const RECIPE_VERBS: readonly RecipeVerb[] = ['mint', 'capture', 'rotate', 'burn'];

/** The minimum a usable recipe must implement — you can't have real revocation without a burn. */
export const REQUIRED_VERBS: readonly RecipeVerb[] = ['mint', 'burn'];

/**
 * The naming convention for keys minted by a recipe, so they are identifiable
 * in the provider's own dashboard (KEYRING_SPEC.md §6).
 */
export function mintedKeyName(agent: string, grantId: string): string {
  return `ba/${agent}/${grantId}`;
}

/** Whether a host is permitted by a sandbox domain entry (supports a single leftmost `*`). */
export function domainAllows(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p === h) return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".supabase.com"
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return false;
}

export interface RecipeValidationResult {
  valid: boolean;
  errors: string[];
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Structurally validate a recipe manifest. This checks shape, the sandbox
 * declaration, and that required verbs are present — it does NOT verify the
 * author signature (that requires the author's public key and is done at
 * install/trust time).
 */
export function validateRecipeManifest(input: unknown): RecipeValidationResult {
  const errors: string[] = [];
  const m = input as Partial<RecipeManifest> | null;

  if (!m || typeof m !== 'object') {
    return { valid: false, errors: ['recipe must be an object'] };
  }
  if (m.schema !== 'basedagents-recipe/v1') {
    errors.push('schema must be "basedagents-recipe/v1"');
  }
  if (typeof m.provider !== 'string' || !SLUG.test(m.provider)) {
    errors.push('provider must be a lowercase slug (a-z, 0-9, hyphen)');
  }
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) {
    errors.push('version must be semver (e.g. 1.0.0)');
  }
  if (typeof m.display_name !== 'string' || m.display_name.trim() === '') {
    errors.push('display_name is required');
  }
  if (m.transport !== 'api' && m.transport !== 'browser') {
    errors.push('transport must be "api" or "browser"');
  }
  if (!Array.isArray(m.scopes) || m.scopes.length === 0) {
    errors.push('scopes must be a non-empty array');
  }

  const sandbox = m.sandbox;
  if (!sandbox || typeof sandbox !== 'object') {
    errors.push('sandbox is required');
  } else {
    if (!Array.isArray(sandbox.domains) || sandbox.domains.length === 0) {
      errors.push('sandbox.domains must be a non-empty array');
    }
    if (sandbox.vault_access !== 'write-only') {
      errors.push('sandbox.vault_access must be "write-only"');
    }
  }

  const procedures = m.procedures;
  if (!procedures || typeof procedures !== 'object') {
    errors.push('procedures is required');
  } else {
    for (const verb of REQUIRED_VERBS) {
      if (!procedures[verb]) errors.push(`procedures.${verb} is required`);
    }
    for (const [verb, proc] of Object.entries(procedures)) {
      if (!(RECIPE_VERBS as readonly string[]).includes(verb)) {
        errors.push(`unknown verb: ${verb}`);
        continue;
      }
      if (!proc || (proc.transport !== 'api' && proc.transport !== 'browser')) {
        errors.push(`procedures.${verb}.transport must be "api" or "browser"`);
      }
      if (!Array.isArray(proc?.steps) || proc.steps.length === 0) {
        errors.push(`procedures.${verb}.steps must be a non-empty array`);
      } else {
        proc.steps.forEach((s, i) => {
          if (!s || typeof s.action !== 'string' || s.action.trim() === '') {
            errors.push(`procedures.${verb}.steps[${i}].action is required`);
          }
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
