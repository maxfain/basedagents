# Gotchas

The sharp edges that will bite you when deploying or extending the Keyring
control plane. Each one either bit us already or almost did. The authority
model lives in [`CONTROL_PLANE.md`](./CONTROL_PLANE.md); this file is the
operational and development footnotes.

---

## Deploying

### Passkeys only work on `app.basedagents.ai` — previews will always fail

The WebAuthn RP ID is the registrable domain `basedagents.ai`, and the server
verifies assertion origins against the `KEYRING_ORIGINS` allow-list (which
contains only `https://app.basedagents.ai`). Consequences:

- A Cloudflare Pages **preview URL** (`*.basedagents-console.pages.dev`) loads
  the console fine — CORS admits it — but **every passkey ceremony from it is
  rejected**. This is by design, not a bug to fix.
- You cannot make previews work by adding the `pages.dev` origin: the RP ID
  must be a registrable-domain suffix of the origin's host, and `pages.dev`
  isn't `basedagents.ai`. A real staging console needs its own
  `basedagents.ai` subdomain (e.g. `staging.basedagents.ai`) added to
  `KEYRING_ORIGINS`.
- Passkeys registered on `app.basedagents.ai` keep working on any future
  `*.basedagents.ai` console because the RP ID is the apex — don't "tighten"
  it to the full hostname or every existing passkey breaks.

### Deploy order: Worker (with migrations) → console → domain

The console's API base URL (`https://api.basedagents.ai`) is baked at build
time and there is no runtime discovery. If the Worker isn't deployed — or
migrations 0023–0025 aren't applied — the console loads and then every call
fails. And note that **`wrangler deploy` does not apply D1 migrations**;
that's a separate, explicit step:

```bash
cd packages/api
npx wrangler d1 migrations apply agent-registry --remote   # first
npx wrangler deploy --name agent-registry-api              # then
```

### Manual columns: `agents.webhook_url` and `agents.reputation_override` have no migration

No file in `packages/api/migrations/` defines `agents.webhook_url` (task
webhooks) or `agents.reputation_override` (the SECURITY_AUDIT.md manual
override). Production has both — they were added by hand — so a migration
that adds them now would fail there with `duplicate column name`. Locally,
`src/node.ts` adds both guarded after the chain (`RUNNER_LOCAL_STATEMENTS` in
`src/db/migration-list.ts`) and `test-helpers.ts` inlines them. A fresh OSS
deploy must add them once, by hand, before its first Worker deploy:

```bash
cd packages/api
npx wrangler d1 execute agent-registry --remote --command "ALTER TABLE agents ADD COLUMN webhook_url TEXT"
npx wrangler d1 execute agent-registry --remote --command "ALTER TABLE agents ADD COLUMN reputation_override REAL"
npx wrangler d1 execute agent-registry --remote --command "PRAGMA table_info(agents)"   # confirm both are listed
```

### Task payments fail closed behind `TASK_PAYMENTS_ENABLED`

Bounties do not exist on a deploy until **all** of these hold: `TASK_PAYMENTS_ENABLED = "1"`
(a plain var), `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` (secrets — the secret
must be the **Ed25519** kind, base64 of 64 bytes; an EC/PEM key is rejected
with one log line) and `PAYMENT_ENCRYPTION_KEY` (64 hex). Until then
`paymentProviderFor(env)` is `null` and:

- `POST /v1/tasks` with a `bounty` → `503 payments_unavailable`, nothing written
- `POST /v1/tasks/:id/accept` on a bounty task → `503`, the task stays `submitted`
- the 5-minute cron still auto-accepts after 7 days, but logs
  `settle_skipped_reason` and settles nothing
- `GET /v1/status` says `payments: "disabled"`

Free tasks are unaffected. This is deliberate: a bounty that can never be
paid must not be creatable. Do not "fix" a 503 by setting the var alone —
run the enable checklist in `packages/api/README.md` (secrets →
`npx tsx scripts/x402-supported-check.ts` → one paid Sepolia task on staging →
flip the var in production `[vars]`). The USDC EIP-712 domain name on Base
mainnet is a config default (`X402_EIP712_NAME`, `USD Coin`); if the check
script or a staging run reports `invalid_exact_evm_token_name_mismatch`, fix
it with a secret change, not a deploy.

