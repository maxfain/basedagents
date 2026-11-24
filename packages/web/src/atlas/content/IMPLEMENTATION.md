# Implementation contract

## Scope and integration

Implement a content-led atlas inside the existing BasedAgents site. Inspect the repository's instructions and current routing before editing. Preserve the existing visual system and core product flows. The proposed atlas landing route is `/atlas`; do not replace `/` automatically. If any supplied route already exists, integrate it or document an explicit redirect plan instead of overwriting it.

Use static generation or server rendering for the readable content where the existing stack supports it. Start with JSON imports; a database is optional. No live scraping is needed to build this release. The content package contains no credentials, executable MCP installation commands, checkout flows or live agent hiring integration.

## Canonical records

`data/entities.json` is the canonical profile content. `content/protocols.json` augments protocol records on the same `/projects/{slug}` route. Do not create duplicate full protocol pages under `/protocols/{slug}`. `/protocols` is the browse hub.

Keep entity type visible. Do not label all records companies, agents or verified services. Use the type supplied. `source_candidate_id` is an internal research identifier, not an external registry identifier. Slugs are stable local identifiers; do not regenerate them from titles at runtime.

`website_url=null` can mean that only a registry listing was resolved. Display its `discovery_url` as a discovery link, not as a product homepage. Never derive a repository by stripping `/mcp/` from a GitHub registry URL. `repository_url=null` is unknown.

`facts` hold sourced details. Existing enriched facts use `evidence_ids` referencing the same entity's `evidence` array; newer facts use `source_urls`. Support both forms. A source says that something is documented, not that it was independently tested. Retain each fact's `status`, `note` and `scope` when displaying it. `people`, `funding` and `stated_goal` are display conveniences; use the facts for provenance.

Pricing has two shapes: `{summary, source_url, observed_at, status, currency, not_cost_per_task}` or `{facts:[...]}`. Do not calculate a generic cheapest price from either shape. A numeric zero is a documented free price; null is unknown. CodeRabbit's captured billing cadence is ambiguous and must retain its explicit selector warning. Letta credits are allowances, not measured spend. Funding belongs to the stated operator, not automatically to a product. Devin's funding observation concerns Cognition.

## Project-page composition

1. Breadcrumbs: Atlas → category → project.
2. Identity header: name, type, one-sentence description, source date and official/discovery link.
3. Evidence status: source summary or vendor-documented; clearly show no runtime test in this release. Do not show a zero-valued performance score.
4. What it does: sourced capabilities and deployment facts. Use the description for concise entries; do not invent missing tool inventories.
5. Interfaces: show documented MCP endpoints or other interfaces with their roles, authentication and scope notes. For Browser Use, distinguish the read-only docs MCP from execution integrations. For Devin, preserve key-scope caveats.
6. Pricing: source-linked snapshot, units, conditions and extra-cost notes.
7. People, organization and funding: only populated facts, correctly attributed. Never imply a round amount is lifetime funding.
8. Mission/roadmap: only the sourced stated goal. Do not convert editorial advice into the company's goals.
9. Evaluation guidance: visibly labeled editorial guidance or inference, separate from facts.
10. Evidence gaps: compact list of unknowns and the verification backlog.
11. Related records: supplied links labeled as topic relevance, not alternatives with verified feature parity.
12. Sources and correction CTA.

For protocols, insert the source-based explanation, limitations, version/lifecycle note and implementation checklist. Draft ERC status and the historical IBM ACP migration note must remain visible.

## Browse and search

Implement search over name, description, source category, category title and entity type. Use only the filters provided in `site-copy.json`. Search should preserve the typed query and selected filters in the URL. Provide keyboard-accessible controls, a clear-all action and the supplied empty-state message.

Do not offer filters for capabilities, pricing ranges, successful payments, reputation, open-source status or autonomy unless the underlying field is explicitly sourced and normalized. Do not infer them from titles or descriptions. Related records are deterministic topic links, not recommendations or rankings.

Show collection counts computed from the imported data. Say “151 records” rather than “151 autonomous companies.” Do not hard-code source directory counts from research notes as atlas coverage.

## Category, task, comparison and glossary pages

Category hubs use their title, introduction, guidance and member IDs. Include type-aware cards and links to relevant task guides by category. Directory cards may appear in an indexable reviewed hub even when their thin individual profiles remain noindex.

