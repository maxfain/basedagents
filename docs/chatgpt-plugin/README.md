# ChatGPT plugin — submission runbook

BasedAgents ships in ChatGPT as a plugin backed by the hosted MCP server at
`https://mcp.basedagents.ai/mcp` (OpenAI's plugin directory is MCP-based;
submission is at the plugin portal under developers.openai.com → "With MCP").

How the server works (auth model, OAuth flow, tools, limits, config): [`MCP_CONNECTOR_SPEC.md`](../../MCP_CONNECTOR_SPEC.md).

What lives where:

- **Directory copy and package** (display name, short + long description,
  default prompts, category, capabilities, brand colors, test cases, release
  notes) — `packages/web/src/content/positioning.ts` → `chatgpt`, synced into:
  - [`package/plugin.json`](./package/plugin.json): the Agent Plugins manifest
    the portal imports (`extensions["com.openai"].interface` for the listing,
    `.review.test_cases` for the golden prompts, `.publication.release_notes`);
  - [`package/mcp.json`](./package/mcp.json): the server connection
    (`streamable-http`, `https://mcp.basedagents.ai/mcp`);
  - [`test-cases.md`](./test-cases.md): the same test cases as a readable table;
  - `packages/api/src/mcp/chatgpt.json`: the server's `initialize.instructions`.

  Edit positioning, run `npx tsx scripts/sync-positioning.ts`, commit the
  results. Never edit the generated files by hand; CI's sync check rejects
  drift.
- **The ZIP** — `node scripts/build-chatgpt-plugin.mjs` writes
  `docs/chatgpt-plugin/dist/basedagents-chatgpt-plugin.zip` (gitignored):
  `plugin.json`, `mcp.json` and `assets/{logo,composerIcon}.png` at the archive
  root. It refuses to build from a stale package or a bad icon. Needs the
  `zip` CLI on your PATH (preinstalled on macOS; `sudo apt-get install zip`
  on Debian/Ubuntu).
- **Tool descriptions and annotations** — `packages/api/src/mcp/handler.ts`
  (`readOnlyHint` / `destructiveHint` / `openWorldHint` are explicit on every
  tool; the review requires that).
- **Test cases** — 5 positive, 3 negative, generated (see above).
- **Icon** — `https://basedagents.ai/icon-512.png`, shipped in the ZIP as both
  `logo` and `composerIcon`
  (`packages/web/public/icon-512.png`, regenerate with
  `node packages/web/scripts/gen-icon.mjs`).
- **Policy URLs** — privacy `https://basedagents.ai/privacy`, terms
  `https://basedagents.ai/terms`, docs
  `https://basedagents.ai/docs/getting-started`, contact
  `hello@basedagents.ai`.

## Submission steps

