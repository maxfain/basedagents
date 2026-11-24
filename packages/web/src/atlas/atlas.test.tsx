/**
 * Agent Atlas — the checks IMPLEMENTATION.md's "Definition of done" asks for:
 * every record imports, every manifest route renders, launch controls keep
 * unapproved routes noindex and out of the sitemap, structured data stays
 * honest, and the specific evidence caveats (Browser Use docs MCP, Devin key
 * scope and operator funding, CodeRabbit cadence, Letta credits, draft ERCs,
 * historical IBM ACP) are visible.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import manifest from './content/manifest.json';
import AtlasPage from './AtlasPage';
import {
  ATLAS_ROUTES, atlasSitemapXml, categories, comparisons, counts, entities, EMPTY_FILTERS, faq, filtersFromParams, glossary, guides,
  launchManifest, paramsFromFilters, protocols, robotsFor, routeManifest, searchEntities,
} from './data';
import { atlasGuard, NOT_FOUND_ASSET, type AtlasGuardContext } from './guard';
import { atlasHead } from './head';
import { issueHandoff, issueUrlFor, MAX_ISSUE_URL, safeDecode } from './pages/Reference';
import { clientRobots } from './useAtlasHead';
import { resolveAtlas } from './resolve';
import { guideTaskDraftHref } from './ui';

const render = (path: string): string =>
  renderToString(
    <StaticRouter location={path}>
      <AtlasPage />
    </StaticRouter>,
  );
/** Rendered text with tags stripped and entities decoded enough for substring checks. */
const text = (path: string): string =>
  render(path).replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('content import', () => {
  it('imports every record and collection the manifest counts', () => {
    expect(entities).toHaveLength(manifest.counts.entities);
    expect(counts.byDepth.expanded_profile).toBe(manifest.counts.expanded_profiles);
    expect(counts.byDepth.protocol_profile).toBe(manifest.counts.protocol_profiles);
    expect(counts.byDepth.directory_entry).toBe(manifest.counts.directory_entries);
    expect(categories).toHaveLength(manifest.counts.categories);
    expect(guides).toHaveLength(manifest.counts.task_guides);
    expect(glossary).toHaveLength(manifest.counts.glossary_terms);
    expect(faq).toHaveLength(manifest.counts.faq_answers);
    expect(protocols).toHaveLength(manifest.counts.protocol_profiles);
  });

  it('resolves every route in the route manifest to a real page', () => {
    expect(ATLAS_ROUTES).toHaveLength(routeManifest.length);
    for (const route of ATLAS_ROUTES) expect(resolveAtlas(route).kind, route).not.toBe('not-found');
    for (const e of entities) expect(resolveAtlas(e.route)).toMatchObject({ kind: 'project', entity: { id: e.id } });
  });

  it('puts protocol content on the canonical project route, not a duplicate /protocols/{slug}', () => {
    for (const p of protocols) expect(resolveAtlas(p.route)).toMatchObject({ kind: 'project', entity: { id: p.entity_id } });
    expect(resolveAtlas('/protocols/x402').kind).toBe('not-found');
  });

  it('treats unknown slugs as not found (trailing slashes normalised)', () => {
    expect(resolveAtlas('/projects/not-a-record').kind).toBe('not-found');
    expect(resolveAtlas('/compare/a-vs-b').kind).toBe('not-found');
    expect(resolveAtlas('/projects/cursor/').kind).toBe('project');
  });
});

