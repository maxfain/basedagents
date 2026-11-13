/**
 * <head> metadata and JSON-LD for an atlas route — used at build time by
 * scripts/prerender.mjs (via entry-server.tsx) and on client-side navigation by
 * useAtlasHead.
 *
 * Robots come from the launch manifest (data.robotsFor): everything starts
 * noindex. Structured data reflects visible content only: WebPage /
 * CollectionPage / FAQPage plus BreadcrumbList; Organization only for records
 * typed `organization`; no SoftwareApplication, offers, ratings or reviews.
 */
import { faq, glossary, robotsFor, SITE } from './data';
import { clip } from './format';
import { breadcrumbsFor, HUB_COPY, resolveAtlas, type AtlasResolved } from './resolve';

export interface AtlasHead {
  title: string;
  description: string;
  canonical: string;
  robots: string;
  jsonLd: Record<string, unknown> | null;
}

function titleAndDescription(r: AtlasResolved): { title: string; description: string; name: string } {
  switch (r.kind) {
    case 'home':
    case 'categories':
    case 'protocols':
    case 'guides':
    case 'glossary':
    case 'faq': {
      const c = HUB_COPY[r.kind];
      return { title: c.title, description: c.description, name: r.kind === 'home' ? 'Agent Atlas' : c.h1 };
    }
    case 'static':
    case 'form':
      return { title: `${r.page.title} | Agent Atlas | BasedAgents`, description: clip(r.page.body.join(' ')), name: r.page.title };
    case 'project':
      return { title: r.entity.seo.title, description: clip(r.entity.seo.description), name: r.entity.name };
    case 'category':
      return { title: r.category.seo_title, description: clip(r.category.meta_description), name: r.category.title };
    case 'guide':
      return {
        title: `${r.guide.title} | BasedAgents`,
        description: clip(`Inputs, procedure, approval boundary and acceptance criteria. Deliverable: ${r.guide.deliverable}`),
        name: r.guide.title,
      };
    case 'comparison':
      return { title: `${r.comparison.title} | BasedAgents`, description: clip(r.comparison.answer), name: r.comparison.title };
    case 'not-found':
      return { title: 'Not found | Agent Atlas | BasedAgents', description: 'No atlas record exists at this address.', name: 'Not found' };
  }
}

function pageType(r: AtlasResolved): string {
  if (r.kind === 'faq') return 'FAQPage';
  if (r.kind === 'home' || r.kind === 'categories' || r.kind === 'protocols' || r.kind === 'guides' || r.kind === 'category') return 'CollectionPage';
  return 'WebPage';
}

function jsonLdFor(r: AtlasResolved, canonical: string, name: string, description: string): Record<string, unknown> | null {
  if (r.kind === 'not-found') return null;
  const crumbs = breadcrumbsFor(r);
  const page: Record<string, unknown> = {
    '@type': pageType(r),
    '@id': `${canonical}#page`,
    url: canonical,
    name,
    description,
    inLanguage: 'en',
    isPartOf: { '@id': `${SITE}/#site` },
    publisher: { '@id': `${SITE}/#org` },
  };
  const graph: Record<string, unknown>[] = [page];

  if (crumbs.length > 1) {
    page.breadcrumb = { '@id': `${canonical}#breadcrumb` };
    graph.push({
      '@type': 'BreadcrumbList',
      '@id': `${canonical}#breadcrumb`,
      itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: `${SITE}${c.href}` })),
    });
  }

  if (r.kind === 'project') {
    page.lastReviewed = r.entity.reviewed_at;
    // Organization only for records the content package types as organizations.
    if (r.entity.entity_type === 'organization') {
      page.about = { '@type': 'Organization', name: r.entity.name, ...(r.entity.website_url ? { url: r.entity.website_url } : {}) };
    }
  }

  if (r.kind === 'faq') {
    page.mainEntity = faq.map((q) => ({
      '@type': 'Question',
      name: q.question,
      url: `${canonical}#${q.id}`,
      acceptedAnswer: { '@type': 'Answer', text: q.answer },
    }));
  }

  if (r.kind === 'glossary') {
    page.mainEntity = {
      '@type': 'DefinedTermSet',
      '@id': `${canonical}#terms`,
      name: 'Agent Atlas glossary',
      hasDefinedTerm: glossary.map((t) => ({
        '@type': 'DefinedTerm',
        '@id': `${canonical}#${t.id}`,
        name: t.term,
        description: t.definition,
        inDefinedTermSet: { '@id': `${canonical}#terms` },
      })),
    };
  }

  return { '@context': 'https://schema.org', '@graph': graph };
}

export function atlasHead(pathname: string, opts: { forceNoindex?: boolean } = {}): AtlasHead {
  const r = resolveAtlas(pathname);
  const { title, description, name } = titleAndDescription(r);
  const canonical = `${SITE}${r.route}`;
  return {
    title,
    description,
    canonical,
    robots: r.kind === 'not-found' ? 'noindex,follow' : robotsFor(r.route, opts.forceNoindex),
    jsonLd: jsonLdFor(r, canonical, name, description),
  };
}