Task guides must display the test-design status, inputs, expected deliverable, procedure, approval boundary, acceptance criteria and failure modes. Candidate links are research starting points; do not say the candidates passed these tasks.

Comparison pages use the supplied answer, candidate cards, decision questions, source links and conclusion. They must not add winners, ratings or a feature matrix filled by inference. For factual cells absent from the data, display “Not established.”

The glossary is a single `/glossary` page with stable anchors from glossary IDs and local search. Definitions are editorial working definitions. Do not automatically generate 76 thin standalone pages. The FAQ is a single `/faq` page with linkable question IDs and accessible expand/collapse controls, with answer text present in rendered HTML.

## Internal linking and citation rendering

Use actual anchors (`<a href>`), not click-only cards. Source links must be visible and accessible. Normal editorial links should not automatically be labeled sponsored or nofollow. Add `rel="noopener noreferrer"` when opening a new tab. Apply sponsored/ugc attributes only if the relationship actually requires them in the eventual site.

Sources belong beside the factual section as well as in a source list. Deduplicate repeated URLs for display, but preserve evidence IDs internally. Do not change an observed date into an event date. A date in a URL is not a substitute for an explicitly sourced publication date.

Return a real 404 for unknown slugs. Avoid blanket redirects to the directory. Preserve exact supplied routes; add redirects only for real legacy URLs identified in the existing app.

## Search and answer-engine implementation

All pages start as preview/noindex. `implementation/launch-manifest.json` is the publication switch: an approved route can become indexable only after editorial checks and normal technical checks. This is a content workflow, not a request to interrupt implementation for permission.

Compute robots metadata from the launch manifest. Do not use the record's default robots string to override an explicitly approved route. Exclude unapproved routes, filtered/search URLs and drafts from the production sitemap. In preview environments, apply site-wide noindex regardless of route approval. A disallowed robots.txt path may stop crawlers seeing noindex; use deployment access controls where private previews are needed.

Approved pages need self-referential canonical URLs, descriptive titles, a clear H1, readable answer blocks, visible source dates and relevant internal links. Keep facet combinations out of the sitemap. The canonical domain is basedagents.ai; confirm the site's existing trailing-slash convention and apply it consistently.

Structured data must reflect visible content. Use WebPage/CollectionPage and BreadcrumbList where appropriate. Use Organization only for actual organizations, not every entity. Use SoftwareApplication only when its required applicable fields are genuinely available; otherwise omit it. Do not fabricate offers, ratings, reviews or aggregateRating. FAQ copy is useful without any promise of FAQ rich results. There is no promise that structured data, llms.txt or any content format produces answer-engine citations.

## Forms and product integration

Submission and correction copy is provided. A real backend must validate URLs, rate-limit submissions, store the evidence and queue review. Do not display success without a successful write. If no backend exists, render an honest disabled state or connect to an existing configured contact flow; do not invent an email address.

Do not create fake login, profile claiming, MCP audit or hiring results. Link to an existing BasedAgents flow only after confirming the route and supported operation in the codebase. Never execute unknown installation commands or payments while building the site.

## Evidence updates

Keep provenance with each changed fact and retain previous values internally. Suggested operational review cadence: prices/endpoints every 7–30 days, active product descriptions every 30–90 days, historical funding facts when new evidence arrives. These are editorial suggestions, not freshness guarantees. No recurring job is activated by this package.

The backlog includes missing values. Promote directory entries only after source identity is resolved and enough distinct factual detail exists to help a reader decide what to investigate. Avoid filling pages to a word-count target.

## Definition of done

- All 151 records import without silently dropping types, notes or unknowns.
- All routes in the route manifest render or are explicitly integrated with an existing equivalent route.
- Protocol content appears on its canonical project route, not a duplicate route.
- Internal links, glossary anchors and sources render correctly.
- The preview is noindex; the production sitemap only includes approved routes.
- Product/company relationships are preserved; generic topic links are labeled editorial.
- No ungrounded ratings, logos, customer counts, founder details, funding totals or test results appear.
- Forms either work against a real backend or visibly state their unavailable status.
- Run the content validator and the repository's normal lint/type/build checks. Test one expanded profile, one registry-only record, one historical protocol, one guide and a search with zero results.
- Document deployment steps and remaining backend work. Do not claim a public launch from a local build.