describe('launch controls', () => {
  it('indexes exactly the approved routes, lists only those in the sitemap, and never a directory entry', () => {
    const approved = new Set(launchManifest.approved_indexable_routes);
    expect(approved.size).toBeGreaterThan(0);
    for (const route of ATLAS_ROUTES) {
      expect(atlasHead(route).robots, route).toBe(approved.has(route) ? 'index,follow' : 'noindex,follow');
      expect(atlasHead(route, { forceNoindex: true }).robots, route).toBe('noindex,follow');
    }
    for (const route of approved) {
      const r = resolveAtlas(route);
      if (r.kind === 'project') expect(r.entity.profile_depth, route).not.toBe('directory_entry');
    }
    const locs = (atlasSitemapXml().match(/<loc>[^<]*<\/loc>/g) ?? []).map((l) => l.slice(5, -6).replace('https://basedagents.ai', ''));
    expect(new Set(locs)).toEqual(approved);
    expect(atlasSitemapXml(true)).not.toContain('<url>');
  });

  it('indexes an approved route, and only outside preview builds', () => {
    const approved = new Set(['/atlas', '/projects/cursor', '/projects/not-a-route']);
    expect(robotsFor('/projects/cursor', false, approved)).toBe('index,follow');
    expect(robotsFor('/projects/cursor', true, approved)).toBe('noindex,follow');
    expect(robotsFor('/projects/devin', false, approved)).toBe('noindex,follow');
    expect(robotsFor('/projects/not-a-route', false, approved)).toBe('noindex,follow');
    const xml = atlasSitemapXml(false, approved);
    expect(xml).toContain('<loc>https://basedagents.ai/projects/cursor</loc>');
    expect(xml).toContain('<loc>https://basedagents.ai/atlas</loc>');
    expect(xml).not.toContain('not-a-route');
    for (const loc of xml.match(/<loc>[^<]*<\/loc>/g) ?? []) expect(loc).not.toMatch(/[?#]/);
    expect(atlasSitemapXml(true, approved)).not.toContain('<url>');
  });
});

describe('head and structured data', () => {
  it('uses the supplied SEO title and a self-referential canonical', () => {
    const h = atlasHead('/projects/browser-use');
    expect(h.title).toBe('Browser Use: capabilities, evidence and pricing | BasedAgents');
    expect(h.canonical).toBe('https://basedagents.ai/projects/browser-use');
  });

  it('never emits ratings, offers, reviews or SoftwareApplication; Organization only for organizations', () => {
    for (const route of ATLAS_ROUTES) {
      const ld = JSON.stringify(atlasHead(route).jsonLd);
      expect(ld, route).not.toMatch(/aggregateRating|"Review"|"Offer"|SoftwareApplication|ratingValue/);
      const r = resolveAtlas(route);
      if (r.kind === 'project' && r.entity.entity_type !== 'organization') expect(ld, route).not.toContain('"Organization"');
    }
    expect(JSON.stringify(atlasHead('/projects/browser-use').jsonLd)).toContain('"Organization"');
    expect(JSON.stringify(atlasHead('/projects/devin').jsonLd)).not.toContain('"Organization"');
  });

  it('describes breadcrumbs as Atlas → category → project', () => {
    const graph = (atlasHead('/projects/devin').jsonLd as { '@graph': { '@type': string; itemListElement?: { name: string }[] }[] })['@graph'];
    const crumbs = graph.find((n) => n['@type'] === 'BreadcrumbList')!.itemListElement!.map((i) => i.name);
    expect(crumbs).toEqual(['Atlas', 'Coding agents', 'Devin']);
  });
});

describe('search and filters', () => {
  it('returns all records alphabetically with no filters, and nothing for a nonsense query', () => {
    const all = searchEntities(EMPTY_FILTERS);
    expect(all).toHaveLength(entities.length);
    expect(all.map((e) => e.name)).toEqual([...all.map((e) => e.name)].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })));
    expect(searchEntities({ ...EMPTY_FILTERS, q: 'zzqqxx' })).toEqual([]);
  });

  it('matches across name, description, category title and entity type, every word required', () => {
    expect(searchEntities({ ...EMPTY_FILTERS, q: 'mcp server' }).length).toBeGreaterThan(0);
    expect(searchEntities({ ...EMPTY_FILTERS, q: 'Coding agents' }).every((e) => e.category_id === 'coding-agents' || /coding|agent/i.test(e.description + e.name))).toBe(true);
    expect(searchEntities({ ...EMPTY_FILTERS, depth: 'protocol_profile' })).toHaveLength(13);
    expect(searchEntities({ ...EMPTY_FILTERS, type: 'mcp_server', category: 'mcp-integrations' }).every((e) => e.entity_type === 'mcp_server')).toBe(true);
  });

  it('round-trips filters through the URL and drops unsupported depth values', () => {
    const f = { q: 'browser use', type: 'organization', category: 'browser-computer-agents', depth: 'expanded_profile' as const };
    expect(filtersFromParams(paramsFromFilters(f))).toEqual(f);
    expect(filtersFromParams(new URLSearchParams('depth=autonomous'))).toEqual(EMPTY_FILTERS);
  });
});

