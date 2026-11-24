/**
 * /atlas — the atlas landing page: search over every record with the three
 * filters site-copy.json allows (entity type, category, profile depth). The
 * typed query and filters live in the URL (?q=&type=&category=&depth=), so a
 * search is shareable; filtered URLs are noindex and never in the sitemap.
 *
 * Without JavaScript the form is a plain GET to /atlas. With it, the first
 * client render matches the prerendered (unfiltered) markup and the URL's
 * filters apply right after hydration.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  categories, comparisons, counts, EMPTY_FILTERS, filtersFromParams, guides, hasActiveFilters, paramsFromFilters,
  searchEntities, siteCopy, type AtlasFilters,
} from '../data';
import { DEPTH_LABELS, entityTypeLabel } from '../format';
import { breadcrumbsFor, type AtlasResolved } from '../resolve';
import { AtlasShell, BasedAgentsCta, CardGrid, EntityCard, EvidenceNotice } from '../ui';

const HOME = siteCopy.homepage;

const typeOptions = Object.entries(counts.byType)
  .map(([value, n]) => ({ value, label: entityTypeLabel(value), n }))
  .sort((a, b) => a.label.localeCompare(b.label));
const categoryOptions = categories.map((c) => ({ value: c.id, label: c.title, n: c.entity_ids.length }));
const depthOptions = Object.entries(DEPTH_LABELS).map(([value, label]) => ({ value, label, n: counts.byDepth[value] ?? 0 }));

function Results({ filters, onClear }: { filters: AtlasFilters; onClear: () => void }): React.ReactElement {
  const results = searchEntities(filters);
  const active = hasActiveFilters(filters);
  return (
    <section className="atlas-section" aria-labelledby="results-h" id="records">
      <h2 id="results-h">{active ? 'Matching records' : `All ${counts.entities} records`}</h2>
      <p className="atlas-section-note" aria-live="polite" aria-atomic="true">
        {active ? `${results.length} of ${counts.entities} records match.` : `${counts.entities} records, in alphabetical order. Order is not a ranking.`}
      </p>
      {results.length === 0 ? (
        <div className="atlas-empty">
          <p>{siteCopy.ui.empty_search}</p>
          <button type="button" className="btn btn-secondary" onClick={onClear}>Clear all</button>
        </div>
      ) : (
        <CardGrid>{results.map((e) => <EntityCard key={e.id} entity={e} />)}</CardGrid>
      )}
    </section>
  );
}

export default function Landing({ r }: { r: Extract<AtlasResolved, { kind: 'home' }> }): React.ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<AtlasFilters>(EMPTY_FILTERS);
  const pushed = useRef<string | null>(null);

  // URL → state (on load, back/forward, or a link to a filtered view).
  useEffect(() => {
    const search = location.search.replace(/^\?/, '');
    if (search === pushed.current) return;
    setFilters(filtersFromParams(new URLSearchParams(search)));
  }, [location.search]);

  // State → URL. replace: typing should not stack history entries.
  const update = (patch: Partial<AtlasFilters>): void => {
    const next = { ...filters, ...patch };
    setFilters(next);
    const s = paramsFromFilters(next).toString();
    pushed.current = s;
    navigate({ pathname: '/atlas', search: s ? `?${s}` : '' }, { replace: true });
  };
  const clear = (): void => update(EMPTY_FILTERS);
  const active = hasActiveFilters(filters);
  const results = <Results filters={filters} onClear={clear} />;

  return (
    <AtlasShell route={r.route} crumbs={breadcrumbsFor(r)} wide>
      <header className="atlas-hero">
        <p className="atlas-kicker">{siteCopy.product_name}</p>
        <h1 className="atlas-hero-title">{HOME.title}</h1>
        <p className="atlas-lead">{HOME.subtitle}</p>
        <p className="atlas-stats">
          {counts.entities} records · {counts.categories} categories · {counts.byDepth.protocol_profile ?? 0} protocols ·{' '}
          {counts.guides} task guides · {counts.glossary} glossary terms
        </p>

        <form
          role="search"
          className="atlas-search"
          method="get"
          action="/atlas"
          aria-label="Search the atlas"
          onSubmit={(ev) => { ev.preventDefault(); document.getElementById('records')?.scrollIntoView({ behavior: 'smooth' }); }}
        >
          <label htmlFor="atlas-q" className="atlas-sr">Search</label>
          <input
            id="atlas-q"
            name="q"
            type="search"
            autoComplete="off"
            placeholder={HOME.search_placeholder}
            value={filters.q}
            onChange={(ev) => update({ q: ev.target.value })}
          />
          <div className="atlas-filters">
            <label>
              <span>Type</span>
              <select name="type" value={filters.type} onChange={(ev) => update({ type: ev.target.value })}>
                <option value="">All types</option>
                {typeOptions.map((o) => <option key={o.value} value={o.value}>{o.label} ({o.n})</option>)}
              </select>
            </label>
            <label>
              <span>Category</span>
              <select name="category" value={filters.category} onChange={(ev) => update({ category: ev.target.value })}>
                <option value="">All categories</option>
                {categoryOptions.map((o) => <option key={o.value} value={o.value}>{o.label} ({o.n})</option>)}
              </select>
            </label>
            <label>
              <span>Profile depth</span>
              <select name="depth" value={filters.depth} onChange={(ev) => update({ depth: ev.target.value as AtlasFilters['depth'] })}>
                <option value="">All depths</option>
                {depthOptions.map((o) => <option key={o.value} value={o.value}>{o.label} ({o.n})</option>)}
              </select>
            </label>
            <noscript><button type="submit" className="btn btn-secondary">Search</button></noscript>
            <button type="button" className="btn btn-secondary atlas-clear" onClick={clear} disabled={!active}>Clear all</button>
          </div>
        </form>

        <p className="atlas-hero-ctas">
          <a className="btn btn-primary" href={HOME.primary_cta.href}>{HOME.primary_cta.label}</a>
          <a className="btn btn-secondary" href={HOME.secondary_cta.href}>{HOME.secondary_cta.label}</a>
        </p>
      </header>

      <EvidenceNotice route={r.route} />

      {active && results}

      <section className="atlas-section" aria-label="How to use the atlas">
        <div className="atlas-pillars">
          {HOME.sections.map((s) => (
            <div key={s.heading} className="atlas-pillar">
              <h2>{s.heading}</h2>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="atlas-section" aria-labelledby="browse-h">
        <h2 id="browse-h">Browse by category</h2>
        <div className="atlas-tiles">
          {categories.map((c) => (
            <a key={c.id} href={c.route} className="atlas-tile">
              <span className="atlas-tile-title">{c.title}</span>
              <span className="atlas-tile-meta">{c.entity_ids.length} records</span>
            </a>
          ))}
        </div>
        <p className="atlas-inline-links">
          Also: <a href="/protocols">Protocols explained</a> · <a href="/guides">{guides.length} task guides</a> ·{' '}
          <a href="/glossary">Glossary</a> · <a href="/faq">FAQ</a>
        </p>
      </section>

      <section className="atlas-section" aria-labelledby="compare-h">
        <h2 id="compare-h">Comparisons</h2>
        <p className="atlas-section-note">Source-linked comparisons of the layer each record covers. No winners or scores.</p>
        <ul className="atlas-link-list">
          {comparisons.map((c) => <li key={c.id}><a href={c.route}>{c.title}</a></li>)}
        </ul>
      </section>

      {!active && results}

      <BasedAgentsCta source="atlas" />
    </AtlasShell>
  );
}