### No `RESEND_API_KEY` means recovery emails go nowhere

Without the secret, `emailSenderFromEnv` falls back to a **log-only sender**:
the magic link is printed to the Worker log and no email is delivered. Fine
for testing (read the link out of `wrangler tail`), silently fatal for real
users who are locked out. Set it before you have users:

```bash
npx wrangler secret put RESEND_API_KEY
```

`EMAIL_FROM` defaults to `no-reply@basedagents.ai`, which must be a verified
sending domain in Resend or sends will 4xx.

### Adding a console origin means editing two lists

CORS (`ALLOWED_ORIGINS` in `packages/api/src/index.ts`) and WebAuthn origin
verification (`KEYRING_ORIGINS` in `wrangler.toml`) are **separate
allow-lists**. A new console origin must be added to both — CORS alone gets
you a console that loads and then fails every ceremony. Keep CORS on
exact-origin reflection with `credentials: true`; never wildcard it, or the
cookie becomes readable cross-origin.

### The SPA fallback is load-bearing for recovery links

Recovery emails link to `/recover#t=<token>`. `packages/console/public/_redirects`
(`/* /index.html 200`) makes deep links resolve on Cloudflare Pages. If the
console ever moves hosts, replicate the fallback or recovery links 404. The
token rides the URL **fragment** deliberately — fragments never reach the
server, so the token can't leak into request logs; don't "fix" it into a query
parameter.

### Rotation intentionally strands the daemon

After account recovery, the daemon's locally anchored passkeys are stale **by
design** — `based sync` will reject approvals signed by the new passkey until
the owner re-runs `based link` and confirms the new fingerprint. Don't
auto-refresh anchors from the control plane; the human confirmation is the
trust root (CONTROL_PLANE.md §2).

### CI `deploy-production` installs the wrong wrangler and can't read `wrangler.jsonc`

