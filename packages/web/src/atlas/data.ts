/**
 * Agent Atlas data layer. Imports the content package (./content) as-is and
 * builds lookups over it. Nothing here adds facts: every value rendered by the
 * atlas comes from these JSON files.
 *
 * This module is only reachable from the lazily loaded atlas chunk and from the
 * build-time prerender, so the ~400 KB of JSON never ships with the rest of the
 * site.
 */
import entitiesJson from './content/data/entities.json';
import relationshipsJson from './content/data/relationships.json';
import backlogJson from './content/data/verification-backlog.json';
import categoriesJson from './content/content/categories.json';
import protocolsJson from './content/content/protocols.json';
import guidesJson from './content/content/task-guides.json';
import comparisonsJson from './content/content/comparisons.json';
import glossaryJson from './content/content/glossary.json';
import faqJson from './content/content/faq.json';
import siteCopyJson from './content/content/site-copy.json';
import staticPagesJson from './content/content/static-pages.json';
import routeManifestJson from './content/implementation/route-manifest.json';
import launchManifestJson from './content/implementation/launch-manifest.json';
import type {
  AtlasBacklogItem, AtlasCategory, AtlasComparison, AtlasEntity, AtlasFaq, AtlasGlossaryTerm,
  AtlasGuide, AtlasLaunchManifest, AtlasProtocol, AtlasRelationship, AtlasRouteEntry, AtlasSiteCopy,
  AtlasStaticPage, ProfileDepth,
} from './types';

export const entities = entitiesJson as unknown as AtlasEntity[];
export const relationships = relationshipsJson as unknown as AtlasRelationship[];
export const backlog = backlogJson as unknown as AtlasBacklogItem[];
export const categories = categoriesJson as unknown as AtlasCategory[];
export const protocols = protocolsJson as unknown as AtlasProtocol[];
export const guides = guidesJson as unknown as AtlasGuide[];
export const comparisons = comparisonsJson as unknown as AtlasComparison[];
export const glossary = glossaryJson as unknown as AtlasGlossaryTerm[];
export const faq = faqJson as unknown as AtlasFaq[];
export const siteCopy = siteCopyJson as unknown as AtlasSiteCopy;
export const staticPages = staticPagesJson as unknown as AtlasStaticPage[];
export const routeManifest = routeManifestJson as unknown as AtlasRouteEntry[];
export const launchManifest = launchManifestJson as unknown as AtlasLaunchManifest;

export const SITE = siteCopy.base_url.replace(/\/+$/, '');

// ── Lookups ────────────────────────────────────────────────────────────────

const byId = new Map(entities.map((e) => [e.id, e]));
const bySlug = new Map(entities.map((e) => [e.slug, e]));
const categoryById = new Map(categories.map((c) => [c.id, c]));
const protocolByEntity = new Map(protocols.map((p) => [p.entity_id, p]));
const guideById = new Map(guides.map((g) => [g.id, g]));
const guideBySlug = new Map(guides.map((g) => [g.route.split('/').pop()!, g]));
const comparisonBySlug = new Map(comparisons.map((c) => [c.route.split('/').pop()!, c]));
const backlogByEntity = new Map(backlog.map((b) => [b.entity_id, b]));
const staticByRoute = new Map(staticPages.map((p) => [p.route, p]));

export const getEntity = (id: string): AtlasEntity | undefined => byId.get(id);
export const getEntityBySlug = (slug: string): AtlasEntity | undefined => bySlug.get(slug);
export const getCategory = (id: string): AtlasCategory | undefined => categoryById.get(id);
export const getProtocol = (entityId: string): AtlasProtocol | undefined => protocolByEntity.get(entityId);
export const getGuide = (id: string): AtlasGuide | undefined => guideById.get(id);
export const getGuideBySlug = (slug: string): AtlasGuide | undefined => guideBySlug.get(slug);
export const getComparisonBySlug = (slug: string): AtlasComparison | undefined => comparisonBySlug.get(slug);
export const getBacklog = (entityId: string): AtlasBacklogItem | undefined => backlogByEntity.get(entityId);
export const getStaticPage = (route: string): AtlasStaticPage | undefined => staticByRoute.get(route);

/** Resolve ids to entities, silently skipping none: an unknown id is a content bug the validator catches. */
export function entitiesFor(ids: string[]): AtlasEntity[] {
  return ids.map((id) => byId.get(id)).filter((e): e is AtlasEntity => Boolean(e));
}

export const guidesForCategory = (categoryId: string): AtlasGuide[] => guides.filter((g) => g.category_id === categoryId);
export const guidesListing = (entityId: string): AtlasGuide[] => guides.filter((g) => g.candidate_ids.includes(entityId));
export const comparisonsIncluding = (entityId: string): AtlasComparison[] => comparisons.filter((c) => c.entity_ids.includes(entityId));
export const categoryMembers = (c: AtlasCategory): AtlasEntity[] => entitiesFor(c.entity_ids);

