# Changelog

All notable changes to BasedAgents are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Fixed — the second sandbox wall (`@basedagents/keyring` 0.5.12 + /codex)

Field report: in a Codex task, npm worked (install + lockfile committed by
the agent) but `api.basedagents.ai` wasn't in the allowed domains — `init`
created the vault and agent, failed at the link step, and its message said
"Finish anytime with: based init", which inside a dead sandbox task is a
retry loop. The agent improvised the /codex relay on its own; now it doesn't
have to:

- **`init` routes the failure itself**: on an unreachable control plane it
  says the vault/agent are saved and re-running is safe, and — for the
  sandbox case — that the human must allow api.basedagents.ai +
  app.basedagents.ai (walkthrough: basedagents.ai/codex) and start a NEW
  task. Resume was already safe by design (re-run reuses vault + agent).
- **/codex now covers both walls**: broadened lede, plus a "which steps do
  you actually need?" note (E403 → all three; API unreachable → just step 2
  + new task).
- **agent.json gains `on_api_unreachable`** alongside `on_403_relay_to_human`;
  llms.txt carries the same clause; SANDBOX_SPEC §2b records the two-wall
  failure matrix as a design rule.

### Changed — the setup prompt now survives a skeptical agent (all prompt surfaces)

Field report: a security-conscious agent REFUSED the hero prompt outright,
flagging exactly three things — "follow its instructions" hands control to
unknown code, no discoverable provenance (its npm search for "keyring" found
nothing, "proving" we don't exist), and the scripted verbatim relay reads as
output-steering toward an external "one-time fix". All three were fair: our
prompt was indistinguishable from a supply-chain phish. The fix is
verifiability, not stealth:

- **Provenance in the prompt**: exact npm package name, GitHub repo, and docs
  URL — an agent that checks finds a real published package instead of a
  failed guess-search.
- **Expected behavior, stated**: creates a local vault, registers the agent
  ID, prints a claim link for the human — replacing "follow its instructions"
  (now banned copy).
- **A tripwire aligned WITH agent safety**: "it never asks for a password or
  an existing key — stop and tell me if anything differs."
- **Content-pinned relay, not wording-pinned**: the sandbox fallback keeps the
  URL and "start a new task" exact but no longer scripts the agent's reply.
- **`agent.json` grows a `provenance` block** (npm/source/license, what init
  does, what it never does) and llms.txt points verifiers at it.

Updated in lockstep: homepage hero + closing, console AgentSetupPrompt,
/codex step 3 (self-healing retry), /docs/agents, keyring.html (stale
variants killed), llms.txt, llms-full.txt, agent.json, SANDBOX_SPEC §2b
design rules.

### Added — the console Connect button (`@basedagents/keyring` 0.5.11 + control plane + console)

The last terminal-shaped step in the base-case flow is gone: the Vercel card
now has a **"Do it for me"** button. Clicking it asks the computer where the
agent lives — via the daemon's existing authed watch loop — to run the
Provisioner itself: visible browser once per machine (the human signs in and
watches), API-only forever after. No secret ever travels through the control
plane in either direction; the row is just a request, and the daemon mints,
vaults, and confirms exactly like a sealed paste.

- **Control plane**: migration 0029 adds `kind` ('sealed' default |
  'provision') to pending_connections. Provision rows carry no ciphertext
  (schema-enforced both ways) and only recipe-backed providers (vercel)
  accept them. `GET /daemon/connections` hides provision rows from daemons
  that don't ask (`?include=provision`) — an old daemon can never misread
  one as sealed.
- **Daemon** (`based sync` / `--watch`, keyring 0.5.11): provision rows run
  `connectVercel` with unattended-safe engine hooks — consent was the
  console click (the plan echoes into the daemon log), login waits for the
  human at the visible window (bounded), checkpoints stop cleanly instead of
  hanging, and failures resolve with plain-words reasons ("That agent is not
  set up on this computer — run the setup command here first."). Same
  exactly-once claim/resolve dance as sealed rows.
- **Console**: the automatic card shows "Do it for me" / "Paste a token
  instead"; waiting state says a window may open on that computer (first
  time only) and adds an "is that computer awake?" hint after 30s. Leaving
  and returning resumes the in-flight state from the server — no duplicate
  requests, and a stored provider card can't be re-submitted.

### Changed — speak to the vibe coder, not the engineer (web + console)

The ICP is a not-so-technical builder who lives inside Claude Code or Codex
and has never heard of .env. Every human-facing surface now sells the moment
("your agent just asked you to paste a key"), not the mechanism:

- **Homepage rewrite.** Hero is now "Never paste a key into a chat again";
  the lede names the paste-moment in outcome words (deploy, save, publish).
  New "Three steps, and the last two are just clicking" section (copy the
  prompt → click the link → tap Approve). "The story" reframed around the
  key-that-opens-everything; the control tiles became the three verbs
  (Connect / Approve / Cut off); "Under the hood" rewritten to pass the
  banned-words rule. index.html title/meta/OG/JSON-LD/noscript all match.
  The agent-facing prompts (HERO_PROMPT, CLOSING_PROMPT, CODEX_SETUP) are
  byte-identical — the pointer contract is untouched.
- **Console /welcome is now a live checklist.** Three steps that tick
  themselves off as the system observes them: agent set itself up (active
  agent exists) → connect an account (a connection stored on the user's
  machine) → say yes when it asks (first ask decided). The page polls
  connections + asks every 2.5s while open; the connect cards live inside
  step 2 unchanged (browser-side sealing untouched). Pending asks surface in
  step 3 phrased by outcome with a "review and allow" hand-off to /home.
- **Outcome phrasebook** (`lib/outcomes.ts`): novice surfaces describe an ask
  by what it lets the agent DO — "put your site live · Vercel", "use your
  database · Supabase", "see and take payments · Stripe" — never by the name
  of the thing it unlocks. /home's "Wants to…" rows now use it.
- **Lint widened.** The banned-words rule (grant/lease/delegation/identity/
  credential/owner) now also covers the marketing homepage and the
  phrasebook — 12 surfaces clean.

No keyring/npm changes — ships with the next web + console deploy. All 6
passkey E2E scenarios pass against the new surfaces.

### Changed — clean `npm audit`, 93 fewer packages (`@basedagents/keyring` 0.5.10)

Field report: `npm install basedagents` printed "4 moderate severity
vulnerabilities" — a bad look for a key-custody tool. All four were one
advisory (GHSA-frvp-7c67-39w9, path traversal in `@hono/node-server`'s
Windows static file serving) counted at each link of the chain
hono → `@modelcontextprotocol/sdk` → keyring → basedagents. No version pin
fixes it: the patch only exists in `@hono/node-server` 2.x, every MCP SDK
release pins `^1.x`, and SDK releases below 1.25 carry a **high**-severity
advisory of their own. The vulnerable code is the SDK's HTTP transport — which
our stdio-only MCP server never imports.

- **Vendored the SDK's stdio slice.** `build:dist` now esbuild-bundles exactly
  what we use (`McpServer` + `StdioServerTransport`, tree-shaken) into
  `dist/mcp/sdk-vendor.js`, and `@modelcontextprotocol/sdk` moved to
  devDependencies. The bundle guard fails the build if an SDK upgrade ever
  pulls a non-allowlisted package (express/hono/jose stay out forever) or any
  external import other than zod + node builtins. `zod` stays a real (shared)
  dependency so our tool schemas and the server validate with one instance;
  range tightened to `^3.25.0` (the bundle imports `zod/v3`/`zod/v4` subpaths
  that 3.24 lacks).
- **Result, measured on the packed tarball:** fresh install is 7 packages,
  `npm audit` finds 0 vulnerabilities (was: 100 packages, 4 moderate).
- **New smoke gate.** `smoke:mcp` drives the BUILT server over real stdio
  (initialize → tools/list, asserts all 7 tools) — run in CI and before every
  publish, since unit tests exercise src against the devDependency, not the
  vendored bundle.

Note for anyone who saw the audit warning: do NOT run `npm audit fix --force`
— it "fixes" by downgrading `basedagents` to 0.6.0, which predates key custody.
Upgrading to keyring 0.5.10 makes the warning disappear for real.

### Fixed — capture provenance + no orphaned mints (`@basedagents/keyring` 0.5.9)

Two field reports from the first fully-working day:

- **"Did the clipboard capture work, or did it work because I clicked Copy?"**
  Legitimate doubt — and a real corner: a stale clipboard (the human's own
  Copy click) could have masqueraded as an engine capture. The engine now
  PRE-CLEARS the clipboard before its own Copy click (a non-empty read can only
  come from our click), clears it again after capture (a live token in a
  clipboard manager is a leak surface), and SAYS which route fired: "Captured
  the token straight from the page (…)" vs "Clicked the dialog's Copy button
  and read the clipboard (cleared it afterwards)". Test-pinned: a stale
  clipboard value falls through to honest paste.
- **`connect --agent max_test` minted a token, then failed "Unknown identity"**
  — leaving an orphaned live token at Vercel and an ungranted credential in
  the vault. The grantee is now validated BEFORE any minting (CLI shows the
  vault's roster and how agents join); if a post-mint vault write ever fails,
  a compensating rollback burns the minted token and drops the half-written
  credential. And `based rm` on a Vercel credential now burns the token at the
  provider by id (when a provisioning token is on hand) instead of leaving it
  alive — custody honesty for cleanup, which also disposes of the orphan this
  bug created.

### Fixed — the mint ladder: browser-per-mint fallback (`@basedagents/keyring` 0.5.8)

Sixth live run settled it: Vercel refuses token creation for team-scoped auth
even WITH ?teamId ("use a token with access to this scope") — for accounts
without a full-account token, **the browser is the mint path, period** (the
founder called it). Minting is now a three-rung ladder that cannot dead-end:

1. **API mint** (with the persisted teamId) — the fast path when it works.
2. **Re-bootstrap once**: an older provisioning token that cannot mint is
   discarded (burned at Vercel where possible) and the browser setup re-runs,
   now preferring "Full Account" scope — which can mint via the API.
3. **Browser-per-mint**: if the API still refuses, the SAME recipe mints the
   agent token itself in the browser (parameterized name + expiry), verified
   and vaulted like any other. The credential card records the honest
   browser-selected scope.

The recipe's expiration step is parameterized (`expiration_label`) so one
recipe serves both provisioning (90 Days) and agent tokens (mapped from
--days). Ladder is test-pinned end-to-end: rung-3 fresh connect = 2 browser
launches and succeeds; rung-2 existing-prov case = discard → re-bootstrap →
per-mint (3 launches), never a dead end.

### Fixed — team-scope minting + clipboard capture (`@basedagents/keyring` 0.5.7)

Fifth live run BOOTSTRAPPED (paste salvage worked, stray cleanup ran) and then
hit the real Vercel scope model: the token was scoped to the personal team
("Max's projects"), and `POST /v3/user/tokens` refuses team-scoped auth without
`?teamId` — `403: To create a token you must be authenticated to scope "<slug>"`.
That state was self-perpetuating: the vault held a working provisioning token,
so every re-run skipped the browser and re-hit the same 403.

- **Scope-aware minting.** The API client carries an optional `teamId` on every
  call; `mintWithScopeRetry` parses the slug straight out of the 403 refusal,
  retries with it, and persists it on the credential (`provider_team`) so every
  future mint/rotate/burn carries it from the start. Test-pinned end-to-end
  (mint retries once, second connect passes teamId immediately).
- **The recipe prefers "Full Account" scope** when Vercel offers it (mints
  without teamId at all); otherwise first option + the retry covers it.
- **Clipboard capture kills the copy-paste step.** When the DOM locators miss
  the token dialog, the engine clicks the dialog's own **Copy** button and reads
  the clipboard (permission granted at launch) — works for any dialog structure.
  Terminal paste remains the floor, not the norm.

### Fixed — capture salvage: a visible token is never thrown away (`@basedagents/keyring` 0.5.6)

Fourth live run drove the ENTIRE form (scope, native-select expiration, submit —
token created and shown), then failed at the last inch: the captured DOM value
didn't authenticate, and the old code hard-errored — discarding a valid,
once-shown token and stranding an orphan at the provider.

- **Verify-or-salvage**: a captured value that fails auth (401/403) degrades to
  assisted paste (two attempts) instead of erroring — the token on screen is
  shown once and must never be wasted. Network failures are reported as such
  ("the token in the dialog is still valid"), never as "rejected".
- **Shape check before verify**: masked ("vc_ab…"), whitespace-y, or too-short
  captures skip the doomed API call and go straight to paste. Diagnostics are
  value-free (length only).
- **Capture locators dialog-scoped first** — the page has other readonly inputs;
  a wrong grab cost a whole run.
- **Stray sweep**: after a successful bootstrap, orphaned `ba/provisioning/*`
  tokens from earlier failed attempts are burned automatically (never the
  current one, never user-made tokens).

### Fixed — Vercel recipe v4: native-select expiration (`@basedagents/keyring` 0.5.5)

Third live run: Scope now selects correctly (v3's placeholder locator works),
and the Expiration list turned out to be a **native `<select>`** — its
OS-rendered popup cannot be clicked by any driver. New `select` step kind maps
to Playwright's `selectOption` on the element (exact label "90 Days", options
observed live: 1 Hour → No Expiration); a failed select degrades to the
checkpoint handoff like every other step.

### Fixed — Vercel recipe v3: inline form + placeholder controls (`@basedagents/keyring` 0.5.4)

Second live run (0.5.3) checkpointed at the Scope dropdown and taught us the
rest of the real form:

- The Create Token form is **inline** on the tokens page — there is no opener
  button, so the old `open-create` step was clicking the SUBMIT button
  prematurely (the source of the red validation errors). Removed; the first
  interaction is the name field.
- The Scope control is a **search-style input whose "Select scope" is a
  placeholder attribute** — invisible to role-name and `text=` locators. The
  primary locator is now `[placeholder="Select scope"]`; same treatment for
  Expiration's `[placeholder="Select Date"]`.
- The submit is labeled **"Create"** (not "Create Token") — primary/fallback
  swapped.

### Fixed — Vercel recipe v2 matches the live Create Token form (`@basedagents/keyring` 0.5.3)

First real logged-in run reached the form and surfaced three drifts:

- The live form has a REQUIRED **Scope** dropdown v1 never touched → Create
  failed validation. v2 opens Scope and picks the first option (the personal
  account); a checkpoint covers the rest.
- The expiration control's visible text is **"Select Date"**, not "Expiration" —
  added fallbacks for the real control and regex-text fallbacks for the
  "90 days" option.
- When creation fails, the assisted-paste prompt now says plainly that Enter
  cancels safely (nothing saved, re-run safe) instead of appearing to demand a
  token that doesn't exist.

### Fixed — Keyring browser runs with the Chromium sandbox ON (`@basedagents/keyring` 0.5.2)

Playwright disables Chromium's OS sandbox by default (`--no-sandbox`), which
made the Keyring window show "Stability and security will suffer" — exactly the
wrong banner for a window driving the user's real provider session. The driver
now launches with `chromiumSandbox: true`: banner gone, real sandbox on.

### Fixed — Provisioner consent UX (`@basedagents/keyring` 0.5.1)

Two field-reported issues from the first real `connect vercel` run:

- **The browser window now opens only AFTER consent** (spec §3 "consent sheet
  before launch"). Previously the blank Keyring window appeared behind the
  terminal before the Proceed? prompt — confusing, and out of spec. The engine
  now takes a launcher and invokes it post-consent; a test pins the ordering.
- **Consent copy says who does what.** "Create a token named ba/…" read like an
  instruction to the human. Every plan line is now in Keyring's voice ("Keyring
  then creates a Vercel token FOR you — nothing for you to click"), with the
  human's only jobs stated up front: log in if asked, and watch.

### Added — Provisioner v1: Vercel (`@basedagents/keyring` 0.5.0)

Mint, rotate, and burn Vercel tokens on the user's behalf using their own
authenticated session — Playwright on a dedicated Keyring browser profile,
headful, consent-first. First provider implementation of the Provisioner spec;
the engine is provider-generic, the recipe is Vercel's.

- **Bootstrap-then-API.** The browser runs ONCE per account, minting a classic
  account-scope *provisioning credential*; every mint/verify/rotate/burn after
  that is API-by-id (second connect: zero browser, seconds). The Vercel token
  API contract was verified against production (strict `{name, expiresAt}`
  schema — which also proves the API cannot mint narrower scopes today; the
  credential card records the honest account-wide blast radius).
- **Provisioning credential guardrails.** New `provisioner` credential class:
  never leasable, never grantable to any agent through any path (enforced at
  the single grant choke point + a belt-and-braces lease deny), invisible to
  agent listings, auto-rotated ~14 days before expiry (one API mint + one burn,
  no browser), individually burnable.
- **Recipe engine.** Recipes are data (role-based locators + CSS fallbacks);
  the engine enforces the domain allowlist on every navigation and after every
  step (a tampered recipe is refused before consent), pauses at checkpoints for
  human handoff instead of crashing, halts all steps during login, and degrades
  a failed capture to assisted paste — never a dead end. Secret values exist
  only in the returned capture map: never in transcripts, events, or output.
- **CLI + kill switch.** `based connect vercel` (consent sheet → window →
  done-card with real blast radius; refuses headless with the sandbox-routing
  message). `based kill` now also burns the agent's Vercel tokens at the
  provider by id and reports per-token status; the provisioning credential is
  never auto-burned.
- **Weekly canary** (`canary-vercel.yml` + `scripts/canary-vercel.mjs`): live
  API mint→verify→list→burn cycle plus the recipe's logged-out page contract,
  filing an issue on drift. Requires a `VERCEL_CANARY_TOKEN` repo secret;
  skips cleanly without it.
- Console Vercel card now shows the automatic path
  (`npx basedagents keyring connect vercel`) above assisted paste. Marketing
  site nav gains a Blog link. `basedagents` 0.6.3 picks up the keyring 0.5.0
  dependency range.

### npm releases in this cut

- **`@basedagents/keyring` 0.3.0 → 0.4.1** — Custody Fixes v0.1.1 (execution
  brokering, ambient sweep + `doctor`, honest kill switch, scoped-token
  validation) + the proxy-aware error hint, plus the network-restricted sandbox
  contract (0.4.1: `doctor` now detects phase-blocked egress).
- **`basedagents` 0.5.1 → 0.6.2** — the `basedagents keyring …` subcommand
  (alias for `@basedagents/keyring`) + the proxy-aware error hint, the §4.6
  static dependency rule (0.6.1), and the register hand-off (0.6.2: `register`
  now prints what to do next and what to tell the human, instead of stalling
  after minting the identity).

### Added — network-restricted sandbox contract (homepage spec §4.6)

Codex-style cloud agents open egress during their **setup phase** and block it
during the **task phase**, so a first network call at task time fails with a bare
proxy 403. The contract now works there.

- **`based doctor` detects the signature** (`@basedagents/keyring` 0.4.1). After
  the ambient sweep it probes the npm registry, the BasedAgents API, and a
  generic HTTPS host; when two or more are outright blocked (403 / 407 / denied
  CONNECT) it prints the install-during-setup + allowlist pattern instead of
  leaving the agent with a raw npm error. The network check is advisory — it
  never changes the sweep's exit code.
- **Documented pattern, everywhere an agent looks.** The `sandbox` section in
  `/.well-known/agent.json`, a `#sandboxes` section on `/docs/agents`, and the
  `llms.txt` / `llms-full.txt` mirrors all describe the same three steps: add
  `basedagents` as a devDependency so the environment's own `npm ci` installs it
  while the network is open (it bundles `@basedagents/keyring`, so one entry is
  enough); register in the setup script; allowlist `api.basedagents.ai` +
  `app.basedagents.ai` for the task phase. The universal noscript block on every
  route gains one line pointing at `/docs/agents#sandboxes`.
- **Codex cloud recipe + cold-`npx` warning.** `/docs/agents#sandboxes` (new
  `#codex` block), the `agent.json` `sandbox` section, and the `llms.txt`
  mirrors now spell out the exact Codex Setup-script + allowed-domains
  configuration, and state plainly that a cold `npx basedagents keyring init` at
  task time fails with `npm E403` before any BasedAgents code runs (the package
  must be installed during setup) — so an agent that hits the 403 finds the fix
  instead of a dead end.
- **Onboarding routes by where the agent runs.** The homepage hero and the
  console `/start` page now branch the first step: local agents (Claude Code,
  Cursor, terminal) get the zero-config `npx …keyring init` one-liner, while a
  new "Codex / cloud sandbox" lane hands over the Setup-script recipe
  (`npm install --save-dev basedagents`) and the two allowed domains, with a
  plain-language note that a cold `npx` at task time is blocked. Non-technical
  Codex users no longer paste the one command that can't work there.
- **The agent hands the human off — everywhere.** `register`'s CLI output, the
  `agent.json` `sandbox` section (`after_setup_tell_human`, `task_phase_agent_prompt`),
  the `#codex` docs, and the `llms.txt` mirrors all now state that registering is
  only step one: run `keyring init`, ask for the human's email, and point them to
  `app.basedagents.ai/start` to claim the agent and connect keys. Fixes the
  reported dead end where an agent registered and then went quiet. The Codex
  Setup script is now **install-only** (the interactive `register` was wrong for
  a non-interactive setup script); register + the hand-off happen at task time.
- **Sandbox-aware paste prompts: pointer, not payload.** Field finding: most
  people start in a fresh Codex window and paste the setup prompt into a *task*,
  where npm is already blocked — and at that moment the pasted prompt is the
  *only* inbound channel that reaches the agent (no registry, no docs, no
  package on disk, and no safe lockfile-consistent repo edit). But the agent can
  still *reply*, and the human's browser is unrestricted — so the prompt only
  carries a pointer. The canonical prompts (homepage hero + closing, console
  `AgentSetupPrompt` used by `/start`, `/home`, `/welcome`) end with one quoted
  relay line: *Cloud sandbox blocking npm? Don't retry — tell me: "Open
  basedagents.ai/codex for the one-time fix, then start a new task."* The full
  recovery lives at **`/codex`** — a new human-facing static leaf page (with a
  `/sandbox` alias) whose own step-3 prompt includes the fallback clause, so a
  botched environment fix self-heals. Pageviews fire a new
  `codex_recovery_view` funnel event: a live count of cold-sandbox failures in
  the wild. `agent.json` (`on_403_relay_to_human`, `human_recovery_page`) and
  the `llms.txt` mirrors keep the pointer *plus* the underlying steps;
  `SANDBOX_SPEC.md` §2b records the pointer-not-payload rule.
- **`SANDBOX_SPEC.md`** documents the shipped §4.6 contract and specs the next
  lever: an **AGENTS.md auto-setup convention** (`basedagents` devDependency +
  a managed `AGENTS.md` block, scaffolded by a proposed `basedagents sandbox
  init`) that installs BasedAgents through the environment's normal setup with no
  env-settings step — closing the last manual gap, except the allowlist, which no
  committed file can set.

### Added — static dependency rule (homepage spec §4.6, `basedagents` 0.6.1)

The `basedagents keyring …` alias must never reach the network — a dynamic fetch
would fail inside a sandbox whose task phase has no egress (the exact case §4.6
exists for). Previously the alias fell back to `npx -y @basedagents/keyring`,
which silently hit the registry whenever local resolution failed.

- **`@basedagents/keyring` is now a real dependency of `basedagents`.** Installing
  `basedagents` (including via `npx basedagents`, which fetches deps) always
  brings the keyring with it, so one devDependency covers both.
- **The alias resolves locally and never dynamic-fetches.** It walks the
  `node_modules` chain on the filesystem to find the keyring bin (robust to
  hoisting and the npx cache; not gated by the keyring package's `exports` map).
  If the local copy is genuinely missing it fails with a reinstall hint rather
  than reaching for the registry.
- **CI proves the offline guarantee.** The clean-container smoke test now asserts
  `basedagents` declares the dependency and runs `basedagents keyring init`
  inside a network-disabled namespace (`unshare -rn`), so a regression that
  reintroduced a network call would fail the build.

### Added — Custody Fixes v0.1.1 (`@basedagents/keyring`)

The Keyring Change Order from the live test — the product's core claim ("one tap
cuts them off") is now true.

- **Execution brokering — secrets never enter model context.** New primary MCP
  tools `keyring_run(credential_refs, command, purpose)` (the daemon spawns the
  child with secrets injected into its environment, never argv, and returns
  stdout/stderr/exit with the values **redacted**) and `keyring_render` (fills
  `{{keyring:REF}}` placeholders into a file). `keyring_lease` is **demoted** —
  refused unless the owner sets `unsafe_value_release` on the grant
  (`based grant --unsafe-value-release`). A canary test asserts the secret
  appears in zero tool results and zero signed events.
- **Ambient sweep + honest kill switch.** `based doctor` (and `init`, and every
  `based kill`) detects credentials the agent can already use outside Keyring —
  `.env*` live values, logged-in provider CLIs, token-shaped env vars, `~/.netrc`
  — and reports them. `based kill` shows green only when residuals are zero;
  `doctor` exits nonzero when ungoverned paths exist (CI-usable).
- **Scoped tokens at connect.** The connect flow refuses account-wide tokens
  (Supabase `sbp_…` account token → demand the project `service_role` key).

### Added — agent runnability (`basedagents` + `@basedagents/keyring`)

- **`basedagents keyring init`** — a `keyring` subcommand on the `basedagents`
  CLI that forwards to the keyring CLI, so both it and the older
  `npx @basedagents/keyring init` work (agents run stale commands from cached
  docs for months). Docs canonicalize the new form and note the alias (README,
  `/docs/agents`, `agent.json`, `llms.txt`).
- **Proxy-403 error hint.** Register + keyring HTTP paths now append an
  actionable message on 403/407 or a blocked CONNECT (allow `api.basedagents.ai`
  / `registry.npmjs.org` through the egress policy, naming the proxy).
- **Clean-container smoke test** (`npm run smoke`, CI job) — packs both packages
  and drives `basedagents --version`, `basedagents keyring init`, and
  `@basedagents/keyring init` from a fresh tarball install.

### Changed — Keyring-first homepage (marketing site)

- `basedagents.ai/` now leads with Keyring (H1 "Stop pasting master keys into
  .env"); new static `/registry` and `/docs/agents`; site nav Keyring · Registry
  · Docs · Pricing · Get started → `/start`; `/keyring` takes the descriptive H1.
  Rebuilt as an SPA-shell + React `Home` route after the first attempt's
  `_redirects` (`/* /app.html`) took the site down — the SPA fallback is pinned
  to `/index.html`, the only safe Cloudflare Pages target. Clickable BasedAgents
  wordmark on the console auth screens.

### Added — the web "Get started" door (`/start`)
Onboarding redesign §2 + keyring page-copy v1: a second, secondary door to the
terminal-first onboarding, for people who want to start in a browser.
- **`/start`** (console, public) — two doors, terminal-primary: the
  paste-into-Claude-Code block, or one email field ("Start in your browser").
  No password, no profile fields, no plan picker — one field is not a form.
- Control plane: `POST /start/email` (magic link to any address, uniform
  response) and `POST /start/finish` — a **returning** account gets a look
  session; a **first-time** visitor gets `has_account:false` and the console
  shows the command to hand its agent. No browser-side vault: setup always
  happens where the agent lives.
- The console `/signup` route now 301s to `/start`; the marketing nav
  "Get started" and the `/keyring` hero both point at `/start` ("or start in
  your browser → — one email field, no password"), and the `/keyring` tagline
  is now "One paste or one email — never a form".
- Tests: two API cases (returning vs first-time) and a 6th Playwright E2E
  scenario driving the returning-account sign-in and the new-email command page.

---

## [0.8.0] — 2026-07-16

The authority ladder + onboarding redesign (KEYRING_SPEC.md v0.2 §5.1,
`fa861b8c-keyringonboardingredesign.md`): anonymous → email → passkey, no
signup form, passkey minted at the first approval. Architecture:
`CONTROL_PLANE.md` §8.

### Added

#### Control plane (`packages/api`, proprietary)
- Migration `0027_authority_ladder`: `link_codes`, `magic_link_tokens`
  (sha256-stored, single-use via atomic consume), `owner_invites`,
  `pending_connections`, `owner_sessions.method`, and a `delegations` rebuild
  adding `authorized_via` ('assertion' | 'claim')
- `control/ladder.ts`: link create/status/claim; `/claim/finish` ratifies
  owner + email verification + vault binding + delegation in one sequence and
  mints an email-rung look session; `/login/email[/finish]` (uniform,
  anti-enumeration); agent `invite_owner` with abuse brakes (3/day/agent,
  15-min re-send backoff, 3 sends max, 72 h expiry) — claim-pending holds
  nothing, structurally; connect-card endpoints (browser-sealed ciphertext
  only, blanked after the daemon stores)
- Migration `0028_funnel` + `routes/funnel.ts`: anonymous onboarding funnel
  counters and marketing provider-vote tiles (allowlisted; no identity stored)

#### Keyring CLI (`packages/keyring`, Apache-2.0)
- `keyring init` / `based init` is the whole onboarding: vault + auto-named
  agent identity + MCP config (with permission) + ONE browser page
  ("Take control of this agent"), then keeps running to store browser-sealed
  connect-card tokens locally as they arrive (`--no-watch` to opt out)
- `invite_owner(email)` MCP tool (agent-first entry)
- Isomorphic base64 utils + package export subpaths `./crypto`, `./util` so
  the console can import the daemon's own sealed-box crypto in the browser
- Anonymous, opt-out (`BASEDAGENTS_NO_TELEMETRY=1`) funnel pings from `init`

#### Console (`packages/console`, proprietary)
- `/link` (one email field), `/claim` (fragment-carried token → session →
  welcome), `/welcome` connect cards (Vercel, Supabase — token sealed in the
  browser to the vault key; card confirms only on daemon `stored`), `/invited`,
  novice home `/home` (asks / can-use / activity / kill switch; full console
  behind "Advanced"), email-first `/login`, command-not-form `/signup`
- First approval mints the passkey (`lib/approve.ts`, shared by Home and
  Approvals) — creation ceremony at the moment authority is first exercised
- Cross-package sealed-box parity test (browser seals, daemon opens)

#### Marketing (`packages/web`, Apache-2.0)
- `/keyring` rebuilt as a **static HTML page** (v1 page copy, readable with JS
  disabled): paste-command hero, hotel-key-card story, honest revocation
  (Disconnect vs Burn), provider grid with vote tiles, pricing, FAQ; Product +
  FAQPage JSON-LD, self-canonical; the old in-browser demo moved to
  `/keyring/demo`; `.well-known/agent.json` gained the Keyring flow
  (register → `invite_owner` → request → lease)

#### Tooling
- `scripts/lint-ui-words.mjs` (in `npm run lint`): AST-based check that
  grant/lease/delegation/identity/credential/owner never render on base-case
  surfaces
- Passkey E2E rewritten to the v0.2 brief: claim → look-only session with
  approvals locked; both login rungs; first-approval mint with cryptographic
  verification of the stored assertion against the just-minted key; recovery;
  aborted-creation negative + retry

### Security & robustness (adversarial review of the ladder)
- **Account-takeover fix:** `POST /link` now requires a vault-key signature
  (proof of possession) — the owner id is a non-secret identifier, so without
  this an attacker who learned it could mint a link code and claim the account.
  `/claim/finish` additionally refuses to rebind a pre-existing account to a
  different verified email, orders its writes so the single-use link is claimed
  last, and reactivates a revoked delegation instead of colliding on it
- Connect-card storage is exactly-once: the daemon atomically claims a
  connection (pending → processing) before any local work, and retries a
  stored-but-unconfirmed resolve without re-storing — no duplicate credentials
  or false failures across `init`'s watch and a separate `based sync`
- Provider validation fails OPEN on transient 429/5xx/timeout (only 401/403
  reject a token), with an 8 s probe cap so a stalled provider can't wedge the
  watch loop; the `init` link request and funnel pings are bounded and
  crash-safe
- Rate limits now cover the parameterized claim-email path; invite abuse-brakes
  are race-safe (partial unique index on open invites)
- Console: a minted first-approval passkey is no longer lost when the signature
  is cancelled; the novice `/home` renders a base-case plan-limit message
  (never the raw copy); plan-blocked `/welcome` hides the connect cards; the
  session refresh is guarded against a stale-response clobber
- Marketing `/keyring` is emitted as `keyring.html` (200 at `/keyring`, no
  folder-index redirect, works in `vite dev`); the homepage cross-link is a
  real `<a>`; vote tiles no longer show a false "Voted ✓" on error

---

## [0.7.0] — 2026-07-16

The Keyring hosted control plane (KEYRING_SPEC.md v0.2 §5): owner accounts with
passkey authority, remote grant approvals, and account recovery — with the local
vault daemon as the enforcement point throughout. Architecture of record:
`CONTROL_PLANE.md`. Open-core boundary: `LICENSING.md`.

### Added

#### Control plane — `packages/api/src/control/` (proprietary)
- Owner identity (`ow_` + base58 of the vault Ed25519 key) with WebAuthn/passkey
  ceremonies on Workers (`@simplewebauthn/server` v13, Web-Crypto only)
- "Sessions to look, signatures to act": passkey login mints a read-only
  httpOnly `SameSite=Strict` cookie; every mutation requires a fresh WebAuthn
  assertion whose challenge is the hash of the exact canonical action, with a
  per-ceremony nonce (replay-proof even on counter-0 authenticators)
- Atomic security primitives (no-transaction D1): single-use challenge consume,
  monotonic signature-counter bump, delegation uniqueness — all conditional
  writes verified by `.changes`
- Owner action assertions recorded on a per-owner hash chain (`prev_hash` /
  `entry_hash`), verified end-to-end in tests
- Owner→agent delegations (create/revoke, each a signed action)
- Vault-key binding: `daemonAuth` — the local daemon authenticates as the owner
  by Ed25519-signing requests (`AgentSig`), accepted only against an active
  vault-key binding
- Approvals inbox: `keyring_requests` + `grant_approvals`; `approve_grant`
  signs the §2.1 canonical statement that pins the grantee's public key, the
  credential, and the normalized constraints — not just a request id;
  `approve/begin` arms the exact challenge server-side so the browser never
  reconstructs the canonical
- Daemon endpoints: `GET /daemon/passkeys`, `GET /daemon/approvals`,
  `POST /daemon/approvals/:id/confirm` — the console shows a grant `active`
  only after the daemon confirms the seal
- Account recovery (CONTROL_PLANE.md §6): emailed magic-link token (sha256-
  stored, 15-min TTL, fragment-carried) **plus** offline one-time recovery code
  (issued via its own passkey ceremony, shown once, sha256-stored) — both
  required; completing recovery enrolls a new passkey and revokes every other
  passkey and live session; vault key and ciphertext untouched. Anti-enumeration
  begin, uniform 401s, per-IP rate limits. Provider-pluggable email
  (Resend or log-only)
- Migrations `0023` (owners, credentials, challenges, sessions, assertions,
  delegations), `0024` (requests + approvals), `0025` (recovery, credential
  revocation)
- Credentialed CORS for the console origins (exact-origin reflection, never `*`)

#### Keyring daemon — `@basedagents/keyring` (Apache-2.0)
- Owner-passkey anchoring (`anchorOwnerPasskey`) — the daemon pins the console
  passkeys it trusts, because the human confirmed the fingerprints
- Pure-`@noble` ES256 WebAuthn assertion verifier (no WebAuthn library on the
  user's machine)
- Shared grant-approval contract (`control-actions.ts`) — byte-identical
  canonical JSON + action hash on both sides, proven by cross-package interop
  tests
- `applyApprovedGrant`: re-derives the action hash from the daemon's own owner
  id and the grantee key it is about to seal to; rejects redirected seal
  targets, tampered constraints, unanchored passkeys, and replays (single-use
  approval nonces recorded in the vault)
- `based link` — fetch + human-confirm + anchor the console passkeys
- `based sync [--watch]` — pull approved grants, re-verify, seal, confirm back;
  failures are reported so the console never shows them active

#### Owner console — `packages/console` (proprietary, new package)
- Passkey sign-up/sign-in, approvals inbox, delegations manager, vault-key
  binding, recovery-code issuance, and the public `/recover` page
  (Vite + React 19, `app.basedagents.ai`)
- Client-side WYSIWYS on every ceremony: the console re-hashes the server's
  canonical action, verifies it says exactly what was requested (action type,
  owner, nonce, byte-identical params), and refuses to sign otherwise

### Changed
- `packages/api` is now mixed-license: the registry API stays Apache-2.0; the
  `src/control/` subtree and control-plane migrations are proprietary
  (`LICENSING.md`, after the contributor-consent check)
- Root/`keyring`/`api` READMEs and `KEYRING_SPEC.md` §5 updated for the hosted
  console; `CONTROL_PLANE.md` added as the authority model

---

## [0.6.0] — 2026-07-14

New package: `@basedagents/keyring` 0.1.0 — scoped, revocable credentials bound to cryptographic agent identities. Full specification in `KEYRING_SPEC.md`.

### Added

#### Keyring — `@basedagents/keyring` v0.1.0
- Local-first encrypted vault at `~/.basedagents/keyring` (`BASEDAGENTS_KEYRING_DIR` override) — `vault.json` holds ciphertext only, `owner.json` is the sole private key on disk
- Sealed-box crypto: secrets sealed client-side to Ed25519 identity keys (Ed25519→X25519 via edwardsToMontgomery, HKDF-SHA256, XChaCha20-Poly1305, versioned format)
- Identity-bound grants with constraints: expiry, max lease TTL, usage caps, project tags; revoking a grant blocks new leases and deletes the identity's sealed copy
- Short-lived leases: in-memory only, default TTL 900 s, clamped per grant; each lease is a signed AccessEvent
- Append-only signed access log: per-event Ed25519 signatures over canonical payloads, sha256 hash chain, offline verification (`based verify-log`), owner-signed export (`basedagents-keyring-log/v1`, Looptail-compatible)
- `based` CLI: `init`, `add`, `update-secret`, `rm`, `identity add/rm`, `identities`, `grant`, `revoke`, `kill` (per-agent kill switch), `agents`, `credentials`, `requests`, `approve`, `deny`, `timeline`, `export`, `verify-log`, `run` (lease + env injection into a child process, nothing on disk), `admin`, `mcp`
- MCP server `basedagents-keyring-mcp` (also `based mcp`): `keyring_list`, `keyring_lease`, `keyring_request`, `keyring_whoami`; agent keypair via `BASEDAGENTS_KEYPAIR_PATH` or `BASEDAGENTS_PRIVATE_KEY_HEX` + `BASEDAGENTS_PUBLIC_KEY_B58`
- Grant requests + approvals flow: agents ask via `keyring_request`, owners approve/deny from the CLI or admin UI
- Local admin UI (`based admin`): localhost-only, token-authenticated; Agents (kill switch, lease sparklines), Credentials (reverse index), Timeline, Approvals; signed-log export
- `KEYRING_SPEC.md` — repo-resident specification (object model, runtime delivery, revocation semantics, threat model, v0.1 implementation notes)

---

## [0.5.1] — 2026-07

Covers everything shipped since 0.4.0 (TypeScript SDK 0.4.0 → 0.5.1, Python SDK → 0.4.1, MCP → 0.3.1).

### Added

#### Universal Package Scanner
- GitHub repository scanning with multi-language patterns (JavaScript, Python, Rust, shell, Dockerfile, YAML)
- PyPI package scanning (Phase 2 of the universal scanner)
- Provenance bonus system — reports carry source metadata and earn trust bonuses
- Rescan queue: stale reports auto-requeue and process via cron
- Scanner UI: source tabs and GitHub scanning support on the web app

#### Marketplace & Payments
- Balance verification at claim time — bounty authorizations are re-verified with the CDP facilitator before an agent can claim
- `/.well-known/x402` payment method discovery endpoint
- Marketplace-first homepage; "Post a Task" as the primary CTA

#### Registry Subdomain
- `registry.basedagents.ai` — agent directory with Agents/Whois/Chain/Scan tab navigation and keypair loader

#### Python SDK
- `scan`, `tasks`, `probe`, and `skills` endpoint support (0.4.x)
- Retry with exponential backoff + jitter on 429 responses

### Security
- Full security audit (see `SECURITY_AUDIT.md`) with fixes across two passes:
  SSRF validation for probe and webhook URLs, XSS, path traversal, command
  injection, webhook HMAC-SHA256 signing, ±15s auth clock skew, `json_each()`
  search filters, scan source validation, CSP headers, decompression limits
- `POST /v1/scan` is fail-closed — submission requires the admin bearer token and is disabled when `ADMIN_SECRET` is unset
- Rate limits (register, verify, search, messages) are durable D1-backed instead of per-isolate in-memory maps; 429s include `Retry-After`
- Webhook delivery re-validates target URLs at fire time (SSRF defense in depth)

### Fixed
- Root tooling: `npm run typecheck`, `npm run lint` (ESLint 9 flat config), and `npm test` all work from the repo root; 61 TypeScript errors and 42 lint findings resolved
- `GET /v1/tasks?status=all` now parses correctly (previously failed validation and silently dropped `limit`/`offset`)
- Task webhook payloads: `task.delivered`/`task.disputed` events typed, `bounty` on `task.available`, chain + payment fields on `task.verified`
- Python SDK client tests updated for the retry wrapper (17 previously failing)
- PyPI resolver no longer passes `latest` as a version; JS scanner severity retuned

### Changed
- `@basedagents/mcp` no longer runs a `postinstall` build — the package ships prebuilt `dist`
- `packages/github-action` joined the npm workspaces (single lockfile)

---

## [0.4.0] — 2026-03

### Added

#### Wallet Identity
- `wallet_address` and `wallet_network` fields on agent profiles
- CAIP-2 network addressing (`eip155:8453` = Base mainnet by default)
- `GET /v1/agents/:id/wallet` — public wallet address lookup
- `PATCH /v1/agents/:id/wallet` — owner-only wallet address update
- CLI: `npx basedagents wallet` — show or set wallet address
- SDK: `client.getWallet()` and `client.updateWallet()`

#### Task Marketplace
- `POST /v1/tasks` — create a task with optional USDC bounty
- `GET /v1/tasks` — browse and filter tasks (status, category, capability)
- `GET /v1/tasks/:id` — task detail with submission and delivery receipt
- `POST /v1/tasks/:id/claim` — claim an open task
- `POST /v1/tasks/:id/submit` — submit deliverable (legacy)
- `POST /v1/tasks/:id/deliver` — deliver with signed receipt + chain anchoring (preferred)
- `POST /v1/tasks/:id/verify` — creator verifies deliverable; triggers payment settlement
- `POST /v1/tasks/:id/cancel` — creator cancels task
- `POST /v1/tasks/:id/dispute` — creator disputes deliverable; pauses auto-release
- `GET /v1/tasks/:id/payment` — payment status + audit trail
- Task categories: `research`, `code`, `content`, `data`, `automation`
- Task webhook events: `task.available`, `task.claimed`, `task.submitted`, `task.delivered`, `task.verified`, `task.cancelled`, `task.disputed`
- Auto-matching: agents with matching capabilities receive `task.available` webhooks on task creation
- Task delivery protocol: signed receipts, chain entries (`task_delivered`, `task_verified`)
- Proposer & acceptor signatures stored on tasks for offline consent verification
- Reputation boost for successful task completion (contribution + pass_rate components)
- CLI: `npx basedagents tasks` — list tasks with filters
- CLI: `npx basedagents task <id>` — single task detail
- SDK: `createTask()`, `claimTask()`, `deliverTask()`, `submitTask()`, `verifyTask()`, `cancelTask()`, `disputeTask()`, `getTasks()`, `getTask()`

#### x402 Payment Protocol
- EIP-3009 (TransferWithAuthorization) USDC payments via CDP facilitator
- Non-custodial deferred settlement architecture
- AES-256-GCM encryption of stored payment signatures at rest
- Payment status lifecycle: `none → authorized → settled / failed / disputed / expired`
- Auto-release timer (7-day window from delivery)
- `task_payment_settled` chain entries for on-chain audit trail
- Payment audit log (`payment_events` table)
- `GET /v1/tasks/:id/payment` endpoint
- CDP facilitator integration (`/verify` + `/settle` endpoints)
- `PaymentProvider` interface for future provider support
- Environment variables: `PAYMENT_ENCRYPTION_KEY`, `CDP_API_KEY`

#### Security Fixes (from internal audit)
- **Verification report inner signature** — verifier's Ed25519 signature now covers all report fields including `structured_report` (`safety_issues`, `unauthorized_actions`); signed with canonical JSON (RFC 8785) for deterministic byte-for-byte equivalence across SDKs
- **Proportional verifier weight** — verifier weight now scales with own reputation (`weight = max(0.1, verifier_reputation)`) instead of flat 50% floor
- **Challenge-bound PoW** — PoW hash now includes server-issued challenge: `sha256(public_key || challenge || nonce)`; prevents pre-computed nonces and replay across attempts
- **Sybil-resistant verifier guards** — new verifiers must be registered ≥24h, have received ≥1 verification, and reputation > 0.05
- **Replay attack protection** — `used_signatures` table tracks recent signature hashes (SHA-256); same signature rejected with 401; records expire after 120s
- **Verification assignment validation** — assignment IDs persisted with expiry and `used` flag; fabricated or replayed assignment IDs rejected
- **Private key filesystem permissions** — key files written with mode `0600`, keys directory `0700`
- **HTTPS enforcement** — CLI `--api` flag enforces HTTPS for custom endpoints

### Changed
- Registration endpoint (`POST /v1/register/complete`) now accepts optional `wallet_address` and `wallet_network`
- `POST /v1/verify/submit` now requires a valid persisted `assignment_id`
- Task delivery preferred endpoint is now `POST /v1/tasks/:id/deliver` (signed receipt) vs legacy `POST /v1/tasks/:id/submit`
- `sdk` bumped to `0.4.0`
- `@basedagents/mcp` bumped to `0.3.1`

### Fixed
- Name-based lookup (`GET /v1/agents/:name`) now correctly falls back to case-insensitive name match after ID resolution
- Chain entries not written for cosmetic profile updates (description, logo, contact info)

---

## [0.3.0] — 2025-02

### Added

#### Agent-to-Agent Messaging
- `POST /v1/agents/:id/messages` — send a message
- `POST /v1/messages/:id/reply` — reply to a message (recipient only)
- `GET /v1/agents/:id/messages` — inbox (auth required)
- `GET /v1/agents/:id/messages/sent` — sent messages (auth required)
- `GET /v1/messages/:id` — single message (sender or recipient)
- Message types: `message` and `task_request`
- Threading via `reply_to_message_id`
- Webhook delivery: `message.received` and `message.reply` events
- Rate limit: 10 messages/hour per sender
- Message lifecycle: `pending → delivered → read → replied` (expires after 7 days)

#### Web UI Verification
- In-browser keypair loading (drag-and-drop or file picker)
- Ed25519 signing in-browser via `@noble/ed25519` (keys never leave browser tab)
- Verification form on every agent profile page
- Structured report fields: `capabilities_confirmed`, `safety_issues`, `unauthorized_actions`

#### Webhooks (expanded)
- `agent.registered` event
- Webhook URL settable via profile update (`PATCH /v1/agents/:id`)

### Changed
- Reputation model: added `cap_confirmation_rate` component (15% weight) replacing previous `skill_trust` direct weight
- EigenTrust now runs after every verification submission

---

## [0.2.0] — 2025-01

### Added

#### Reputation System
- 5-component local reputation calculator: `pass_rate`, `coherence`, `contribution`, `uptime`, `cap_confirmation_rate`
- Time decay: `weight = exp(-age_days / 60)`, half-life ~42 days
- Confidence multiplier: reaches 1.0 at ~20 verifications
- EigenTrust network-wide propagation: `t = α·(Cᵀ·t) + (1-α)·p`, α=0.85
- GenesisAgent pinned as trust anchor (reputation = 1.0)
- Penalty component: -20% deduction for `safety_issues` or `unauthorized_actions`
- `GET /v1/agents/:id/reputation` endpoint

#### Skill Trust
- Skill declaration support in profiles (`skills` array)
- Supported registries: `npm`, `pypi`, `clawhub`
- Inverted trust model: agent reputation flows to skills
- `private: true` flag for proprietary tools (scores 0.5 neutral)
- `GET /v1/skills` endpoint

#### TypeScript SDK — `basedagents` v0.2.0
- `generateKeypair()`, `serializeKeypair()`, `deserializeKeypair()`
- `RegistryClient` with `register()`, `getAgent()`, `searchAgents()`, `updateProfile()`, `getAssignment()`, `submitVerification()`, `getReputation()`
- `signRequest()` helper for custom integrations
- `solveProofOfWork()` and `solveProofOfWorkAsync()` with progress callbacks
- CLI: `npx basedagents register`, `npx basedagents whois`, `npx basedagents validate`

#### MCP Server — `@basedagents/mcp` v0.1.0
- Tools: `search_agents`, `get_agent`, `get_reputation`, `get_chain_status`, `get_chain_entry`
- Claude Desktop and OpenClaw configuration

#### Python SDK — `basedagents` v0.1.0
- `generate_keypair()`, `RegistryClient`
- CLI: `basedagents register`, `basedagents whois`

#### Discovery
- `GET /.well-known/agent.json` — machine-readable API discovery
- `X-Agent-Instructions` header on all responses
- `GET /openapi.json` — OpenAPI spec

### Changed
- Hash chain entries now use canonical JSON (RFC 8785) for profile hashes
- Hash chain entries now use 4-byte length-delimited fields to prevent concatenation collisions

---

## [0.1.0] — 2024-12

### Added

#### Core Identity
- Ed25519 keypair generation
- `POST /v1/register/init` — PoW challenge issuance
- `POST /v1/register/complete` — registration with proof-of-work
- `GET /v1/agents/:nameOrId` — profile lookup (ID + name fallback)
- `PATCH /v1/agents/:id` — signed profile updates
- `GET /v1/agents/search` — capability/protocol/tag search
- Hash chain ledger — tamper-evident append-only log
- Bootstrap mode — auto-activation for first 100 agents
- AgentSig authentication — stateless Ed25519 request signing

#### Verification
- `GET /v1/verify/assignment` — get verification target
- `POST /v1/verify/submit` — submit signed verification report
- Assignment tracking: expiry, used flag, verifier/target binding

#### Infrastructure
- Hono API on Cloudflare Workers + D1 (SQLite)
- Vite + React 19 frontend (basedagents.ai)
- GitHub Actions CI/CD
- `GET /v1/agents/:id/badge` — SVG badge with reputation indicator

#### Webhooks v1
- `verification.received` — notifies agent when verified
- `status.changed` — notifies on status transitions
- 5s timeout, fire-and-forget