describe('project pages', () => {
  it('Browser Use: separates the read-only docs MCP from execution integrations; round is not lifetime funding', () => {
    const t = text('/projects/browser-use');
    expect(t).toContain('Documentation only (read-only)');
    expect(t).toContain('Execution integrations');
    expect(t).toContain('$0.06 per browser hour');
    expect(t).toContain('Announced round, not a reconstructed cumulative total.');
    expect(t).toContain('Not runtime-tested');
  });

  it("Devin: keeps the MCP key-scope caveat and attributes funding to Cognition", () => {
    const t = text('/projects/devin');
    expect(t).toContain('Legacy apk_/apk_user_ keys only support repository documentation tools');
    expect(t).toContain("Operator's announced funding round");
    expect(t).toContain('Cognition, the operator; not Devin as a separate company.');
    expect(t).toContain('More than $2,000,000,000');
    expect(t).toContain('Per month: $0');
    expect(t).toContain('Operated by Cognition');
  });

  it('shows documented zero prices as $0 and unknowns as not established — never as No or zero', () => {
    expect(text('/projects/agentmail')).toContain('$0 per month');
    const t = text('/projects/agentmail');
    expect(t).toContain('x402 support: Not established by the inspected sources');
    expect(t).not.toMatch(/x402 support: (No|0)\b/);
  });

  it('keeps the CodeRabbit cadence warning and the Letta credits caveat', () => {
    expect(text('/projects/coderabbit')).toContain('Billing cadence must be confirmed in the live selector before purchase.');
    expect(text('/projects/letta')).toContain('Included credits are a plan allowance, not measured spend.');
  });

  it('labels a registry-only record with a discovery link, not an official homepage', () => {
    const e = entities.find((x) => x.website_url === null)!;
    const t = text(e.route);
    expect(t).toContain('Discovery link (registry listing, not a product homepage)');
    expect(t).not.toContain('Official link');
  });

  it('keeps the historical IBM ACP migration note and draft ERC status visible', () => {
    const acp = text('/projects/agent-communication-protocol-ibm-beeai');
    expect(acp).toContain('Merged into A2A; IBM says active development is winding down.');
    expect(acp).toContain('Implementation checklist');
    expect(text('/projects/erc-8004-trustless-agents')).toContain('Version or lifecycle Draft');
  });

  it('renders a concise directory entry without padding: description, gaps, backlog, sources', () => {
    const t = text('/projects/mcp-reference-time');
    expect(t).toContain('Time and timezone conversion reference.');
    expect(t).toContain('Evidence gaps');
    expect(t).toContain('Pricing: Not established by the inspected sources');
    expect(t).not.toContain('People, organization and funding Funding');
  });
});

describe('hubs, guides, comparisons and reference pages', () => {
  it('lists every record on /atlas and computes counts from the data', () => {
    const html = render('/atlas');
    expect(html.match(/class="atlas-card"/g)?.length).toBeGreaterThanOrEqual(entities.length);
    expect(text('/atlas')).toContain(`${entities.length} records`);
  });

  it('renders a guide with its test-design status and every required block', () => {
    const g = guides[0];
    const t = text(g.route);
    for (const s of ['Test design — not executed', 'Inputs', 'Expected deliverable', 'Procedure', 'Approval boundary', 'Acceptance criteria', 'Failure modes', g.acceptance_criteria]) {
      expect(t).toContain(s);
    }
    expect(t).toContain('none of these has been run against this task');
  });

  it('renders comparisons with "Not established." for absent facts and no winner', () => {
    for (const c of comparisons) {
      const t = text(c.route);
      expect(t).toContain(c.conclusion);
      // Lowercase "No winner …" disclaimers are expected; a Winner label, stars or an x/5 or x/10 score are not.
      expect(t).not.toMatch(/\bWinner\b|★|\b\d+(\.\d+)?\s*\/\s*(5|10)\b/);
    }
    expect(text('/compare/browser-use-browserbase-skyvern')).toContain('Not established.');
  });

  it('puts every FAQ answer in the HTML with a linkable id, and glossary anchors', () => {
    const html = render('/faq');
    for (const f of faq) expect(html).toContain(`id="${f.id}"`);
    expect(text('/faq')).toContain(faq[faq.length - 1].answer);
    const g = render('/glossary');
    for (const t of glossary) expect(g).toContain(`id="${t.id}"`);
  });

  it('never claims receipt on the submission forms', () => {
    const t = text('/submit');
    expect(t).toContain('nothing is sent until you submit it there');
    expect(t).not.toContain('Suggestion received for review');
  });
});

