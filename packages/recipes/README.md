# @basedagents/recipes

The open Provisioner recipe library for **BasedAgents Keyring**.

A recipe teaches Keyring how to **mint, capture, rotate, and burn** a credential
at one provider — so revocation is real (the key is burned at the provider),
not cosmetic. This library is Apache-2.0 and community-contributed on purpose:
coverage of the long tail of providers is the Provisioner's moat, and that
coverage only compounds if anyone can read, audit, sign, and contribute recipes.

> Recipes are **manifests**, not executables. This package defines and validates
> them. Running a recipe — against a provider API or the user's own
> authenticated browser session via Playwright/CDP — is the Provisioner's job
> (KEYRING_SPEC.md §6) and is always user-initiated and visible.

## The model

Every recipe is:

- **Signed** — carries an Ed25519 signature over its content, so you know who
  wrote it.
- **Sandboxed** — may touch only the `domains` it declares, and is **write-only
  into the vault**: it can hand Keyring a value it just captured, but can never
  read existing sealed secrets.
- **Versioned** — each provider recipe is versioned independently.
- **API-first** — where a provider has a real key-management API (AWS IAM,
  GitHub fine-grained PATs, Stripe restricted keys), the recipe uses it. The
  browser path is the fallback for dashboard-only providers (Supabase, Railway,
  most indie SaaS). As providers ship native agent-credential APIs, recipes
  migrate from `browser` to `api` transport with no change to the product.

### The four verbs

| Verb | What it does |
|---|---|
| `mint(scope)` | Create a key, named `ba/{agent}/{grant-id}` so it is identifiable in the provider's own dashboard |
| `capture` | Pull the new value into Keyring at creation time (never displayed to the human) |
| `rotate` | Mint a replacement, swap grants, burn the old key |
| `burn` | Delete or disable the key at the provider |

A usable recipe must implement at least `mint` and `burn` — without a burn there
is no real revocation.

## Layout

```
recipes/<provider>/<version>.json   # signed recipe manifests
schema/recipe.schema.json           # JSON Schema for a manifest
src/                                # types + validator (mintedKeyName, validateRecipeManifest, …)
```

## Using it

```ts
import { validateRecipeManifest, mintedKeyName } from '@basedagents/recipes';

const result = validateRecipeManifest(manifest);
if (!result.valid) throw new Error(result.errors.join('\n'));

mintedKeyName('ci-bot', 'grant_abc'); // -> "ba/ci-bot/grant_abc"
```

The JSON Schema is exported for editor/tooling validation:

```ts
import schema from '@basedagents/recipes/schema' assert { type: 'json' };
```

## Contributing a recipe

1. Copy `recipes/example-dashboard/1.0.0.json` to `recipes/<your-provider>/1.0.0.json`.
2. Declare the smallest possible `sandbox.domains`. Keep `vault_access` `write-only`.
3. Prefer `api` transport if the provider has a key API; use `browser` only for
   the dashboard long tail.
4. Name minted keys `ba/{{agent}}/{{grant_id}}`. Never put a literal secret in a
   step — use `capture:<name>` to mark where the minted value is read.
5. Validate: `npm test` (the suite validates every bundled recipe against the schema).
6. Sign your recipe and open a PR.

By opening a PR you agree your contribution is provided under this package's
Apache-2.0 license. See the repo's `LICENSING.md`.

## License

Apache-2.0.
