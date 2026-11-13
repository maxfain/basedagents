/**
 * Browse hubs: /categories, /categories/{id}, /protocols, /guides.
 * Counts are computed from the imported data; member order is alphabetical
 * (not a ranking). Directory cards appear in hubs even though their thin
 * individual profiles stay noindex.
 */
import React from 'react';
import {
  categories, categoryMembers, comparisons, entities, entitiesFor, getProtocol, guides, guidesForCategory,
} from '../data';
import { contentStatusLabel, entityTypeLabel } from '../format';
import { breadcrumbsFor, HUB_COPY, type AtlasResolved } from '../resolve';
import { AtlasShell, Badge, BasedAgentsCta, CardGrid, EntityCard, EvidenceNotice } from '../ui';

const byName = <T extends { name: string }>(a: T, b: T): number => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

export function CategoriesHub({ r }: { r: Extract<AtlasResolved, { kind: 'categories' }> }): React.ReactElement {
  const copy = HUB_COPY.categories;
  return (
    <AtlasShell route={r.route} crumbs={breadcrumbsFor(r)} wide>
      <header className="atlas-header">
        <h1>{copy.h1}</h1>
        <p className="atlas-lead">{copy.intro}</p>
      </header>
      <EvidenceNotice route={r.route} />
      <div className="atlas-grid atlas-grid-wide">
        {categories.map((c) => {
          const g = guidesForCategory(c.id).length;
          return (
            <a key={c.id} href={c.route} className="atlas-card">
              <h2 className="atlas-card-title">{c.title}</h2>
              <span className="atlas-card-desc">{c.intro}</span>
              <span className="atlas-card-meta">
                <span className="atlas-card-cat">{c.entity_ids.length} records{g ? ` · ${g} task guide${g > 1 ? 's' : ''}` : ''}</span>
              </span>
            </a>
          );
        })}
      </div>
      <BasedAgentsCta source="categories" />
    </AtlasShell>
  );
}

