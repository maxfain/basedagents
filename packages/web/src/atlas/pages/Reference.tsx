/**
 * Reference pages: /glossary (one page, stable anchors, local search), /faq
 * (one page, linkable question ids, accessible expand/collapse with answers in
 * the rendered HTML), /about-atlas and /methodology, the /submit and
 * /corrections forms, and the not-found page.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { faq, glossary, siteCopy } from '../data';
import { contentStatusLabel, entityTypeLabel, shortUrl } from '../format';
import { breadcrumbsFor, HUB_COPY, type AtlasResolved } from '../resolve';
import { AtlasShell, BasedAgentsCta, EvidenceNotice, ExternalLink } from '../ui';
import { counts } from '../data';

/** decodeURIComponent that returns null instead of throwing on a malformed sequence (e.g. "/faq#%"). */
export function safeDecode(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function GlossaryPage({ r }: { r: Extract<AtlasResolved, { kind: 'glossary' }> }): React.ReactElement {
  const copy = HUB_COPY.glossary;
  const [q, setQ] = useState('');
  const terms = useMemo(() => [...glossary].sort((a, b) => a.term.localeCompare(b.term, 'en', { sensitivity: 'base' })), []);
  const shown = terms.filter((t) => !q.trim() || norm(`${t.term} ${t.definition}`).includes(norm(q.trim())));
  const letters = [...new Set(terms.map((t) => t.term.charAt(0).toUpperCase()))];
  return (
    <AtlasShell route={r.route} crumbs={breadcrumbsFor(r)}>
      <header className="atlas-header">
        <h1>{copy.h1}</h1>
        <p className="atlas-lead">{copy.intro}</p>
      </header>
      <EvidenceNotice route={r.route} />
      <div className="atlas-search atlas-search-compact" role="search">
        <label htmlFor="gloss-q" className="atlas-sr">Filter terms</label>
        <input id="gloss-q" type="search" placeholder="Filter terms" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      </div>
      <p className="atlas-section-note" aria-live="polite">
        {q.trim() ? `${shown.length} of ${terms.length} terms match.` : `${terms.length} terms · ${contentStatusLabel('editorial_working_definition').toLowerCase()}s`}
      </p>
      {!q.trim() && (
        <nav aria-label="Jump to letter" className="atlas-letters">
          {letters.map((l) => {
            const first = terms.find((t) => t.term.toUpperCase().startsWith(l));
            return first ? <a key={l} href={`#${first.id}`}>{l}</a> : null;
          })}
        </nav>
      )}
      {shown.length === 0 ? (
        <p className="atlas-empty">{siteCopy.ui.empty_search}</p>
      ) : (
        <dl className="atlas-glossary">
          {shown.map((t) => (
            <div key={t.id} id={t.id} className="atlas-term">
              <dt><a href={`#${t.id}`}>{t.term}</a></dt>
              <dd>{t.definition}</dd>
            </div>
          ))}
        </dl>
      )}
      <BasedAgentsCta source="glossary" />
    </AtlasShell>
  );
}

export function FaqPage({ r }: { r: Extract<AtlasResolved, { kind: 'faq' }> }): React.ReactElement {
  const copy = HUB_COPY.faq;
  const location = useLocation();
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  // A link to /faq#question-id opens that answer; anything else (even a malformed fragment) is ignored.
  useEffect(() => {
    const id = safeDecode(location.hash.replace(/^#/, ''));
    if (id && faq.some((f) => f.id === id)) {
      setOpen((prev) => new Set(prev).add(id));
      document.getElementById(id)?.scrollIntoView();
    }
  }, [location.hash]);

  const toggle = (id: string, isOpen: boolean): void =>
    setOpen((prev) => {
      if (prev.has(id) === isOpen) return prev;
      const next = new Set(prev);
      if (isOpen) next.add(id); else next.delete(id);
      return next;
    });

  return (
    <AtlasShell route={r.route} crumbs={breadcrumbsFor(r)}>
      <header className="atlas-header">
        <h1>{copy.h1}</h1>
        <p className="atlas-lead">{copy.intro}</p>
      </header>
      <EvidenceNotice route={r.route} />
      <div className="atlas-faq-tools">
        <button type="button" className="btn btn-secondary" onClick={() => setOpen(new Set(faq.map((f) => f.id)))}>Expand all</button>
        <button type="button" className="btn btn-secondary" onClick={() => setOpen(new Set())}>Collapse all</button>
      </div>
      <div className="atlas-faq">
        {faq.map((f) => (
          <details
            key={f.id}
            id={f.id}
            open={open.has(f.id)}
            onToggle={(e) => toggle(f.id, (e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary><h2>{f.question}</h2></summary>
            <div className="atlas-faq-answer">
              <p>{f.answer}</p>
              {f.source_urls.length > 0 && (
                <p className="atlas-cite">
                  Sources:{' '}
                  {f.source_urls.map((u, i) => <React.Fragment key={u}>{i > 0 && ', '}<ExternalLink href={u}>{shortUrl(u)}</ExternalLink></React.Fragment>)}
                </p>
              )}
              <p className="atlas-faq-link"><a href={`#${f.id}`}>Link to this answer</a></p>
            </div>
          </details>
        ))}
      </div>
      <BasedAgentsCta source="faq" />
    </AtlasShell>
  );
}

export function StaticPage({ r }: { r: Extract<AtlasResolved, { kind: 'static' }> }): React.ReactElement {
  return (
    <AtlasShell route={r.route} crumbs={breadcrumbsFor(r)}>
      <article className="atlas-article">
        <header className="atlas-header"><h1>{r.page.title}</h1></header>
        <div className="atlas-prose">
          {r.page.body.map((p) => <p key={p}>{p}</p>)}
        </div>
        {r.route === '/about-atlas' && (
          <p className="atlas-stats">
            This release: {counts.entities} records ({counts.byDepth.expanded_profile ?? 0} expanded profiles,{' '}
            {counts.byDepth.protocol_profile ?? 0} protocol profiles, {counts.byDepth.directory_entry ?? 0} directory entries),{' '}
            {counts.categories} categories, {counts.guides} task guides, {counts.comparisons} comparisons, {counts.glossary} glossary terms
            and {counts.faq} FAQ answers.
          </p>
        )}
        <p className="atlas-inline-links">
          <a href="/methodology">Methodology</a> · <a href="/faq">FAQ</a> · <a href="/submit">{siteCopy.ui.submit_cta}</a> ·{' '}
          <a href="/corrections">{siteCopy.ui.correction_cta}</a>
        </p>
      </article>
    </AtlasShell>
  );
}

// ── Submission and correction forms ─────────────────────────────────────────
// No atlas backend exists yet. Rather than simulate receipt, the form hands the
// reviewed fields to the repository's public GitHub issue tracker — a real,
// existing intake that stores the suggestion and queues it for review. The
// page never shows the "received" copy, because this page cannot know whether
// the issue was filed.

const ISSUES_NEW = 'https://github.com/maxfain/basedagents/issues/new';
const EMAIL_FIELD = /email/i;
const URL_FIELD = /url/i;
const LONG_FIELD = /description|correction|documentation/i;
const REQUIRED: Record<string, string[]> = {
  '/submit': ['Project name', 'Official URL', 'Entity type', 'Description'],
  '/corrections': ['Profile URL', 'Field', 'Proposed correction', 'Supporting source URL'],
};
const ENTITY_TYPES = Object.keys(counts.byType).map((t) => entityTypeLabel(t)).sort();

const isHttpUrl = (s: string): boolean => {
  try { const u = new URL(s.trim()); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
};

/** Field limits, and the longest pre-filled issue URL we hand to the browser (GitHub rejects much longer ones). */
export const MAX_FIELD = { short: 300, long: 3000 } as const;
export const MAX_ISSUE_URL = 7500;

export function issueBodyFor(route: string, values: Record<string, string>): string {
  const heading = route === '/submit' ? 'Agent Atlas: project suggestion' : 'Agent Atlas: correction';
  return [
    `<!-- ${heading}, filed from ${siteCopy.base_url}${route}. Do not include secrets or API keys. -->`,
    ...Object.entries(values).filter(([, v]) => v.trim()).map(([k, v]) => `**${k}**\n${v.trim()}`),
  ].join('\n\n');
}

export function issueUrlFor(route: string, title: string, values: Record<string, string>): string {
  const p = new URLSearchParams({ title, body: issueBodyFor(route, values) });
  return `${ISSUES_NEW}?${p.toString()}`;
}

/** The hand-off: a pre-filled issue URL, or — when that would be too long — a title-only URL plus the body to paste. */
export function issueHandoff(route: string, title: string, values: Record<string, string>): { url: string; pasteBody: string | null } {
  const full = issueUrlFor(route, title, values);
  if (full.length <= MAX_ISSUE_URL) return { url: full, pasteBody: null };
  return { url: `${ISSUES_NEW}?${new URLSearchParams({ title }).toString()}`, pasteBody: issueBodyFor(route, values) };
}

export function FormPage({ r }: { r: Extract<AtlasResolved, { kind: 'form' }> }): React.ReactElement {
  const page = r.page;
  const location = useLocation();
  const fields = (page.form_fields ?? []).filter((f) => !EMAIL_FIELD.test(f));
  const required = REQUIRED[r.route] ?? [];
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f, ''])));
  const [errors, setErrors] = useState<string[]>([]);
  const [handoff, setHandoff] = useState<{ url: string; pasteBody: string | null } | null>(null);

  // /corrections?profile=<url> — the "Suggest a correction" link on each profile prefills it.
  useEffect(() => {
    const profile = new URLSearchParams(location.search).get('profile');
    if (profile && r.route === '/corrections') setValues((v) => ({ ...v, 'Profile URL': v['Profile URL'] || profile }));
  }, [location.search, r.route]);

  const onSubmit = (ev: React.FormEvent): void => {
    ev.preventDefault();
    const problems: string[] = [];
    for (const f of required) if (!values[f]?.trim()) problems.push(`${f} is required.`);
    for (const f of fields) {
      const v = values[f]?.trim();
      if (!v || !URL_FIELD.test(f)) continue;
      const urls = v.split(/\s+/).filter(Boolean);
      if (!urls.every(isHttpUrl)) problems.push(`${f} must be ${urls.length > 1 ? 'http(s) URLs, one per line' : 'an http(s) URL'}.`);
    }
    setErrors(problems);
    if (problems.length) { setHandoff(null); return; }
    const title = r.route === '/submit'
      ? `[Atlas] Suggest a project: ${values['Project name'].trim()}`
      : `[Atlas] Correction: ${values['Field'].trim()} on ${values['Profile URL'].trim().replace(/^https?:\/\/(www\.)?basedagents\.ai/, '')}`;
    const next = issueHandoff(r.route, title.slice(0, 200), values);
    setHandoff(next);
    // Too long for a pre-filled link: show the body to copy first, and let the visitor open the issue themselves.
    if (!next.pasteBody) window.open(next.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <AtlasShell route={r.route} crumbs={breadcrumbsFor(r)}>
      <article className="atlas-article">
        <header className="atlas-header"><h1>{page.title}</h1></header>
        <div className="atlas-prose">
          {page.body.filter((p) => !/does not implement or activate a submission backend/i.test(p)).map((p) => <p key={p}>{p}</p>)}
        </div>

        <div className="atlas-callout" role="note">
          <p>
            <strong>How this form works:</strong> there is no atlas submission backend yet. Submitting opens a pre-filled,{' '}
            <strong>public</strong> issue on the BasedAgents GitHub repository in a new tab — nothing is sent until you submit it there,
            and it then enters editorial review. A GitHub account is required. Contact email is not collected: follow-up happens on the issue.
          </p>
          <p>Never include secrets, API keys or private data.</p>
        </div>

        <form className="atlas-form" onSubmit={onSubmit} noValidate>
          {fields.map((f) => {
            const id = `f-${f.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
            const isReq = required.includes(f);
            const label = <label htmlFor={id}>{f}{isReq ? ' (required)' : ' (optional)'}</label>;
            if (f === 'Entity type') {
              return (
                <div key={f} className="atlas-field">
                  {label}
                  <input id={id} list="atlas-entity-types" maxLength={MAX_FIELD.short} value={values[f]} onChange={(e) => setValues({ ...values, [f]: e.target.value })} required={isReq} />
                  <datalist id="atlas-entity-types">{ENTITY_TYPES.map((t) => <option key={t} value={t} />)}</datalist>
                </div>
              );
            }
            return (
              <div key={f} className="atlas-field">
                {label}
                {LONG_FIELD.test(f) ? (
                  <textarea id={id} rows={f.includes('URLs') ? 3 : 5} maxLength={MAX_FIELD.long} value={values[f]} onChange={(e) => setValues({ ...values, [f]: e.target.value })} required={isReq} placeholder={f.includes('URLs') ? 'One URL per line' : undefined} />
                ) : (
                  <input id={id} maxLength={MAX_FIELD.short} type={URL_FIELD.test(f) ? 'url' : 'text'} inputMode={URL_FIELD.test(f) ? 'url' : undefined} value={values[f]} onChange={(e) => setValues({ ...values, [f]: e.target.value })} required={isReq} />
                )}
              </div>
            );
          })}
          {errors.length > 0 && (
            <div className="atlas-form-errors" role="alert">
              <ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul>
            </div>
          )}
          <div className="atlas-cta-actions">
            <button type="submit" className="btn btn-primary">Review on GitHub</button>
            <noscript><a className="btn btn-secondary" href={ISSUES_NEW} target="_blank" rel="noopener noreferrer">Open a GitHub issue</a></noscript>
          </div>
          {handoff && !handoff.pasteBody && (
            <p className="atlas-form-status" role="status">
              A pre-filled issue opened in a new tab. Your suggestion is sent only when you submit the issue on GitHub.{' '}
              If no tab opened, <a href={handoff.url} target="_blank" rel="noopener noreferrer">open the pre-filled issue</a>.
            </p>
          )}
          {handoff?.pasteBody && (
            <div className="atlas-form-status" role="status">
              <p>
                This is too long for a pre-filled GitHub link. Copy the text below, then{' '}
                <a href={handoff.url} target="_blank" rel="noopener noreferrer">open the issue</a> and paste it as the description.
                Nothing is sent until you submit the issue on GitHub.
              </p>
              <label htmlFor="atlas-paste" className="atlas-sr">Issue description to paste</label>
              <textarea id="atlas-paste" readOnly rows={8} value={handoff.pasteBody} onFocus={(e) => e.currentTarget.select()} />
            </div>
          )}
        </form>
      </article>
    </AtlasShell>
  );
}

export function NotFoundPage({ r }: { r: Extract<AtlasResolved, { kind: 'not-found' }> }): React.ReactElement {
  return (
    <AtlasShell route={r.route} crumbs={breadcrumbsFor(r)}>
      <header className="atlas-header">
        <h1>No atlas record at this address</h1>
        <p className="atlas-lead">The page you asked for is not part of Agent Atlas. It may have been mistyped, or the record may not exist.</p>
      </header>
      <p className="atlas-hero-ctas">
        <a className="btn btn-primary" href="/atlas">Search the atlas</a>
        <a className="btn btn-secondary" href="/categories">Browse categories</a>
        <a className="btn btn-secondary" href="/submit">{siteCopy.ui.submit_cta}</a>
      </p>
    </AtlasShell>
  );
}
