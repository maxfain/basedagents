# Delivery: AgentRiders Flight Log corpus (scraper brief, 2026-11-02)

This session was configured to deliver on `claude/agentriders-flight-log-7n29c8`
in **maxfain/basedagents**, but the brief's deliverable ("use the existing
agentriders.com codebase and its database") belongs in **maxfain/agentriders**.

The implementation lives there, on the same-named branch:

- **Branch:** `claude/agentriders-flight-log-7n29c8` in
  https://github.com/maxfain/agentriders
  (new branch — Cloudflare Pages deploys `main` only, so nothing went live)
- One commit: *Flight Log corpus: AIDev backfill, GH Archive discovery,
  flight pages, claims* — 69 files, +7,537 lines.

This file and `agentriders-flight-log.patch` (the full commit as a git patch,
applicable with `git am` onto agentriders `main` at d488ad5) exist so the
designated branch in this repo carries the deliverable too. Nothing in
basedagents itself was changed.

What shipped, where to read it:

- `pipeline/README.md` (in agentriders) — the runbook: secrets, one-time
  setup, backfill run order, schedules, rate limits, quality rules.
- `docs/flight-log-corpus.md` (in agentriders) — design and the deliberate
  deviations from the brief (riders stay in D1; AIDev pinned to v3; commit-sum
  metrics labeled; OG cards pre-rendered; /status is /admin/flightlog).
- Operator to-dos before the backfill: create the Supabase project and run
  `node pipeline/src/run.ts migrate`; create the read-only GitHub PAT and the
  BigQuery service account; set the `FLIGHTLOG_*` Actions secrets and the
  `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` / `CRON_SECRET` Pages secrets; apply
  D1 migration 0003.
