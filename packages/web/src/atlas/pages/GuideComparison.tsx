/**
 * /guides/{id} — a task guide (test design, not executed) and
 * /compare/{id} — a source-linked comparison without winners or scores.
 */
import React from 'react';
import { entitiesFor, getCategory, getProtocol, SITE, siteCopy } from '../data';
import { contentStatusLabel, entityTypeLabel, depthLabel, factLabel, shortUrl } from '../format';
import { breadcrumbsFor, type AtlasResolved } from '../resolve';
import type { AtlasEntity } from '../types';
import { AtlasShell, Badge, BasedAgentsCta, CardGrid, EntityCard, EvidenceNotice, ExternalLink, FactValue } from '../ui';

function SourceList({ urls }: { urls: string[] }): React.ReactElement {
  return (
    <ol className="atlas-sources">
      {[...new Set(urls)].map((u) => <li key={u}><ExternalLink href={u}>{shortUrl(u)}</ExternalLink></li>)}
    </ol>
  );
}

export function GuidePage({ r }: { r: Extract<AtlasResolved, { kind: 'guide' }> }): React.ReactElement {
  const g = r.guide;
  const category = getCategory(g.category_id);
  const candidates = entitiesFor(g.candidate_ids);
  return (
    <AtlasShell route={r.route} crumbs={breadcrumbsFor(r)}>
      <article className="atlas-article">
        <header className="atlas-header">
          <p className="atlas-kicker">
            <Badge tone="warn">{contentStatusLabel(g.content_status)}</Badge>
            {category && <a href={category.route} className="atlas-card-cat">{category.title}</a>}
          </p>
          <h1>{g.title}</h1>
          <p className="atlas-lead">{g.intro}</p>
        </header>
        <EvidenceNotice route={r.route} />

        <dl className="atlas-spec">
          <dt>Inputs</dt>
          <dd>{g.inputs}</dd>
          <dt>Expected deliverable</dt>
          <dd>{g.deliverable}</dd>
          <dt>Procedure</dt>
          <dd>
            <ol className="atlas-steps">
              {g.steps.map((s) => <li key={s}>{s.replace(/\.$/, '')}</li>)}
            </ol>
          </dd>
          <dt>Approval boundary</dt>
          <dd>{g.approval_boundary}</dd>
          <dt>Acceptance criteria</dt>
          <dd>{g.acceptance_criteria}</dd>
          <dt>Failure modes</dt>
          <dd>{g.failure_modes}</dd>
        </dl>

        <section className="atlas-section" aria-labelledby="cand-h">
          <h2 id="cand-h">Candidates to investigate</h2>
          <p className="atlas-section-note">
            {contentStatusLabel(g.candidate_relationship)}. Research starting points — none of these has been run against this task.
          </p>
          <CardGrid>{candidates.map((e) => <EntityCard key={e.id} entity={e} />)}</CardGrid>
        </section>

        <section className="atlas-section" aria-labelledby="src-h">
          <h2 id="src-h">Sources</h2>
          <SourceList urls={g.sources} />
          <p className="atlas-correction">Something out of date? <a href="/corrections">{siteCopy.ui.correction_cta}</a></p>
        </section>
      </article>

      <BasedAgentsCta source={`guide-${g.id}`} guide={g} site={SITE} />
    </AtlasShell>
  );
}

const NOT_ESTABLISHED = 'Not established.';

/** Factual cells for one comparison candidate. Absent data reads "Not established." — never inferred. */
function CandidateCard({ e }: { e: AtlasEntity }): React.ReactElement {
  const protocol = getProtocol(e.id);
  const interfaces = e.facts.filter((f) => /^(interfaces|payments|protocols)\./.test(f.path) && f.status !== 'unknown' && f.value !== null);
  const pricingFacts = e.pricing && 'facts' in e.pricing ? e.pricing.facts : [];
  const pricingSummary = e.pricing && 'summary' in e.pricing ? e.pricing : null;
  const version = protocol?.version_note ?? e.version_note;
  return (
    <div className="atlas-compare-card">
      <h3><a href={e.route}>{e.name}</a></h3>
      <dl className="atlas-kv atlas-kv-wide">
        <dt>Type</dt>
        <dd>{entityTypeLabel(e.entity_type)} · {depthLabel(e.profile_depth)}</dd>
        <dt>Description</dt>
        <dd>{e.description}</dd>
        {protocol && (<><dt>Layer</dt><dd>{protocol.layer}</dd></>)}
        <dt>Official link</dt>
        <dd>{e.website_url ? <ExternalLink href={e.website_url}>{shortUrl(e.website_url)}</ExternalLink> : NOT_ESTABLISHED}</dd>
        <dt>Pricing snapshot</dt>
        <dd>
          {pricingSummary ? pricingSummary.summary
            : pricingFacts.length ? (
              <ul className="atlas-value-list">
                {pricingFacts.map((f) => <li key={f.path}><strong>{factLabel(f.path)}:</strong> <FactValue value={f.value} depth={1} /></li>)}
              </ul>
            ) : NOT_ESTABLISHED}
        </dd>
        <dt>Documented interfaces</dt>
        <dd>{interfaces.length ? interfaces.map((f) => factLabel(f.path)).join(', ') : NOT_ESTABLISHED}</dd>
        <dt>Version or lifecycle</dt>
        <dd>{version ?? NOT_ESTABLISHED}</dd>
        <dt>Runtime-tested here</dt>
        <dd>No — no record in this release was executed.</dd>
      </dl>
    </div>
  );
}

export function ComparisonPage({ r }: { r: Extract<AtlasResolved, { kind: 'comparison' }> }): React.ReactElement {
  const c = r.comparison;
  const candidates = entitiesFor(c.entity_ids);
  return (
    <AtlasShell route={r.route} crumbs={breadcrumbsFor(r)} wide>
      <article className="atlas-article">
        <header className="atlas-header">
          <p className="atlas-kicker"><Badge tone="warn">{contentStatusLabel(c.status)}</Badge></p>
          <h1>{c.title}</h1>
          <p className="atlas-answer">{c.answer}</p>
        </header>
        <EvidenceNotice route={r.route} />

        <section className="atlas-section" aria-labelledby="cands-h">
          <h2 id="cands-h">The records side by side</h2>
          <p className="atlas-section-note">Values come from each record's sources. No winner, score or ranking is established.</p>
          <div className="atlas-compare">
            {candidates.map((e) => <CandidateCard key={e.id} e={e} />)}
          </div>
        </section>

        <section className="atlas-section" aria-labelledby="dq-h">
          <h2 id="dq-h">Questions to decide with</h2>
          <ol className="atlas-steps">
            {c.decision_questions.map((q) => <li key={q}>{q}</li>)}
          </ol>
        </section>

        <section className="atlas-section" aria-labelledby="concl-h">
          <h2 id="concl-h">Conclusion</h2>
          <div className="atlas-editorial">
            <Badge tone="muted">Editorial</Badge>
            <p>{c.conclusion}</p>
          </div>
        </section>

        <section className="atlas-section" aria-labelledby="csrc-h">
          <h2 id="csrc-h">Sources</h2>
          <SourceList urls={c.sources} />
        </section>

        <section className="atlas-section" aria-labelledby="crel-h">
          <h2 id="crel-h">Full records</h2>
          <CardGrid>{candidates.map((e) => <EntityCard key={e.id} entity={e} />)}</CardGrid>
        </section>
      </article>
      <BasedAgentsCta source={`compare-${c.id}`} />
    </AtlasShell>
  );
}
