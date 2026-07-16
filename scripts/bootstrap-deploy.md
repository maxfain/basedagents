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
2. Put the price ids in `packages/api/wrangler.jsonc` vars
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
  database per `wrangler.jsonc`.

## 6. Done — verify

Open a trivial PR: CI must go green (typecheck/lint/unit + passkey E2E) and
comment a console preview URL. Merge it: the `deploy-production` job applies
migrations, deploys the Worker, and publishes the console. Then register a
passkey at `https://app.basedagents.ai/signup` — the full loop
(`based link` → delegate → request → approve → `based sync`) should work
end to end.