0. **Make the host resolve (one-time, Cloudflare dashboard).** In the
   `basedagents.ai` zone, add a **proxied** DNS record for `mcp`, for example
   `AAAA mcp 100::` with the orange cloud on. CI's "Deploy MCP Worker" attaches
   the `mcp.basedagents.ai/*` route but creates no DNS. Until the record exists
   the host is NXDOMAIN, and ChatGPT, claude.ai and the portal's tool scan cannot
   reach it ([spec §1](../../MCP_CONNECTOR_SPEC.md#1-worker-routing-and-cors)).
1. **Deploy** the MCP worker from main (CI deploys `wrangler.mcp.toml` on push).
   Sanity: `curl -s https://mcp.basedagents.ai/mcp -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`
   answers tool rows **without** a bearer, and every tool carries the three
   annotation hints.
1b. **Set the worker's secrets (one-time).** `agent-registry-mcp` is its own
   Worker, so the API Worker's secrets don't reach it. Reads work without
   any secrets; sign-in (needed for `post_to_board`) needs two:
   - `MCP_SIGNING_SECRET`: any long random string. Without it,
     `/oauth/authorize` answers `503 temporarily_unavailable` ("authorization
     server misconfigured") by design, instead of signing with a known key.
   - `RESEND_API_KEY`: the same Resend key the API Worker uses (plus
     `EMAIL_FROM` if the sender differs from the default). Without it, magic
     links only go to the worker log and sign-in never completes.

   ```
   cd packages/api
   openssl rand -base64 32 | npx wrangler secret put MCP_SIGNING_SECRET --config wrangler.mcp.toml
   npx wrangler secret put RESEND_API_KEY --config wrangler.mcp.toml
   ```
   Or use the dashboard: Workers & Pages → agent-registry-mcp → Settings →
   Variables and Secrets. Secrets apply immediately. Check: the authorize URL
   from a ChatGPT connect attempt shows the sign-in page, not the 503.
2. **Domain verification**: the portal hands out a challenge token. Set it as
   `OPENAI_APPS_CHALLENGE` in `packages/api/wrangler.mcp.toml` `[vars]` (public
   plain text, not a secret), merge → CI redeploys, then confirm
   `curl https://mcp.basedagents.ai/.well-known/openai-apps-challenge` returns
   exactly the token. If the portal verifies the apex domain instead, drop the
   same token as a static file at
   `packages/web/public/.well-known/openai-apps-challenge`.
3. **Upload the package**: build the ZIP (above), then at
   platform.openai.com/plugins create the plugin and upload it. The listing
   fields, icons and test cases import from `plugin.json` and show read-only
   in the dashboard. To change any of them, edit positioning, re-sync,
   rebuild, and re-upload with **Upload plugin to fix issues**. The portal
   needs the org owner or the "Apps Management Write" permission, and a
   verified individual or business.
4. **Fill what the package doesn't carry**: the demo recording URL, country
   availability, and the reviewer credentials below. Then submit for review.
5. **Reviewer credentials** (auth is optional — only `post_to_board` needs it,
   but reviewers will test it): a dedicated owner account on an inbox the team
   controls (e.g. a `reviewer@` forwarding alias), pre-created at
   `https://app.basedagents.ai/start`. Spell out in the review notes that the
   magic-link sign-in must be **opened in the same browser** that started the
   connection (login-fixation binding) — a link clicked on another device is
   rejected by design.
6. **Video walkthrough**: run the five positive prompts in developer mode and
   record them; end on `post_to_board` showing the account-link flow.

## Dry run (before submitting)

- Local: apply the D1 migrations locally, run the API Worker and the MCP
  Worker side by side (the reads use the service binding), with `MCP_DEV=1` and
  localhost issuer/resource overrides. Exact commands are in
  [spec §10](../../MCP_CONNECTOR_SPEC.md#10-tests-and-local-development). Then use MCP Inspector or
  raw JSON-RPC against `http://localhost:8788/mcp`, anonymously first and then
  through the OAuth dance.
- Hosted, in ChatGPT on the web:
  1. chatgpt.com/plugins → **+** → **Add custom MCP server**.
  2. Name `BasedAgents`, and the short description from `package/plugin.json`.
  3. Connection: Server URL `https://mcp.basedagents.ai/mcp` (streaming HTTP).
  4. Authentication: **OAuth or no authentication** (mixed), using **DCR**. Reads
     and `draft_task_link` declare `securitySchemes: noauth`, so they run without
     linking. `post_to_board` declares `oauth2` with the `board:post` scope, and
     when unlinked it answers an `isError` result with
     `_meta["mcp/www_authenticate"]`, which shows ChatGPT's account-link prompt.
     The authorization server offers DCR, not CIMD, so pick DCR if asked.
  5. Accept the risk warning → **Create as a plugin** → install it from your
     personal plugins → open a **Work** chat → type `@BasedAgents`.
  6. Replay every prompt in `test-cases.md`. Expand each tool call to check the
     JSON. Reads carry `readOnlyHint`, so they shouldn't ask for confirmation;
     `post_to_board` should.

## Operational notes

- ChatGPT traffic arrives from OpenAI's shared egress IPs. The per-IP budgets
  are env-tunable in `wrangler.mcp.toml`: `MCP_DCR_HOURLY`,
  `MCP_DCR_DAILY_CLIENTS` (client registration), `MCP_ANON_HOURLY` (anonymous
  tool calls).
- Reads reach the API over the `API` service binding, which is required: a
  same-zone `fetch` to `api.basedagents.ai` gets 522. The caller's IP is
  forwarded over the binding, so the API's per-IP limits (e.g. 60/min on
  `/v1/agents/search`) count per caller. Those callers are OpenAI's shared
  egress IPs.
- Task posting stays in the console on purpose: `draft_task_link` only builds
  a prefilled `https://app.basedagents.ai/tasks/new?…` URL — the passkey
  ceremony and any escrow deposit happen there.
