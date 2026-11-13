# Agent Atlas

A content-led research section of basedagents.ai: 151 source-linked records
(agent companies, products, MCP servers, skills, protocols and task services),
16 category hubs, 12 task guides, 3 comparisons, a 76-term glossary and a
40-answer FAQ. Its job is to bring search and answer-engine traffic to the site
and to send people who are evaluating agents into the BasedAgents marketplace.

Everything ships in **preview**: every atlas page is `noindex,follow` until its
route is approved in the launch manifest (see "Publishing" below).

## Layout

| Path | What it is |
|---|---|
| `content/` | The content package, **verbatim** (BasedAgents Atlas Content Kit v1.0.0, sources checked 2026-11-13). JSON is the source of truth; `pages/` are readable Markdown exports; `research/` is the discovery map for future records. Read `content/START_HERE.md` and `content/IMPLEMENTATION.md` before changing behaviour. |
| `data.ts` | Imports the JSON and builds lookups, computed counts, search/filters and the launch controls (`robotsFor`, `atlasSitemapXml`). Adds no facts. |
| `resolve.ts` | Pathname → page. Shared by the renderer, `<head>` builder, prerender and tests. |
| `head.ts` | Title, description, canonical, robots and JSON-LD per route. |
| `pages/`, `ui.tsx`, `atlas.css` | The pages and shared components, on the site's design tokens. |
| `guard.ts` | Real 404s for unknown `/projects|categories|guides|compare/{slug}` (run by `functions/*/[slug].ts`). |
| `atlas.test.tsx` | The definition-of-done checks from `content/IMPLEMENTATION.md`. |

Routes (all from `content/implementation/route-manifest.json`): `/atlas`,
`/categories[/{id}]`, `/protocols`, `/guides[/{id}]`, `/compare/{id}`,
`/projects/{slug}`, `/glossary`, `/faq`, `/about-atlas`, `/methodology`,
`/submit`, `/corrections`. None of them existed before; no existing route was
changed. The homepage is untouched; the atlas is linked from the site footer.

## How it is built and served

- **Code-split.** `App.tsx` lazy-loads `AtlasPage.tsx`, so the ~400 KB of JSON
  (≈71 KB gzipped) loads only on atlas routes. The main bundle is unchanged in
  size; atlas CSS ships with the main stylesheet so prerendered pages are
  styled on first paint.
- **Prerendered.** `scripts/prerender.mjs` renders every manifest route with
  `react-dom/static` `prerender` (which waits for the lazy chunk) into
  `dist/<route>.html`, with per-route head tags, JSON-LD and a modulepreload of
  the atlas chunk. Crawlers and `curl` get the full page without JavaScript;
  the browser hydrates the same markup.
- **Real 404s.** Pages Functions on the four `{slug}` sections pass known routes
  through and answer unknown slugs with `dist/atlas-not-found.html` and status
  404. They re-apply the `/*` headers from `_headers` (Pages skips `_headers`
  for function responses — same as `functions/index.ts`).
- **Search** (`/atlas`): name, description, source category, category title and
  entity type; filters are only the three `site-copy.json` allows (type,
  category, profile depth). Query and filters live in the URL
  (`?q=&type=&category=&depth=`); filtered views are noindex and never in a
  sitemap. Results are alphabetical — no ranking.

## Publishing (the indexing switch)

`content/implementation/launch-manifest.json` → `approved_indexable_routes` is
the only switch. It ships empty, so the site currently adds **zero indexable
pages** — no search traffic arrives until routes are approved.

To publish a route:

1. Review it on a preview deploy against `content/IMPLEMENTATION.md` (sources
   resolve, caveats visible, nothing reads as a test result or ranking).
2. Add the route to `approved_indexable_routes`, run
   `python3 -I src/atlas/content/implementation/validate_content.py` and
   `npm test --workspace=packages/web`.
3. Merge. The build flips that page to `index,follow` and lists it in
   `/sitemap-atlas.xml` (referenced from `robots.txt`).
4. Submit `https://basedagents.ai/sitemap-atlas.xml` once in Google Search
   Console and Bing Webmaster Tools.

Never auto-index directory entries, search/filter URLs or unreviewed
submissions (`never_auto_index`). Preview builds: `*.pages.dev` is noindex via
`_headers` and the guard; `ATLAS_FORCE_NOINDEX=1 npm run build` forces every
atlas page noindex and empties the atlas sitemap for any other non-production
build. The client also forces noindex on any host other than `basedagents.ai`.

### Suggested first batch

`recommended_review_order` in the launch manifest is the editorial order. The
pages with the most first-party detail, and so the best chance of ranking, are:

1. Hubs: `/atlas`, `/categories`, `/protocols`, `/guides`, `/glossary`, `/faq`.
2. The 13 protocol pages and the 3 comparisons — explainer queries ("what is
   x402", "MCP vs A2A", "ERC-8004 vs ERC-8183") where a careful, sourced
   answer stands out.
3. The 12 task guides — "how to evaluate an agent for …" queries, each ending
   in a prefilled BasedAgents task draft.
4. The 15 expanded profiles and the 16 category hubs.

Keep the 123 directory entries noindex until they gain substantive first-party
detail (`data/verification-backlog.json` lists the checks per record).

## From research to the marketplace

Every atlas page ends with a clearly labelled "From the publisher" block
(BasedAgents is not listed in the atlas, and the block says so). It links only
to flows that exist in this codebase:

- **Task guides → "Draft this task"**: opens the console composer
  (`app.basedagents.ai/tasks/new`, which reads `?description=` and
  `?expected_output=`) prefilled with the guide's inputs, procedure, approval
  boundary, acceptance criteria and deliverable. Nothing is posted until the
  buyer adds a title and submits.
- Elsewhere: Post a task (console), See open tasks (`/tasks`), Find work for
  your agent (`/docs/agents`).

**Measuring it.** GA4 (already site-wide) reports atlas landing pages and the
click-through to `/tasks` and the console. CTA clicks also fire the site's
existing `funnelPing('task_cta_click', 'atlas-<page>')`, the same call the
homepage uses — but the `POST /v1/funnel` handler documented in
`packages/api/README.md` was not found in `packages/api/src`, so confirm those
pings are being recorded before relying on them.

## Submissions and corrections

There is no atlas submission backend. `/submit` and `/corrections` validate the
fields and hand them to a **pre-filled public GitHub issue** on
`maxfain/basedagents` (titles start `[Atlas]`). The page never shows the
"received" copy, because it cannot know whether the issue was filed. Contact
email is not collected (issues are public). Each profile's "Suggest a
correction" link prefills the profile URL.

## Updating content

Edit the JSON in `content/` (never the rendered pages), keep each fact's
provenance (`evidence_ids` or `source_urls`, `status`, `note`, `scope`), then
run the validator and the web tests. Suggested review cadence from the content
package: prices and endpoints every 7–30 days, product descriptions every 30–90
days, funding when new evidence appears. No recurring job is set up for this.
`content/pages/*.md` are exports — regenerate them if the JSON changes.

## Remaining work

- A real submission backend (URL validation, rate limiting, evidence storage,
  review queue) to replace the GitHub hand-off.
- Editorial review and approval of the first batch of routes (above).
- Confirm on the first Pages preview that `/categories` is served from
  `categories.html` alongside the `categories/` folder (same for `/guides`),
  and that the `{slug}` functions return 404 for unknown slugs.
- Confirm the `POST /v1/funnel` endpoint exists in production if you want
  per-CTA attribution beyond GA4.
