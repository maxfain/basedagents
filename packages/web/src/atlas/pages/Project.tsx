/**
 * /projects/{slug} — one record, composed as IMPLEMENTATION.md "Project-page
 * composition" lays out: identity, evidence status, (protocol explanation),
 * what it does, interfaces, pricing, people/organization/funding, stated goal,
 * editorial guidance, evidence gaps, related records, sources.
 *
 * Sections render only when the content package populates them; everything it
 * does not establish is collected in the compact "Evidence gaps" list instead
 * of being padded with prose.
 */
import React from 'react';
import {
  comparisonsIncluding, entitiesFor, getBacklog, getCategory, getEntity, getProtocol, guidesListing, operatorRelations, SITE, siteCopy,
} from '../data';
import {
  contentStatusLabel, entityTypeLabel, depthLabel, factLabel, factStatusLabel, formatDate, humanize, identityStatusLabel, shortUrl,
} from '../format';
import { breadcrumbsFor, type AtlasResolved } from '../resolve';
import type { AtlasEntity, AtlasFact, PricingSummary } from '../types';
import {
  AtlasShell, Badge, BasedAgentsCta, CardGrid, EntityCard, EvidenceNotice, ExternalLink, FactRow, Missing, Section,
} from '../ui';

const UI = siteCopy.ui;

type Group = 'what' | 'interfaces' | 'org' | 'mission' | 'pricing' | 'evaluation';

function groupOf(path: string): Group {
  if (/^pricing\./.test(path)) return 'pricing';
  if (/^(interfaces|payments|protocols)\./.test(path)) return 'interfaces';
  if (/^(operator|people|organization\.|funding\.)/.test(path)) return 'org';
  if (path === 'stated_goal') return 'mission';
  if (path === 'evaluations') return 'evaluation';
  return 'what';
}

const isGap = (f: AtlasFact): boolean => f.status === 'unknown' || f.value === null;

/** Pricing caveats that IMPLEMENTATION.md requires to stay visible next to these snapshots. */
const PRICING_CAVEATS: Record<string, string> = {
  letta: 'Included credits are a plan allowance, not measured spend.',
};

interface SourceRow { url: string; labels: string[]; observed?: string; published?: string | null; summaries: string[] }

/** Every URL the record cites, de-duplicated for display (evidence ids stay on the facts that cite them). */
function collectSources(e: AtlasEntity): SourceRow[] {
  const rows = new Map<string, SourceRow>();
  const add = (url: string, patch: Partial<SourceRow> & { label?: string; summary?: string }): void => {
    const row = rows.get(url) ?? { url, labels: [], summaries: [] };
    if (patch.label && !row.labels.includes(patch.label)) row.labels.push(patch.label);
    if (patch.summary && !row.summaries.includes(patch.summary)) row.summaries.push(patch.summary);
    if (patch.observed && !row.observed) row.observed = patch.observed;
    if (patch.published && !row.published) row.published = patch.published;
    rows.set(url, row);
  };
  for (const s of e.sources) add(s.url, { label: humanize(s.evidence_status), observed: s.observed_at });
  for (const ev of e.evidence) add(ev.url, { label: humanize(ev.source_kind), observed: ev.retrieved_on, published: ev.published_on, summary: ev.summary });
  for (const s of getProtocol(e.id)?.sources ?? []) add(s.url, { label: humanize(s.evidence_status), observed: s.observed_at });
  if (e.pricing && 'summary' in e.pricing) add(e.pricing.source_url, { label: 'Pricing page', observed: e.pricing.observed_at });
  for (const f of e.facts) for (const u of f.source_urls ?? []) add(u, {});
  return [...rows.values()];
}

function PricingSummaryBlock({ p, entityId }: { p: PricingSummary; entityId: string }): React.ReactElement {
  return (
    <div className="atlas-fact">
      <div className="atlas-fact-head">
        <h3 className="atlas-fact-label">Pricing snapshot</h3>
        <Badge>{factStatusLabel(p.status)}</Badge>
      </div>
      <p className="atlas-fact-value">{p.summary}</p>
      {PRICING_CAVEATS[entityId] && <p className="atlas-fact-note"><strong>Note:</strong> {PRICING_CAVEATS[entityId]}</p>}
      {p.not_cost_per_task && <p className="atlas-fact-note">Plan prices are not a cost per completed task.</p>}
      <p className="atlas-cite">
        Source: <ExternalLink href={p.source_url}>{shortUrl(p.source_url)}</ExternalLink>
        <span className="atlas-cite-date"> (observed {formatDate(p.observed_at)}; currency {p.currency})</span>
      </p>
    </div>
  );
}