export function CategoryPage({ r }: { r: Extract<AtlasResolved, { kind: 'category' }> }): React.ReactElement {
  const c = r.category;
  const members = categoryMembers(c).sort(byName);
  const catGuides = guidesForCategory(c.id);
  const memberIds = new Set(c.entity_ids);
  const catComparisons = comparisons.filter((x) => x.entity_ids.some((id) => memberIds.has(id)));
  const typeCounts = members.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.entity_type]: (acc[e.entity_type] ?? 0) + 1 }), {});
  return (
    <AtlasShell route={r.route} crumbs={breadcrumbsFor(r)} wide>
      <header className="atlas-header">
        <h1>{c.title}</h1>
        <p className="atlas-lead">{c.intro}</p>
        <p className="atlas-stats">
          {members.length} records:{' '}
          {Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${entityTypeLabel(t).toLowerCase()}`).join(' · ')}
        </p>
      </header>
      <EvidenceNotice route={r.route} />

      <section className="atlas-section" aria-labelledby="guidance-h">
        <h2 id="guidance-h">What to compare</h2>
        <div className="atlas-editorial">
          <Badge tone="muted">{contentStatusLabel(c.content_status)}</Badge>
          <p>{c.buyer_guidance}</p>
        </div>
      </section>

      {catGuides.length > 0 && (
        <section className="atlas-section" aria-labelledby="guides-h">
          <h2 id="guides-h">Task guides for this category</h2>
          <ul className="atlas-link-list">
            {catGuides.map((g) => <li key={g.id}><a href={g.route}>{g.title}</a> — <span className="text-secondary">{g.deliverable}</span></li>)}
          </ul>
        </section>
      )}

      {catComparisons.length > 0 && (
        <section className="atlas-section" aria-labelledby="cmp-h">
          <h2 id="cmp-h">Comparisons</h2>
          <ul className="atlas-link-list">
            {catComparisons.map((x) => <li key={x.id}><a href={x.route}>{x.title}</a></li>)}
          </ul>
        </section>
      )}

      <section className="atlas-section" aria-labelledby="members-h">
        <h2 id="members-h">Records in this category</h2>
        <p className="atlas-section-note">Alphabetical; not a ranking. Each card shows the record's supplied type and profile depth.</p>
        <CardGrid>{members.map((e) => <EntityCard key={e.id} entity={e} />)}</CardGrid>
      </section>

      <p className="atlas-inline-links">
        Other categories:{' '}
        {categories.filter((x) => x.id !== c.id).map((x, i) => (
          <React.Fragment key={x.id}>{i > 0 && ' · '}<a href={x.route}>{x.title}</a></React.Fragment>
        ))}
      </p>

      <BasedAgentsCta source={`category-${c.id}`} />
    </AtlasShell>
  );
}

export function ProtocolsHub({ r }: { r: Extract<AtlasResolved, { kind: 'protocols' }> }): React.ReactElement {
  const copy = HUB_COPY.protocols;
  const protocolEntities = entities.filter((e) => e.profile_depth === 'protocol_profile').sort(byName);
  const protocolIds = new Set(protocolEntities.map((e) => e.id));
  const protocolComparisons = comparisons.filter((x) => x.entity_ids.some((id) => protocolIds.has(id)));
  return (
    <AtlasShell route={r.route} crumbs={breadcrumbsFor(r)} wide>
      <header className="atlas-header">
        <h1>{copy.h1}</h1>
        <p className="atlas-lead">{copy.intro}</p>
      </header>
      <EvidenceNotice route={r.route} />

      {protocolComparisons.length > 0 && (
        <section className="atlas-section" aria-labelledby="pc-h">
          <h2 id="pc-h">Compare protocols</h2>
          <ul className="atlas-link-list">
            {protocolComparisons.map((x) => <li key={x.id}><a href={x.route}>{x.title}</a></li>)}
          </ul>
        </section>
      )}

      <section className="atlas-section" aria-labelledby="pl-h">
        <h2 id="pl-h">{protocolEntities.length} protocol records</h2>
        <div className="atlas-grid atlas-grid-wide">
          {protocolEntities.map((e) => {
            const p = getProtocol(e.id);
            return (
              <a key={e.id} href={e.route} className="atlas-card">
                <h3 className="atlas-card-title">{e.name}</h3>
                <span className="atlas-card-meta">
                  {p && <Badge tone="accent">{p.layer}</Badge>}
                  {(p?.version_note ?? e.version_note) && <Badge tone="warn">{(p?.version_note ?? e.version_note)!.length <= 24 ? (p?.version_note ?? e.version_note) : 'Lifecycle note'}</Badge>}
                </span>
                <span className="atlas-card-desc">{p?.answer ?? e.description}</span>
              </a>
            );
          })}
        </div>
      </section>

      <BasedAgentsCta source="protocols" />
    </AtlasShell>
  );
}

export function GuidesHub({ r }: { r: Extract<AtlasResolved, { kind: 'guides' }> }): React.ReactElement {
  const copy = HUB_COPY.guides;
  const order = categories.filter((c) => guides.some((g) => g.category_id === c.id));
  return (
    <AtlasShell route={r.route} crumbs={breadcrumbsFor(r)} wide>
      <header className="atlas-header">
        <h1>{copy.h1}</h1>
        <p className="atlas-lead">{copy.intro}</p>
        <p className="atlas-section-note">
          Each guide is a test design — inputs, deliverable, procedure, approval boundary and acceptance criteria. None has been executed for this release; listed candidates are research starting points, not tested recommendations.
        </p>
      </header>
      <EvidenceNotice route={r.route} />
      {order.map((c) => (
        <section key={c.id} className="atlas-section" aria-labelledby={`g-${c.id}`}>
          <h2 id={`g-${c.id}`}><a href={c.route}>{c.title}</a></h2>
          <div className="atlas-grid atlas-grid-wide">
            {guidesForCategory(c.id).map((g) => (
              <a key={g.id} href={g.route} className="atlas-card">
                <h3 className="atlas-card-title">{g.title}</h3>
                <span className="atlas-card-desc"><strong>Deliverable:</strong> {g.deliverable}</span>
                <span className="atlas-card-meta">
                  <span className="atlas-card-cat">Candidates: {entitiesFor(g.candidate_ids).map((e) => e.name).join(', ')}</span>
                </span>
              </a>
            ))}
          </div>
        </section>
      ))}
      <BasedAgentsCta source="guides" />
    </AtlasShell>
  );
}

