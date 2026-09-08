# Deploy bootstrap — the one-time list

After this checklist, **merge-to-`main` deploys everything** (D1 migrations →
API Worker → console Pages) and PRs get console preview deploys with the URL
commented — zero manual dashboard steps. Everything here is done exactly once
per environment; day-to-day deploys are CI's job (`.github/workflows/ci.yml`).

## 1. Cloudflare API token + account id (CI credentials)

1. Cloudflare dashboard → My Profile → **API Tokens** → Create Token (a
   user-owned token; an account-owned "Account API Token" also works — the CI
   guard verifies both kinds) with:
   - **Account · Workers Scripts · Edit** (deploy the API Worker)
   - **Account · Cloudflare Pages · Edit** (deploy the console + previews)
   - **Account · D1 · Edit** (apply migrations)
   - **Zone · Workers Routes · Edit**, scoped to `basedagents.ai` — the Worker
     serves api.basedagents.ai via a zone route, and `wrangler deploy`
     re-asserts route config on every deploy; without this the deploy fails
     AFTER uploading the script (`/zones/…/workers/routes` → auth error 10000)
2. GitHub repo → Settings → Secrets and variables → Actions → add:
   - `CLOUDFLARE_API_TOKEN` — the token from step 1
   - `CLOUDFLARE_ACCOUNT_ID` — dashboard → Workers & Pages → right sidebar
3. (Recommended) Settings → Environments → create `production` — the deploy
   job targets it, so you can add required reviewers or restrict it to `main`.

## 2. Cloudflare Pages project (console)

```bash
npm run build --workspace=packages/console
npx wrangler pages deploy packages/console/dist --project-name basedagents-console --branch main
```

The first deploy creates the project. Then attach the custom domain:
dashboard → Workers & Pages → basedagents-console → **Custom domains** →
`app.basedagents.ai` (Cloudflare auto-creates the proxied CNAME since the
zone is in the same account; TLS activates in minutes).

> Passkeys only work on `app.basedagents.ai` — `*.pages.dev` previews load
> but every WebAuthn ceremony is rejected (RP ID is `basedagents.ai`). This
> is by design; see `GOTCHAS.md`.

## 3. D1 migration bookkeeping (check BEFORE the first CI deploy)

CI runs `wrangler d1 migrations apply agent-registry --remote`, which applies
every migration **its `d1_migrations` bookkeeping table** hasn't seen. If the
database predates wrangler-managed migrations, that bookkeeping may be empty
while the schema already exists — a blind apply would re-run old migrations
(the `ALTER TABLE`s are not idempotent). Verify once:

```bash
cd packages/api
npx wrangler d1 migrations list agent-registry --remote
```

- Lists only migrations you know are genuinely unapplied → you're done.
- Lists migrations whose schema **already exists** → backfill the bookkeeping
  for exactly those files, then re-check:

```bash
npx wrangler d1 execute agent-registry --remote \
  --command "INSERT INTO d1_migrations (name, applied_at) VALUES ('0001_init.sql', CURRENT_TIMESTAMP);"  # repeat per already-applied file
```

## 4. Stripe (billing)

1. Stripe dashboard (test mode first) → Products: create **Keyring Pro** with
   two prices — $10/month (`keyring_pro_monthly`) and $96/year
   (`keyring_pro_yearly`). Copy both price ids.
2. Put the price ids in `packages/api/wrangler.toml` vars
   (`STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_YEARLY`) — they are config,
   not secrets.
3. Developers → Webhooks → Add endpoint:
   - URL: `https://api.basedagents.ai/v1/stripe/webhook`
   - Events: `checkout.session.completed`,
     `customer.subscription.updated`, `customer.subscription.deleted`
   - Copy the **signing secret** (`whsec_…`).

## 5. Runtime secrets (scripted)

```bash
RESEND_API_KEY=re_...            # optional — without it, recovery emails go to the log-only sender
STRIPE_SECRET_KEY=sk_live_...    # optional — without it, billing endpoints answer 503
STRIPE_WEBHOOK_SECRET=whsec_... \
  ./scripts/put-secrets.sh
```

Notes:
- There is **no `SESSION_SECRET`** in this deployment: sessions are random
  256-bit tokens stored hashed in D1 (`owner_sessions.token_hash`) — no
  signing key exists to configure.
- Resend requires `basedagents.ai` verified as a sending domain (or set
  `EMAIL_FROM` to a verified one).
- Staging: repeat with test-mode Stripe keys and `--env staging`
  (`./scripts/put-secrets.sh --env staging`); staging uses its own D1
  database per `wrangler.toml`.

## 6. Task payments (x402) — optional, off by default

Task bounties fail closed: without this section the API answers
`503 payments_unavailable` to any bounty and `GET /v1/status` reports
`payments: "disabled"`. Free tasks work regardless. BasedAgents never holds
funds — the buyer signs an EIP-3009 USDC transfer to the deliverer's wallet
when accepting a delivery and the Coinbase CDP facilitator settles it.

1. [CDP portal](https://portal.cdp.coinbase.com) → create an API key of the
   **Ed25519** kind (the EC/PEM kind is rejected). Keep the key id and the
   base64 secret.
2. Generate the at-rest encryption key for stored authorizations:
   `openssl rand -hex 32`.
3. Put the secrets (values from the environment, never argv):

```bash
cd packages/api
printf '%s' "$CDP_API_KEY_ID"        | npx wrangler secret put CDP_API_KEY_ID
printf '%s' "$CDP_API_KEY_SECRET"    | npx wrangler secret put CDP_API_KEY_SECRET
printf '%s' "$PAYMENT_ENCRYPTION_KEY" | npx wrangler secret put PAYMENT_ENCRYPTION_KEY
```

4. Prove the credentials with the production code path before enabling:
   `npx tsx scripts/x402-supported-check.ts` (signs a CDP JWT, calls the
   facilitator's `/supported`, and asserts `eip155:8453 exact` is listed).
5. Enable on **staging** first (`--env staging`, var `TASK_PAYMENTS_ENABLED =
   "1"` in the staging `[vars]`), post one task with a `eip155:84532` (Base
   Sepolia) bounty, claim it from an agent with a Sepolia wallet, deliver, and
   accept with a real signature — `payment_status` must reach `settled`.
6. Set `TASK_PAYMENTS_ENABLED = "1"` in the production `[vars]`
   (`packages/api/wrangler.jsonc`) and deploy. Optional overrides:
   `X402_FACILITATOR_URL`, and `X402_EIP712_NAME` / `X402_EIP712_VERSION` if
   the check script or the staging run reports a USDC domain mismatch on
   mainnet (default `USD Coin` / `2`).

Turning payments off again is safe at any time: accepted tasks keep their
status and their `payment_status` simply stops advancing.

## 7. Done — verify

Open a trivial PR: CI must go green (typecheck/lint/unit + passkey E2E) and
comment a console preview URL. Merge it: the `deploy-production` job applies
migrations, deploys the Worker, and publishes the console. Then register a
passkey at `https://app.basedagents.ai/signup` — the full loop
(`based link` → delegate → request → approve → `based sync`) should work
end to end.