export default function ProjectPage({ r }: { r: Extract<AtlasResolved, { kind: 'project' }> }): React.ReactElement {
  const e = r.entity;
  const category = getCategory(e.category_id);
  const protocol = getProtocol(e.id);
  const backlog = getBacklog(e.id);
  const rel = operatorRelations(e.id);
  const facts = e.facts.filter((f) => !isGap(f));
  const gaps = e.facts.filter(isGap);
  const byGroup = (g: Group): AtlasFact[] => facts.filter((f) => groupOf(f.path) === g);
  const what = byGroup('what');
  const interfaces = byGroup('interfaces');
  const org = byGroup('org');
  const mission = byGroup('mission');
  const pricingFacts = e.pricing && 'facts' in e.pricing ? e.pricing.facts.filter((f) => !isGap(f)) : [];
  const pricingSummary = e.pricing && 'summary' in e.pricing ? e.pricing : null;
  const hasPricing = Boolean(pricingSummary || pricingFacts.length);
  const sources = collectSources(e);
  const guides = guidesListing(e.id);
  const comparisons = comparisonsIncluding(e.id);
  const related = entitiesFor(e.related_ids);

  // Fields the inspected sources did not establish — listed, never guessed.
  const notEstablished = [
    !hasPricing && 'Pricing',
    !interfaces.length && 'Documented interfaces (MCP or other)',
    !org.length && 'People, organization and funding',
    !e.repository_url && 'Repository',
  ].filter((x): x is string => Boolean(x));
  const checks = [...new Set([...e.unknown_fields, ...(backlog?.required_checks ?? [])])];

  return (
    <AtlasShell route={r.route} crumbs={breadcrumbsFor(r)}>
      <article className="atlas-article">
        {/* 2. Identity */}
        <header className="atlas-header">
          <p className="atlas-kicker">
            <Badge tone="accent">{entityTypeLabel(e.entity_type)}</Badge>
            <Badge tone="muted">{depthLabel(e.profile_depth)}</Badge>
            {e.version_note && e.version_note.length <= 24 && <Badge tone="warn">{e.version_note}</Badge>}
          </p>
          <h1>{e.name}</h1>
          <p className="atlas-lead">{e.description}</p>
          <p className="atlas-header-links">
            {e.website_url ? (
              <ExternalLink href={e.website_url} className="atlas-pill-link">Official link: {shortUrl(e.website_url)}</ExternalLink>
            ) : e.discovery_url ? (
              <ExternalLink href={e.discovery_url} className="atlas-pill-link">Discovery link (registry listing, not a product homepage): {shortUrl(e.discovery_url)}</ExternalLink>
            ) : null}
            {e.website_url && e.discovery_url && e.discovery_url !== e.website_url && (
              <ExternalLink href={e.discovery_url} className="atlas-pill-link">Discovery link: {shortUrl(e.discovery_url)}</ExternalLink>
            )}
            <span className="atlas-header-date">Sources checked {formatDate(e.reviewed_at)}</span>
          </p>
          {(rel.operatedBy.length > 0 || rel.operates.length > 0) && (
            <p className="atlas-relation">
              {rel.operatedBy.map((x) => (
                <span key={x.from}>Operated by <a href={getEntity(x.from)?.route}>{getEntity(x.from)?.name ?? x.from}</a> </span>
              ))}
              {rel.operates.map((x) => (
                <span key={x.to}>Operates <a href={getEntity(x.to)?.route}>{getEntity(x.to)?.name ?? x.to}</a> </span>
              ))}
              <Badge>{UI.vendor_documented}</Badge>
              {[...rel.operatedBy, ...rel.operates].flatMap((x) => x.sources ?? []).slice(0, 1).map((u) => (
                <span key={u} className="atlas-cite"> Source: <ExternalLink href={u}>{shortUrl(u)}</ExternalLink></span>
              ))}
            </p>
          )}
        </header>

        <EvidenceNotice route={r.route} />

        {/* 3. Evidence status */}
        <Section id="evidence" title="Evidence status">
          <dl className="atlas-status">
            <dt>Description</dt>
            <dd>{contentStatusLabel(e.description_status)}</dd>
            <dt>Testing</dt>
            <dd>
              <Badge tone="warn">{UI.not_tested}</Badge>{' '}
              No runtime test, payment test or security audit was performed for this release.
              {' '}A source shows that something is documented, not that it was independently tested.
            </dd>
            <dt>Identity</dt>
            <dd>{identityStatusLabel(e.identity_status)}</dd>
            {e.evidence_note && (<><dt>Evidence note</dt><dd>{e.evidence_note}</dd></>)}
            {e.version_note && (<><dt>Version or lifecycle</dt><dd>{e.version_note}</dd></>)}
          </dl>
        </Section>

        {/* Protocol records: the source-based explanation on the canonical project route. */}
        {protocol && (
          <Section id="protocol" title={protocol.title} note={contentStatusLabel(protocol.editorial_status)}>
            <dl className="atlas-status">
              <dt>Layer</dt><dd>{protocol.layer}</dd>
            </dl>
            <p className="atlas-answer">{protocol.answer}</p>
            <h3 className="atlas-h3">Limitations</h3>
            <p>{protocol.limitations}</p>
            {protocol.version_note && (
              <>
                <h3 className="atlas-h3">Version and lifecycle</h3>
                <p className="atlas-callout-warn">{protocol.version_note}</p>
              </>
            )}
            <h3 className="atlas-h3">Implementation checklist <Badge tone="muted">Editorial</Badge></h3>
            <ol className="atlas-steps">
              {protocol.implementation_checklist.map((s) => <li key={s}>{s.replace(/\.$/, '')}</li>)}
            </ol>
            <p className="atlas-cite">
              Sources:{' '}
              {protocol.sources.map((s, i) => (
                <React.Fragment key={s.url}>{i > 0 && ', '}<ExternalLink href={s.url}>{shortUrl(s.url)}</ExternalLink></React.Fragment>
              ))}
            </p>
          </Section>
        )}

        {/* 4. What it does */}
        <Section id="what" title="What it does">
          {what.length > 0 ? (
            what.map((f) => <FactRow key={f.path} fact={f} entity={e} />)
          ) : (
            <div className="atlas-fact">
              <div className="atlas-fact-head">
                <h3 className="atlas-fact-label">Description</h3>
                <Badge>{UI.source_summary}</Badge>
              </div>
              <p className="atlas-fact-value">{e.description}</p>
              <p className="atlas-cite">
                Source: <ExternalLink href={e.sources[0].url}>{shortUrl(e.sources[0].url)}</ExternalLink>
                <span className="atlas-cite-date"> (observed {formatDate(e.sources[0].observed_at)})</span>
              </p>
            </div>
          )}
        </Section>

        {/* 5. Interfaces */}
        {interfaces.length > 0 && (
          <Section id="interfaces" title="Interfaces" note="Documented endpoints and integrations with their stated role, authentication and scope. Listed as documented, not as tested.">
            {interfaces.map((f) => <FactRow key={f.path} fact={f} entity={e} />)}
          </Section>
        )}

        {/* 6. Pricing */}
        {hasPricing && (
          <Section id="pricing" title="Pricing" note={UI.pricing_note}>
            {pricingSummary && <PricingSummaryBlock p={pricingSummary} entityId={e.id} />}
            {pricingFacts.map((f) => <FactRow key={f.path} fact={f} entity={e} />)}
          </Section>
        )}

        {/* 7. People, organization and funding */}
        {org.length > 0 && (
          <Section id="organization" title="People, organization and funding" note="Funding figures are announced rounds attributed to the stated organization — not lifetime totals.">
            {org.map((f) => <FactRow key={f.path} fact={f} entity={e} />)}
          </Section>
        )}

        {/* 8. Stated goal */}
        {mission.length > 0 && (
          <Section id="goal" title="Stated goal" note="The goal the organization states, as summarized from the cited source — not an editorial assessment.">
            {mission.map((f) => <FactRow key={f.path} fact={f} entity={e} />)}
          </Section>
        )}

        {/* 9. Editorial guidance — visibly separate from facts. */}
        {e.editorial_inference && e.editorial_inference.length > 0 && (
          <Section id="guidance" title="How to evaluate it" note="Editorial guidance and inference from the atlas — not a claim by the vendor and not a test result.">
            {e.editorial_inference.map((x) => (
              <div key={x.text} className="atlas-editorial">
                <Badge tone="muted">{x.label}</Badge>
                <p>{x.text}</p>
              </div>
            ))}
          </Section>
        )}

        {/* 10. Evidence gaps */}
        <Section id="gaps" title="Evidence gaps" note="What the inspected sources did not establish. Unknown does not mean absent or unsupported.">
          <ul className="atlas-gaps">
            {gaps.map((f) => (
              <li key={f.path}>
                <strong>{factLabel(f.path)}:</strong> <Missing />{f.note ? ` — ${f.note}` : ''}
              </li>
            ))}
            {notEstablished.map((x) => (
              <li key={x}><strong>{x}:</strong> <Missing /></li>
            ))}
          </ul>
          {checks.length > 0 && (
            <>
              <h3 className="atlas-h3">
                Verification backlog {backlog?.priority === 'high' && <Badge tone="warn">High priority</Badge>}
              </h3>
              <ul className="atlas-gaps">
                {checks.map((c) => <li key={c}>{c}</li>)}
              </ul>
            </>
          )}
        </Section>

        {/* 11. Related records */}
        <Section id="related" title={UI.related_heading} note={UI.related_note}>
          {category && (
            <p className="atlas-inline-links">
              Category: <a href={category.route}>{category.title}</a>
            </p>
          )}
          {guides.length > 0 && (
            <p className="atlas-inline-links">
              Listed as a research starting point (not a tested recommendation) in:{' '}
              {guides.map((g, i) => <React.Fragment key={g.id}>{i > 0 && ', '}<a href={g.route}>{g.title}</a></React.Fragment>)}
            </p>
          )}
          {comparisons.length > 0 && (
            <p className="atlas-inline-links">
              Compared in:{' '}
              {comparisons.map((c, i) => <React.Fragment key={c.id}>{i > 0 && ', '}<a href={c.route}>{c.title}</a></React.Fragment>)}
            </p>
          )}
          {related.length > 0 && (
            <CardGrid>{related.map((x) => <EntityCard key={x.id} entity={x} />)}</CardGrid>
          )}
          {protocol && protocol.related_ids.some((id) => !e.related_ids.includes(id)) && (
            <p className="atlas-inline-links">
              Related protocols and schemas:{' '}
              {entitiesFor(protocol.related_ids.filter((id) => !e.related_ids.includes(id))).map((x, i) => (
                <React.Fragment key={x.id}>{i > 0 && ', '}<a href={x.route}>{x.name}</a></React.Fragment>
              ))}
            </p>
          )}
        </Section>

        {/* 12. Sources and corrections */}
        <Section id="sources" title="Sources">
          <ol className="atlas-sources">
            {sources.map((s) => (
              <li key={s.url}>
                <ExternalLink href={s.url}>{shortUrl(s.url)}</ExternalLink>
                <span className="atlas-source-meta">
                  {s.labels.length > 0 && ` · ${s.labels.join('; ')}`}
                  {s.observed && ` · observed ${formatDate(s.observed)}`}
                  {s.published && ` · published ${formatDate(s.published)}`}
                </span>
                {s.summaries.map((x) => <span key={x} className="atlas-source-summary">{x}</span>)}
              </li>
            ))}
          </ol>
          <p className="atlas-correction">
            Spotted something out of date? <a href={`/corrections?profile=${encodeURIComponent(`${SITE}${r.route}`)}`}>{UI.correction_cta}</a>
          </p>
        </Section>
      </article>

      <BasedAgentsCta source="project" />
    </AtlasShell>
  );
}