/** Explicit operator relationships (e.g. Cognition operates Devin) — vendor-documented, with sources. */
export function operatorRelations(entityId: string): { operates: AtlasRelationship[]; operatedBy: AtlasRelationship[] } {
  const ops = relationships.filter((r) => r.type === 'operates');
  return {
    operates: ops.filter((r) => r.from === entityId),
    operatedBy: ops.filter((r) => r.to === entityId),
  };
}

// ── Counts (always computed from the imported data, never hard-coded) ──────

export function countBy<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export const counts = {
  entities: entities.length,
  byDepth: countBy(entities.map((e) => e.profile_depth)),
  byType: countBy(entities.map((e) => e.entity_type)),
  categories: categories.length,
  guides: guides.length,
  comparisons: comparisons.length,
  glossary: glossary.length,
  faq: faq.length,
};

// ── Search & filters ───────────────────────────────────────────────────────

/** The only filters the atlas offers (site-copy.json `filters`). */
export interface AtlasFilters {
  q: string;
  type: string;
  category: string;
  depth: '' | ProfileDepth;
}

export const EMPTY_FILTERS: AtlasFilters = { q: '', type: '', category: '', depth: '' };

/** Query-string keys used for each filter; the typed query and filters live in the URL. */
export const FILTER_PARAMS = { q: 'q', type: 'type', category: 'category', depth: 'depth' } as const;

export function filtersFromParams(params: URLSearchParams): AtlasFilters {
  const depth = params.get(FILTER_PARAMS.depth) ?? '';
  return {
    q: params.get(FILTER_PARAMS.q) ?? '',
    type: params.get(FILTER_PARAMS.type) ?? '',
    category: params.get(FILTER_PARAMS.category) ?? '',
    depth: (['directory_entry', 'expanded_profile', 'protocol_profile'].includes(depth) ? depth : '') as AtlasFilters['depth'],
  };
}

export function paramsFromFilters(f: AtlasFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set(FILTER_PARAMS.q, f.q);
  if (f.type) p.set(FILTER_PARAMS.type, f.type);
  if (f.category) p.set(FILTER_PARAMS.category, f.category);
  if (f.depth) p.set(FILTER_PARAMS.depth, f.depth);
  return p;
}

export const hasActiveFilters = (f: AtlasFilters): boolean => Boolean(f.q.trim() || f.type || f.category || f.depth);

/** Lowercase, strip diacritics, collapse separators — so "muller", "Müller" and "mcp_server" all match. */
export function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[_\-./]+/g, ' ');
}

const haystacks = new Map(
  entities.map((e) => [
    e.id,
    normalize([e.name, e.description, e.source_category, categoryById.get(e.category_id)?.title ?? '', e.entity_type].join(' \u0000 ')),
  ]),
);

/**
 * Search over name, description, source category, category title and entity
 * type (IMPLEMENTATION.md, "Browse and search"). Every query word must match.
 * Results keep a neutral alphabetical order — no relevance score or ranking.
 */
export function searchEntities(f: AtlasFilters, list: AtlasEntity[] = entities): AtlasEntity[] {
  const words = normalize(f.q).split(/\s+/).filter(Boolean);
  return list
    .filter((e) => !f.type || e.entity_type === f.type)
    .filter((e) => !f.category || e.category_id === f.category)
    .filter((e) => !f.depth || e.profile_depth === f.depth)
    .filter((e) => {
      if (!words.length) return true;
      const h = haystacks.get(e.id) ?? '';
      return words.every((w) => h.includes(w));
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

// ── Routes & launch controls ───────────────────────────────────────────────

export const ATLAS_ROUTES: string[] = routeManifest.map((r) => r.route);
const KNOWN_ROUTES = new Set(ATLAS_ROUTES);
export const isAtlasRoute = (route: string): boolean => KNOWN_ROUTES.has(route);

const APPROVED = new Set(launchManifest.approved_indexable_routes);

/**
 * Robots value for a route, computed from implementation/launch-manifest.json —
 * the publication switch. A route is indexable only once it is listed in
 * `approved_indexable_routes`; the record's own default robots string never
 * overrides an approval. `forceNoindex` is the preview switch: previews are
 * noindex site-wide regardless of approval.
 */
export function robotsFor(route: string, forceNoindex = false, approved: ReadonlySet<string> = APPROVED): string {
  if (!forceNoindex && KNOWN_ROUTES.has(route) && approved.has(route)) return 'index,follow';
  return launchManifest.default_robots || 'noindex,follow';
}

export const isApproved = (route: string, approved: ReadonlySet<string> = APPROVED): boolean => approved.has(route) && KNOWN_ROUTES.has(route);

/** The production sitemap for the atlas: approved routes only — never drafts, facets or search URLs. */
export function atlasSitemapXml(forceNoindex = false, approved: ReadonlySet<string> = APPROVED): string {
  const rows = forceNoindex
    ? []
    : ATLAS_ROUTES.filter((r) => isApproved(r, approved)).map(
      (r) => `  <url><loc>${SITE}${r}</loc><lastmod>${siteCopy.content_as_of}</lastmod></url>`,
    );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}${rows.length ? '\n' : ''}</urlset>\n`;
}