The `deploy-production` job (`.github/workflows/ci.yml`) uses
`cloudflare/wrangler-action@v3`, which runs `npx --no-install wrangler` to reuse
the repo's wrangler. But **wrangler isn't a dependency** in
`packages/api/package.json` (it's only ever invoked via `npx`), so that check
fails and the action falls back to its **default wrangler 3.90.0**. wrangler
3.90.0 **cannot parse `wrangler.jsonc`** (JSONC config support is newer), so it
sees no config, finds no `agent-registry` D1 binding, and dies with
`Couldn't find a D1 DB with the name or binding 'agent-registry' in wrangler.toml`.
This fails **after** the node/python/e2e gates go green — the run looks
"mostly passing" while nothing actually deploys. Fix: pin the action with
`wranglerVersion: "4.x"` on each of the three `wrangler-action` steps
(migrations, Worker deploy, console deploy), or add `wrangler` to
`packages/api` devDependencies so `--no-install` resolves the pinned 4.x. Until
then, deploy by hand with local wrangler 4.x (the commands in "Deploy order"
above, then the console Pages deploy).

---

## Extending the control plane

### The `ow_` / `ag_` identity split (this was a real bug)

The same Ed25519 vault key has two spellings: the daemon stores the owner
internally as `ag_<base58>` (it reuses the agent-identity type), but the
grant-approval contract signs the **`ow_<base58>`** form the console uses.
`applyApprovedGrant` must build the canonical with
`` `ow_${vault.owner.public_key_b58}` `` — using `vault.owner.agent_id`
reproduces the hash-mismatch bug that made the daemon reject every genuine
approval. Any new code that reconstructs a §2.1 canonical must use the `ow_`
form.

### Byte-parity or nothing

The daemon, control plane, and console each re-derive the same canonical JSON
and hash. `canonicalJsonStringify` **sorts keys recursively and preserves
`null`s** — if any side drops a null field or orders keys differently, hashes
disagree and verification fails closed. The shared source of truth is
`packages/keyring/src/control-actions.ts`; the api and console interop tests
exist to catch drift. Don't hand-roll a canonical anywhere.

### `label: null` in the canonical, `label` absent on the wire

`create_delegation`'s canonical uses `label ?? null`, but the endpoint's Zod
schema types label as `string | undefined` — **posting `label: null` fails
validation**. The console sends `label: null` in the *ceremony params* (so the
signed canonical matches) while *omitting* the field from the POST body. The
two sides differ deliberately; copy that pattern for new optional fields, or
better, avoid optional fields in signed statements.

### New ceremonies: three places to touch

Adding an action type means (1) the challenge-`purpose` union in
`ControlStore.CreateChallengeInput` if it needs a new purpose
(`'register' | 'login' | 'action' | 'recovery'` — it's a closed type),
(2) arming via `armActionChallenge` (challenge column **is** the action hash —
`store.createChallenge` generates random challenges and is wrong for actions),
and (3) client-side WYSIWYS in the console (`verifyArmedAction`). For
mutations with no daemon re-verification, that client-side check is the only
defense against a compromised control plane — never skip it because "the
server built the canonical anyway."

### No transactions — atomic conditional writes only

`DBAdapter` exposes `get/all/run/exec`, no transactions. Every security-
critical state change must be a **single conditional UPDATE checked via
`.changes === 1`** (challenge consume, counter bump, factor consume, nonce
record). A SELECT-then-INSERT here is a TOCTOU hole; the store's existing
methods are the pattern.

### Credential lookups must stay `status = 'active'`

`getCredentialByCredentialId` / `listCredentials` filter revoked passkeys.
That filter is what makes recovery rotation mean anything — a new query that
loads credentials without it lets a revoked passkey keep signing actions.

### WebAuthn `attestation: 'none'` verifies less than you think

Registration with attestation `none` (what we request) carries **no
signature** — the actual security checks are challenge, origin, and rpIdHash
inside `clientDataJSON`, plus challenge single-use. Tampering with the
attestation bytes may still parse and verify. Tests that want a registration
to *fail* must break origin/challenge, not the attestation blob.

### Migrations must be added to the test harnesses by hand

The control-plane test files each build an in-memory SQLite from explicit
migration files (`rawDb.exec(SQL_0023)` …). A new migration that existing
queries depend on must be added to **every** harness
(`routes.test.ts`, `store.test.ts`, `approvals.test.ts`, `recovery.test.ts`) —
forgetting this is 28 mysterious `no such column` failures at once.

### `node.ts` replays the FULL migration chain, one transaction per file

The local/E2E runner (`packages/api/src/node.ts`) applies every file in
`migrations/` from `0001` up, tracked in a `_migrations` table, each file
inside its own better-sqlite3 transaction — the same implicit per-migration
transaction D1 gives you, which is what makes `PRAGMA defer_foreign_keys` in a
table-rebuild migration work locally. The list is `runnerMigrationFiles()` in
`src/db/migration-list.ts`, shared with `board-schema.test.ts` /
`tasks-schema.test.ts`; nothing to register when you add a file. (The old
runner applied only `schema.sql` + `0021` + `≥0023`, so the local DB had no
`tasks` table and 0035 threw at E2E boot.) Consequences:

- A **dev DB created by the old runner** (`packages/api/data/registry.db`) is
  upgraded in place: `0001…0022` apply on top of it. A file whose `ALTER`
  hits an already-present column is tolerated and still recorded — but
  `exec` stops at that statement, so the rest of that file is skipped. Any
  other error (e.g. 0008's case-insensitive UNIQUE index on `agents.name`
  colliding with duplicate-named dev agents) aborts the boot. If in doubt,
  `rm -rf packages/api/data` and let it rebuild. E2E DBs are always fresh
  (`rm -rf .e2e-data` in `playwright.config.ts`).
- Migration files must not contain their own `BEGIN`/`COMMIT` — they would
  nest inside the runner's transaction.

### Table rebuilds keep the table NAME — `RENAME` fails under foreign keys (0035)

`tasks` is referenced by `submissions`, `delivery_receipts` and
`payment_events`. The 0027 idiom (`CREATE tasks_new` → `INSERT … SELECT` →
`DROP tasks` → `ALTER TABLE tasks_new RENAME TO tasks`) **fails at COMMIT**
with `FOREIGN KEY constraint failed` once any child row exists — even under
`PRAGMA defer_foreign_keys = ON`. What works, and what
`0035_task_review.sql` does: `PRAGMA defer_foreign_keys = ON; CREATE TABLE
tasks_backup AS SELECT * FROM tasks; DROP TABLE tasks; CREATE TABLE tasks
(new shape); INSERT INTO tasks … SELECT … FROM tasks_backup; DROP TABLE
tasks_backup;` — inside ONE transaction (D1's implicit one, or the runner's
wrap; in autocommit the `DROP` fails at its own commit). D1 documents
`PRAGMA defer_foreign_keys` as supported precisely for this
(developers.cloudflare.com/d1/sql-api/foreign-keys/). Apply to staging D1
first and check `PRAGMA foreign_key_check` is empty. And do NOT add 0035 to
the control-plane/MCP/board test harnesses listed below — they have no
`tasks` table and it would throw; `tasks-schema.test.ts` covers it.

### Cross-package type imports need TS project references

`packages/api` imports `@basedagents/keyring` (interop tests), whose types
resolve to the package's **built** `dist/`. On a clean checkout (CI),
typecheck runs before any build — without
`"references": [{ "path": "../keyring" }]` in the importer's tsconfig,
`tsc --build` fails with TS2307. Any new cross-workspace type dependency
needs the same reference.

### Lint doesn't see the React packages

`eslint.config.mjs` ignores `packages/web/**` and `packages/console/**`
(TSX needs its own plugin set). Their only static gate is `tsc`. Don't assume
a green `npm run lint` covered console changes.

---

## Releasing

### The version lives in ONE place — package.json

`src/version.ts` reads it at runtime (`createRequire('../package.json')`),
and the CLI/MCP `VERSION` constants import from there. Bump
`packages/keyring/package.json` and you're done. (It used to live in three
places and shipped lying about itself once — don't reintroduce a copy.)

### Publish the sdk with EVERY keyring publish — its version is the npx cache key

`npx basedagents@latest` re-resolves only the **sdk's** version. If that
version hasn't moved, npx reuses the cached tree wholesale — including
whatever keyring version was installed inside it back then. Keyring 0.6.3
shipped alone and every warm cache kept serving keyring 0.6.2 with no error
anywhere (field-hit 2026-07; SANDBOX_SPEC §2b has the full story). So every
keyring publish is a **pair**: bump the sdk a patch, raise its
`@basedagents/keyring` range to pin the new version, publish keyring first
(the sdk's `prepublishOnly` build needs it on the registry), then the sdk.

### Publish from anywhere, but with credentials

`prepublishOnly` runs the clean `build:dist` (test-free `tsconfig.build.json`),
so `npm publish` from a fresh checkout is safe. Verify with
`npm pack --dry-run` — expect `dist/`, `bin/`, `README.md`, `LICENSE`,
`package.json`, and **zero** `*.test.*` files.

### Publishing needs a token with *both* 2FA-bypass and the exact package in scope

The 403s npm throws during publish are two different failures that read alike:

- `Two-factor authentication or granular access token with bypass 2fa enabled
  is required` → the credential has no 2FA bypass. Pass `--otp=<code>`, or use a
  token with **"Bypass 2FA" enabled**.
- `You may not perform that action with these credentials` → the token
  authenticates fine (even as the package owner) but its **package scope
  doesn't include this package**.

The trap that cost us a dozen attempts: a granular token scoped to the
**`@basedagents`** scope covers `@basedagents/keyring` but **not** the unscoped
**`basedagents`** SDK package — scoped and unscoped names are separate grants.
And npm **cannot edit a granular token's package list after creation**; you must
generate a *new* token and paste the new string in (editing the old one changes
nothing). One token needs **both** attributes at once: Bypass 2FA **on** and
either **"All packages"** or an explicit list containing both the `@basedagents`
scope *and* the individual package `basedagents`, Read+write. A Classic
"Automation" token also works (full account access + bypasses 2FA) and sidesteps
per-package scoping entirely.

Tokens live in the repo-root `.env` (gitignored). Publish non-interactively with:

```bash
npm publish --workspace=<pkg> "--//registry.npmjs.org/:_authToken=$NPM_ACCESS_TOKEN"
```

The two published packages have **separate versions and separate owners of
truth**: `@basedagents/keyring` (`packages/keyring`) and `basedagents`
(`packages/sdk`) — bumping one does not bump the other.

### Stacked PRs don't retarget themselves

GitHub only retargets a stacked PR to `main` when its base **branch is
deleted** on merge. If the base branch survives, the PR silently keeps
targeting the stale branch — merging it then "lands" the work somewhere
nobody looks. Check the base before merging any stacked PR.
