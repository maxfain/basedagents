/**
 * Shared Agent Atlas UI. Every link is a real <a href> (crawlable, keyboard
 * reachable); external links open in a new tab with rel="noopener noreferrer"
 * and are never auto-labelled sponsored/nofollow.
 */
import React from 'react';
import { positioning } from '../content/positioning';
import { funnelPing } from '../lib/funnel';
import { getCategory, getEntity, isApproved, siteCopy } from './data';
import {
  depthLabel, entityTypeLabel, factLabel, factStatusLabel, formatDate, formatMoney, hostOf, humanize, roleLabel, shortUrl,
} from './format';
import type { Crumb } from './resolve';
import type { AtlasEntity, AtlasEvidence, AtlasFact, AtlasGuide } from './types';

const UI = siteCopy.ui;

// ── Links ──────────────────────────────────────────────────────────────────

export function ExternalLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }): React.ReactElement {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
      <span className="atlas-sr"> (opens in a new tab)</span>
    </a>
  );
}

// ── Chrome ─────────────────────────────────────────────────────────────────

export function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }): React.ReactElement | null {
  if (crumbs.length < 2) return null;
  return (
    <nav aria-label="Breadcrumb" className="atlas-crumbs">
      <ol>
        {crumbs.map((c, i) => (
          <li key={c.href}>
            {i === crumbs.length - 1 ? <span aria-current="page">{c.name}</span> : <a href={c.href}>{c.name}</a>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function SubNav({ current }: { current: string }): React.ReactElement {
  return (
    <nav aria-label="Agent Atlas" className="atlas-subnav">
      <a href="/atlas" className="atlas-subnav-brand">{siteCopy.product_name}</a>
      <ul>
        {siteCopy.navigation.map((n) => {
          const active = current === n.href || (n.href !== '/atlas' && current.startsWith(`${n.href}/`));
          return (
            <li key={n.href}>
              <a href={n.href} aria-current={active ? 'page' : undefined} className={active ? 'active' : undefined}>{n.label}</a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Page frame shared by every atlas route: sub-navigation, breadcrumbs, evidence notice, footer note. */
export function AtlasShell({ route, crumbs, children, wide = false }: {
  route: string; crumbs: Crumb[]; children: React.ReactNode; wide?: boolean;
}): React.ReactElement {
  return (
    <div className="atlas">
      <div className={wide ? 'container-wide' : 'container'}>
        <SubNav current={route} />
        <Breadcrumbs crumbs={crumbs} />
        {children}
        <footer className="atlas-footnote">
          <p>{siteCopy.footer}</p>
          <p>
            <a href="/about-atlas">About the atlas</a>
            {' · '}<a href="/methodology">Methodology</a>
            {' · '}<a href="/faq">FAQ</a>
            {' · '}<a href="/submit">{UI.submit_cta}</a>
            {' · '}<a href="/corrections">{UI.correction_cta}</a>
          </p>
        </footer>
      </div>
    </div>
  );
}

/** The evidence notice plus a draft marker while the route is not editorially approved. */
export function EvidenceNotice({ route, draft = true }: { route: string; draft?: boolean }): React.ReactElement {
  return (
    <p className="atlas-notice" role="note">
      {draft && !isApproved(route) && <span className="atlas-badge atlas-badge-draft">{UI.draft}</span>}
      {siteCopy.content_notice} Sources checked {formatDate(siteCopy.content_as_of)}.
    </p>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'accent' | 'warn' | 'muted' | 'draft' }): React.ReactElement {
  return <span className={`atlas-badge atlas-badge-${tone}`}>{children}</span>;
}

export function Section({ id, title, children, note }: { id: string; title: string; children: React.ReactNode; note?: React.ReactNode }): React.ReactElement {
  return (
    <section className="atlas-section" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{title}</h2>
      {note && <p className="atlas-section-note">{note}</p>}
      {children}
    </section>
  );
}

export function Missing(): React.ReactElement {
  return <span className="atlas-missing">{UI.missing_value}</span>;
}

// ── Cards ──────────────────────────────────────────────────────────────────

export function EntityCard({ entity, headingLevel = 3 }: { entity: AtlasEntity; headingLevel?: 2 | 3 }): React.ReactElement {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  const category = getCategory(entity.category_id);
  return (
    <a href={entity.route} className="atlas-card">
      <H className="atlas-card-title">{entity.name}</H>
      <span className="atlas-card-meta">
        <Badge tone="accent">{entityTypeLabel(entity.entity_type)}</Badge>
        <Badge tone="muted">{depthLabel(entity.profile_depth)}</Badge>
        {category && <span className="atlas-card-cat">{category.title}</span>}
      </span>
      <span className="atlas-card-desc">{entity.description}</span>
    </a>
  );
}

export function CardGrid({ children, label }: { children: React.ReactNode; label?: string }): React.ReactElement {
  return <div className="atlas-grid" role={label ? 'list' : undefined} aria-label={label}>{children}</div>;
}

// ── Facts ──────────────────────────────────────────────────────────────────

const isIdentifier = (s: string): boolean => /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(s);

/** Label for an object key; USD-denominated keys drop "usd" because the value carries the "$". */
function keyLabel(key: string): string {
  if (/(^|_)usd(_|$)/.test(key)) return humanize(key.replace(/(^|_)usd(?=_|$)/, '').replace(/^_+|_+$/g, '') || 'amount');
  return humanize(key);
}

function scalar(v: unknown, key: string | undefined, currency: string, top: boolean): React.ReactNode {
  if (v === null || v === undefined) return <Missing />;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') {
    if (key && /(^|_)usd(_|$)/.test(key)) return formatMoney(v, 'USD');
    if (key === 'amount' || key === 'valuation') return formatMoney(v, currency);
    if (top || (key && /year/.test(key))) return String(v);
    return v.toLocaleString('en-US');
  }
  const s = String(v);
  if (key === 'date') return formatDate(s);
  if (key === 'role') return roleLabel(s);
  if (/^https?:\/\//.test(s)) return <ExternalLink href={s}><code>{shortUrl(s)}</code></ExternalLink>;
  if (key === 'unit' || isIdentifier(s)) return humanize(s);
  return s;
}

function moneyLine(o: Record<string, unknown>, currency: string): string | null {
  if (typeof o.amount !== 'number') return null;
  const parts = [formatMoney(o.amount, currency)];
  if (o.amount_qualifier === 'greater_than') parts.unshift('More than');
  else if (typeof o.amount_qualifier === 'string') parts.push(`(${humanize(o.amount_qualifier).toLowerCase()})`);
  if (typeof o.interval === 'string') parts.push(`per ${o.interval}`);
  if (typeof o.unit === 'string') parts.push(`per ${humanize(o.unit).toLowerCase()}`);
  return parts.join(' ');
}

const MONEY_KEYS = new Set(['amount', 'currency', 'amount_qualifier', 'interval', 'unit']);

/** Render a fact value exactly as supplied: null is "not established", zero is a documented $0. */
export function FactValue({ value, path, depth = 0 }: { value: unknown; path?: string; depth?: number }): React.ReactElement {
  return <>{renderValue(value, path, 'USD', depth)}</>;
}

function renderValue(v: unknown, key: string | undefined, currency: string, depth: number): React.ReactNode {
  if (Array.isArray(v)) {
    if (!v.length) return <Missing />;
    if (v.every((x) => typeof x === 'string')) {
      return (v as string[]).map((x) => (isIdentifier(x) ? humanize(x) : x)).join(', ');
    }
    return (
      <ul className="atlas-value-list">
        {v.map((x, i) => {
          if (x && typeof x === 'object' && 'name' in x) {
            const p = x as { name: string; role?: string };
            return <li key={i}>{p.name}{p.role ? ` — ${p.role}` : ''}</li>;
          }
          return <li key={i}>{renderValue(x, undefined, currency, depth + 1)}</li>;
        })}
      </ul>
    );
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const cur = typeof o.currency === 'string' ? o.currency : currency;
    const money = moneyLine(o, cur);
    const rest = Object.entries(o).filter(([k]) => !(money && MONEY_KEYS.has(k)));
    if (depth > 0) {
      // Nested objects (e.g. one plan inside a plan table) render inline.
      const bits = [money, ...rest.map(([k, x]) => `${keyLabel(k)}: ${inlineText(x, k, cur)}`)].filter(Boolean);
      return bits.join(' · ');
    }
    return (
      <>
        {money && <div className="atlas-money">{money}</div>}
        {rest.length > 0 && (
          <dl className="atlas-kv">
            {rest.map(([k, x]) => (
              <React.Fragment key={k}>
                <dt>{keyLabel(k)}</dt>
                <dd>{renderValue(x, k, cur, depth + 1)}</dd>
              </React.Fragment>
            ))}
          </dl>
        )}
      </>
    );
  }
  return scalar(v, key, currency, depth === 0);
}

function inlineText(v: unknown, key: string, currency: string): string {
  if (v === null || v === undefined) return UI.missing_value;
  if (typeof v === 'number') {
    if (/(^|_)usd(_|$)/.test(key)) return formatMoney(v, 'USD');
    if (key === 'amount' || key === 'valuation') return formatMoney(v, currency);
    return v.toLocaleString('en-US');
  }
  if (typeof v === 'string') return isIdentifier(v) ? humanize(v) : v;
  if (Array.isArray(v)) return v.map((x) => inlineText(x, key, currency)).join(', ');
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${keyLabel(k)}: ${inlineText(x, k, currency)}`).join('; ');
  }
  return String(v);
}

/** Inline citations for one fact — supports both `evidence_ids` and `source_urls`. */
export function FactSources({ fact, entity }: { fact: AtlasFact; entity: AtlasEntity }): React.ReactElement | null {
  const ev = (fact.evidence_ids ?? [])
    .map((id) => entity.evidence.find((e) => e.evidence_id === id))
    .filter((e): e is AtlasEvidence => Boolean(e));
  const urls = (fact.source_urls ?? []).filter((u) => !ev.some((e) => e.url === u));
  if (!ev.length && !urls.length) return null;
  return (
    <p className="atlas-cite">
      <span>Source{ev.length + urls.length > 1 ? 's' : ''}: </span>
      {ev.map((e, i) => (
        <React.Fragment key={e.evidence_id}>
          {i > 0 && ', '}
          <ExternalLink href={e.url}>{hostOf(e.url)}</ExternalLink>
          {e.published_on && <span className="atlas-cite-date"> (published {formatDate(e.published_on)})</span>}
        </React.Fragment>
      ))}
      {urls.map((u, i) => (
        <React.Fragment key={u}>
          {(ev.length > 0 || i > 0) && ', '}
          <ExternalLink href={u}>{hostOf(u)}</ExternalLink>
        </React.Fragment>
      ))}
    </p>
  );
}

export function FactRow({ fact, entity, label }: { fact: AtlasFact; entity: AtlasEntity; label?: string }): React.ReactElement {
  return (
    <div className="atlas-fact">
      <div className="atlas-fact-head">
        <h3 className="atlas-fact-label">{label ?? factLabel(fact.path)}</h3>
        <Badge tone={fact.status === 'unknown' ? 'warn' : 'neutral'}>{factStatusLabel(fact.status)}</Badge>
      </div>
      <div className="atlas-fact-value"><FactValue value={fact.value} /></div>
      {fact.scope?.description && <p className="atlas-fact-note"><strong>Scope:</strong> {fact.scope.description}</p>}
      {fact.note && <p className="atlas-fact-note"><strong>Note:</strong> {fact.note}</p>}
      <FactSources fact={fact} entity={entity} />
    </div>
  );
}

// ── BasedAgents call to action ─────────────────────────────────────────────

const CONSOLE_NEW_TASK = positioning.ctas.postTask.href;

/** A guide is a task specification, so it can seed the task composer (console /tasks/new reads ?description= and ?expected_output=). */
export function guideTaskDraftHref(guide: AtlasGuide, site: string): string {
  const description = [
    `Task brief adapted from the Agent Atlas guide "${guide.title}" (${site}${guide.route}). Replace the example inputs with your own.`,
    `Inputs: ${guide.inputs}`,
    `Procedure:\n${guide.steps.map((s, i) => `${i + 1}. ${s.replace(/\.$/, '')}`).join('\n')}`,
    `Approval boundary: ${guide.approval_boundary}`,
    `Acceptance criteria: ${guide.acceptance_criteria}`,
    `Known failure modes to check: ${guide.failure_modes}`,
  ].join('\n\n');
  const p = new URLSearchParams({ description, expected_output: guide.deliverable });
  return `${CONSOLE_NEW_TASK}?${p.toString()}`;
}

/**
 * The bridge from research to the product: a clearly labelled block about the
 * publisher, separate from the editorial content. It links only to BasedAgents
 * flows that exist in this codebase (/tasks, /docs/agents and the console task
 * composer) and reuses the positioning copy verbatim.
 */
export function BasedAgentsCta({ source, guide, site }: { source: string; guide?: AtlasGuide; site?: string }): React.ReactElement {
  const draftHref = guide && site ? guideTaskDraftHref(guide, site) : null;
  return (
    <aside className="atlas-cta" aria-labelledby={`cta-${source}`}>
      <p className="atlas-cta-kicker">From the publisher</p>
      <h2 id={`cta-${source}`}>{draftHref ? 'Turn this guide into a task on BasedAgents' : `${positioning.name} — ${positioning.oneLiner.charAt(0).toLowerCase()}${positioning.oneLiner.slice(1).replace(/\.$/, '')}`}</h2>
      <p>{positioning.subhead}</p>
      {draftHref && (
        <p className="atlas-cta-fine">
          This guide already reads like a task brief: inputs, deliverable and acceptance criteria. The button opens the
          BasedAgents task composer with that brief prefilled — you add a title and your specifics, and nothing is posted until you submit it.
        </p>
      )}
      <div className="atlas-cta-actions">
        {draftHref ? (
          <a className="btn btn-primary" href={draftHref} onClick={() => funnelPing('task_cta_click', `atlas-${source}`)}>Draft this task</a>
        ) : (
          <a className="btn btn-primary" href={CONSOLE_NEW_TASK} onClick={() => funnelPing('task_cta_click', `atlas-${source}`)}>{positioning.ctas.postTask.label}</a>
        )}
        <a className="btn btn-secondary" href={positioning.ctas.openTasks.href}>{positioning.ctas.openTasks.label}</a>
        <a className="btn btn-secondary" href={positioning.ctas.agentDocs.href}>Find work for your agent</a>
      </div>
      <p className="atlas-cta-fine">
        BasedAgents publishes Agent Atlas and is not listed in it. Listings are research records, not rankings or endorsements.
      </p>
    </aside>
  );
}

export const entityName = (id: string): string => getEntity(id)?.name ?? id;