describe('BasedAgents hand-offs', () => {
  it('turns a guide into a prefilled task draft within the composer limits', () => {
    for (const g of guides) {
      const u = new URL(guideTaskDraftHref(g, 'https://basedagents.ai'));
      expect(u.origin + u.pathname).toBe('https://app.basedagents.ai/tasks/new');
      expect(u.searchParams.get('expected_output')).toBe(g.deliverable);
      const d = u.searchParams.get('description')!;
      expect(d).toContain(g.inputs);
      expect(d).toContain(g.acceptance_criteria);
      expect(d.length).toBeLessThanOrEqual(10_000);
      expect(g.deliverable.length).toBeLessThanOrEqual(2_000);
    }
  });

  it('files suggestions as a pre-filled GitHub issue', () => {
    const u = new URL(issueUrlFor('/submit', '[Atlas] Suggest a project: X', { 'Project name': 'X', 'Official URL': 'https://x.example' }));
    expect(u.origin + u.pathname).toBe('https://github.com/maxfain/basedagents/issues/new');
    expect(u.searchParams.get('title')).toBe('[Atlas] Suggest a project: X');
    expect(u.searchParams.get('body')).toContain('**Official URL**\nhttps://x.example');
  });
});

describe('review fixes', () => {
  it('keeps forced-noindex builds, previews and filtered views noindex in the browser', () => {
    const approved = launchManifest.approved_indexable_routes[0];
    expect(clientRobots(approved, '', 'basedagents.ai', false)).toBe('index,follow');
    expect(clientRobots(approved, '', 'basedagents.ai', true)).toBe('noindex,follow');
    expect(clientRobots(approved, '', 'abc.auth-ai-web.pages.dev', false)).toBe('noindex,follow');
    expect(clientRobots('/atlas', '?q=mcp', 'basedagents.ai', false)).toBe('noindex,follow');
  });

  it('ignores a malformed FAQ fragment instead of throwing', () => {
    expect(safeDecode('%')).toBeNull();
    expect(safeDecode('what-is-x402-used-for')).toBe('what-is-x402-used-for');
  });

  it('keeps each pricing fact\'s note, status and citation on comparison cards', () => {
    const t = text('/compare/browser-use-browserbase-skyvern');
    expect(t).toContain('Note: Older indexed content showed $0.02/hour. Current directly opened price used.');
    expect(t).toContain('Vendor-documented. Source: browser-use.com');
    expect(t).toContain('Source: browserbase.com/pricing');
  });

  it('falls back to a copyable body when the pre-filled issue URL would be too long', () => {
    const short = issueHandoff('/submit', '[Atlas] Suggest a project: X', { 'Project name': 'X' });
    expect(short.pasteBody).toBeNull();
    // Two maxed-out long fields of multi-byte text (each "é" URL-encodes to 6 characters).
    const long = issueHandoff('/submit', '[Atlas] Suggest a project: X', { Description: 'é'.repeat(3000), 'Documentation URLs': 'x'.repeat(3000) });
    expect(long.pasteBody).toContain('x'.repeat(3000));
    expect(long.url.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
    expect(new URL(long.url).searchParams.get('body')).toBeNull();
  });
});

describe('404 guard (Pages Functions)', () => {
  const headers = { 'X-Robots-Tag': 'index, follow', 'Content-Security-Policy': "default-src 'self'", Link: '</x>; rel="y"' };
  const ctx = (url: string, method = 'GET'): AtlasGuardContext & { assetPaths: string[] } => {
    const assetPaths: string[] = [];
    return {
      assetPaths,
      request: new Request(url, { method }),
      env: { ASSETS: { fetch: async (r: Request) => { assetPaths.push(new URL(r.url).pathname); return new Response('<h1>not found page</h1>'); } } },
      next: async () => new Response('<h1>page</h1>', { status: 200 }),
    };
  };

  it('passes known routes through with the site headers (minus the homepage Link)', async () => {
    const res = await atlasGuard(ctx('https://basedagents.ai/projects/cursor'), headers);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<h1>page</h1>');
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'self'");
    expect(res.headers.get('X-Robots-Tag')).toBe('index, follow');
    expect(res.headers.get('Link')).toBeNull();
  });

  it('answers an unknown slug with the not-found page and a real 404', async () => {
    const c = ctx('https://basedagents.ai/projects/nope');
    const res = await atlasGuard(c, headers);
    expect(res.status).toBe(404);
    expect(c.assetPaths).toEqual([NOT_FOUND_ASSET]);
    expect(await res.text()).toContain('not found page');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('noindexes previews even for known routes', async () => {
    const res = await atlasGuard(ctx('https://abc123.basedagents-web.pages.dev/categories/coding-agents'), headers);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });
});
