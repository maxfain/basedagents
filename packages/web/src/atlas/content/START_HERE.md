# BasedAgents Atlas — coding-agent handoff

Build the atlas using the supplied content. This package contains 151 entity records: 15 expanded profiles, 13 protocol profiles and 123 concise directory entries. It also contains 16 category hubs, 12 task guides, 3 comparison drafts, 76 glossary entries and 40 FAQ answers. Sources were inspected on November 13, 2026.

**Important:** this is a populated content release, not a claim that all 151 entities are autonomous-agent companies or fully verified. All content begins in preview mode. No agent runs, security audits or payments were performed. Missing facts remain unknown.

## Give the coding agent this instruction

> Read IMPLEMENTATION.md, content/site-copy.json, data/entities.json and implementation/launch-manifest.json. Integrate the atlas into the existing basedagents.ai application while preserving its design and existing routes. Use the supplied JSON as the source of truth; use pages/ for readable profile and guide exports. Build the routes in implementation/route-manifest.json, the filters and relationships described in IMPLEMENTATION.md, and source-linked detail views. Do not generate facts, ratings, logos, prices, funding totals, compatibility claims, audit badges or task-success metrics. Keep preview pages out of search indexing until their routes enter approved_indexable_routes. Run python3 implementation/validate_content.py and the application's normal build checks. Produce a working preview and a list of any integration dependencies that remain, such as a submission backend. Do not silently deploy or replace the existing homepage.

## Files to use

| File | Purpose |
|---|---|
| `data/entities.json` | 151 canonical records, descriptions, source links, pricing and enriched facts where available |
| `content/categories.json` | Hub titles, introductions, selection guidance and entity memberships |
| `content/protocols.json` | Detailed protocol explanations, boundaries and implementation checklists; render on the existing project route |
| `content/task-guides.json` | Task inputs, deliverables, procedures, acceptance criteria and candidate links |
| `content/comparisons.json` | Three source-linked comparisons without unsupported rankings |
| `content/glossary.json` | 76 editorial working definitions |
| `content/faq.json` | 40 completed question-and-answer blocks |
| `content/site-copy.json` | Homepage, navigation, labels, empty states, CTA text and evidence notices |
| `content/static-pages.json` | About, methodology, submissions and corrections copy |
| `data/relationships.json` | Explicit operator relationship and editorial category/task connections |
| `data/content-sources.json` | Source URL to entity mapping |
| `data/verification-backlog.json` | Specific remaining checks for every record |
| `pages/` | Readable source-linked Markdown exports of 151 profiles and 12 guides |
| `implementation/` | Route and launch manifests, validator and import schema |
| `research/` | Wider discovery sources, proposed queries and optional future database model |

## Content interpretation

The 15 expanded profiles are AgentMail, Browser Use, Devin, Skyvern, Browserbase, Letta, CrewAI, Relevance AI, Cursor, CodeRabbit, Lindy, Gumloop, OpenHands, Factory and Sierra. Their detail varies. Only three enriched records currently contain sourced people/funding information. Unknown fields should be shown in a compact evidence-gap section, not padded with generated prose.

The 123 directory entries are useful for browsing and further research. Their individual pages should remain noindex until substantive first-party detail is added and reviewed. The 13 protocol pages explain documented scope and include editorial checklists; they are not interoperability tests.

The discovery query file contains proposed queries, not executed results. The broader source registry is a research acquisition map, not a list of verified companies. The database schema in research/ is an earlier proposal; it is not the import contract for this content release.

## Quick check

Run from this package directory:

```sh
python3 implementation/validate_content.py
```

The validator checks content consistency and references. It does not verify live websites, product claims or runtime behavior.
