/**
 * Pathname → atlas page. One resolver shared by the page renderer, the
 * <head>/JSON-LD builder and the prerender, so they can never disagree about
 * what a URL is. Unknown slugs resolve to `not-found` (a real 404 in
 * production — see functions/ and guard.ts).
 */
import {
  counts, getCategory, getComparisonBySlug, getEntityBySlug, getGuideBySlug, getStaticPage, siteCopy, categories,
} from './data';
import type { AtlasCategory, AtlasComparison, AtlasEntity, AtlasGuide, AtlasStaticPage } from './types';

export type AtlasResolved =
  | { kind: 'home'; route: string }
  | { kind: 'categories'; route: string }
  | { kind: 'protocols'; route: string }
  | { kind: 'guides'; route: string }
  | { kind: 'glossary'; route: string }
  | { kind: 'faq'; route: string }
  | { kind: 'static'; route: string; page: AtlasStaticPage }
  | { kind: 'form'; route: string; page: AtlasStaticPage }
  | { kind: 'project'; route: string; entity: AtlasEntity }
  | { kind: 'category'; route: string; category: AtlasCategory }
  | { kind: 'guide'; route: string; guide: AtlasGuide }
  | { kind: 'comparison'; route: string; comparison: AtlasComparison }
  | { kind: 'not-found'; route: string };

export const normalizePath = (pathname: string): string => pathname.replace(/\/+$/, '') || '/';

const HUB_KINDS: Record<string, 'home' | 'categories' | 'protocols' | 'guides' | 'glossary' | 'faq'> = {
  '/atlas': 'home',
  '/categories': 'categories',
  '/protocols': 'protocols',
  '/guides': 'guides',
  '/glossary': 'glossary',
  '/faq': 'faq',
};

export function resolveAtlas(pathname: string): AtlasResolved {
  const route = normalizePath(pathname);
  const hub = HUB_KINDS[route];
  if (hub) return { kind: hub, route };

  const page = getStaticPage(route);
  if (page) return page.form_fields ? { kind: 'form', route, page } : { kind: 'static', route, page };

  const m = /^\/(projects|categories|guides|compare)\/([^/]+)$/.exec(route);
  if (m) {
    const [, section, slug] = m;
    if (section === 'projects') {
      const entity = getEntityBySlug(slug);
      if (entity && entity.route === route) return { kind: 'project', route, entity };
    } else if (section === 'categories') {
      const category = getCategory(slug);
      if (category && category.route === route) return { kind: 'category', route, category };
    } else if (section === 'guides') {
      const guide = getGuideBySlug(slug);
      if (guide) return { kind: 'guide', route, guide };
    } else {
      const comparison = getComparisonBySlug(slug);
      if (comparison) return { kind: 'comparison', route, comparison };
    }
  }
  return { kind: 'not-found', route };
}

// ── Hub copy ───────────────────────────────────────────────────────────────
// Headings and one-line intros for the browse hubs. The content package has
// no hub copy beyond the homepage, so these restate its own framing
// (START_HERE.md, site-copy.json) and computed counts — no new claims.

export interface HubCopy { h1: string; title: string; description: string; intro: string }

export const HUB_COPY: Record<'home' | 'categories' | 'protocols' | 'guides' | 'glossary' | 'faq', HubCopy> = {
  home: {
    h1: siteCopy.homepage.title,
    title: 'Agent Atlas: agent companies, MCP servers, skills and protocols | BasedAgents',
    description: siteCopy.homepage.subtitle,
    intro: siteCopy.homepage.subtitle,
  },
  categories: {
    h1: 'Categories',
    title: 'Agent categories: coding, browser, support, MCP and more | Agent Atlas | BasedAgents',
    description: `${counts.categories} topic hubs across ${counts.entities} records: agent companies, products, MCP servers, skills, protocols and task services, each with sources and evidence limits.`,
    intro: `${counts.categories} topic hubs across ${counts.entities} records. Each hub lists its records with their supplied type, editorial selection guidance and related task guides.`,
  },
  protocols: {
    h1: 'Protocols',
    title: 'Agent protocols explained: MCP, A2A, x402, AP2 and more | Agent Atlas | BasedAgents',
    description: `${counts.byDepth.protocol_profile ?? 0} agent protocol records — documented scope, limitations, version status and an editorial implementation checklist for each. Not interoperability tests.`,
    intro: 'Each protocol record explains its documented scope, limitations and version status, with an editorial implementation checklist. These are source-based explanations, not interoperability tests.',
  },
  guides: {
    h1: 'Task guides',
    title: 'Task guides: how to evaluate an agent for a specific job | Agent Atlas | BasedAgents',
    description: `${counts.guides} task guides with inputs, deliverables, procedures, approval boundaries and acceptance criteria for evaluating agents on a bounded job.`,
    intro: siteCopy.homepage.sections[0]?.body ?? '',
  },
  glossary: {
    h1: 'Glossary',
    title: 'Agent glossary: MCP, A2A, x402, skills and more | Agent Atlas | BasedAgents',
    description: `${counts.glossary} editorial working definitions for agents, protocols, payments, evidence and evaluation terms.`,
    intro: `${counts.glossary} editorial working definitions. They explain how the atlas uses each term; they are not standards text.`,
  },
  faq: {
    h1: 'Frequently asked questions',
    title: 'Agent Atlas FAQ: evidence, listings, protocols and payments | BasedAgents',
    description: `${counts.faq} answers about what an atlas listing verifies, how evidence is handled, and how MCP, A2A, x402 and ERC proposals differ.`,
    intro: 'What a listing does and does not establish, how evidence is handled, and how the protocols differ.',
  },
};

// ── Breadcrumbs ────────────────────────────────────────────────────────────

export interface Crumb { name: string; href: string }

const ATLAS_CRUMB: Crumb = { name: 'Atlas', href: '/atlas' };

export function breadcrumbsFor(r: AtlasResolved): Crumb[] {
  switch (r.kind) {
    case 'home':
      return [ATLAS_CRUMB];
    case 'categories':
    case 'protocols':
    case 'guides':
    case 'glossary':
    case 'faq':
      return [ATLAS_CRUMB, { name: HUB_COPY[r.kind].h1, href: r.route }];
    case 'static':
    case 'form':
      return [ATLAS_CRUMB, { name: r.page.title, href: r.route }];
    case 'project': {
      const c = getCategory(r.entity.category_id);
      return [ATLAS_CRUMB, ...(c ? [{ name: c.title, href: c.route }] : []), { name: r.entity.name, href: r.route }];
    }
    case 'category':
      return [ATLAS_CRUMB, { name: 'Categories', href: '/categories' }, { name: r.category.title, href: r.route }];
    case 'guide':
      return [ATLAS_CRUMB, { name: 'Task guides', href: '/guides' }, { name: r.guide.title, href: r.route }];
    case 'comparison':
      return [ATLAS_CRUMB, { name: r.comparison.title, href: r.route }];
    case 'not-found':
      return [ATLAS_CRUMB];
  }
}

export const categoryTitle = (id: string): string => categories.find((c) => c.id === id)?.title ?? id;
