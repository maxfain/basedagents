import { useEffect } from 'react';
import { SITE_URL, siteDescription, siteTitle } from '../content/positioning';
import { atlasHead } from './head';

/** The production host. Anywhere else (pages.dev previews, localhost) is a preview: noindex regardless of approval. */
const PRODUCTION_HOST = 'basedagents.ai';

/** Whether this build was made with ATLAS_FORCE_NOINDEX=1 (guarded for runtimes without the Vite define). */
const BUILD_FORCE_NOINDEX = typeof __ATLAS_FORCE_NOINDEX__ !== 'undefined' && __ATLAS_FORCE_NOINDEX__;

/**
 * The robots value the browser keeps for an atlas route: noindex on any
 * non-production host, in a force-noindex build, and on filtered/search views;
 * otherwise what the launch manifest says.
 */
export function clientRobots(pathname: string, search: string, host: string, buildForceNoindex = BUILD_FORCE_NOINDEX): string {
  const head = atlasHead(pathname, { forceNoindex: buildForceNoindex || host !== PRODUCTION_HOST });
  return search && search !== '?' ? 'noindex,follow' : head.robots;
}

const META: [selector: string, attr: string][] = [
  ['meta[name="description"]', 'content'],
  ['link[rel="canonical"]', 'href'],
  ['meta[property="og:title"]', 'content'],
  ['meta[property="og:description"]', 'content'],
  ['meta[property="og:url"]', 'content'],
  ['meta[name="twitter:title"]', 'content'],
  ['meta[name="twitter:description"]', 'content'],
];

/**
 * Keep <head> in step with the atlas route on client-side navigation. The
 * prerendered HTML already carries the same values (scripts/prerender.mjs), so
 * on a direct load this changes nothing. On leaving the atlas it restores the
 * site defaults that index.html ships (not the previous values — on a direct
 * load those ARE the atlas values) and removes the atlas-only robots tag and
 * JSON-LD, so a noindex never leaks onto another page of the SPA.
 */
export function useAtlasHead(pathname: string, search: string): void {
  useEffect(() => {
    const head = atlasHead(pathname);
    const robots = clientRobots(pathname, search, window.location.hostname);

    const set = (v: { title: string; description: string; canonical: string }): void => {
      document.title = v.title;
      const values = [v.description, v.canonical, v.title, v.description, v.canonical, v.title, v.description];
      META.forEach(([sel, attr], i) => document.head.querySelector(sel)?.setAttribute(attr, values[i]));
    };
    set(head);

    let robotsEl = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (!robotsEl) {
      robotsEl = document.createElement('meta');
      robotsEl.name = 'robots';
      document.head.appendChild(robotsEl);
    }
    robotsEl.content = robots;

    let ld = document.head.querySelector<HTMLScriptElement>('script[data-atlas-jsonld]');
    if (head.jsonLd) {
      if (!ld) {
        ld = document.createElement('script');
        ld.type = 'application/ld+json';
        ld.setAttribute('data-atlas-jsonld', '');
        document.head.appendChild(ld);
      }
      ld.textContent = JSON.stringify(head.jsonLd);
    } else {
      ld?.remove();
    }

    return () => {
      set({ title: siteTitle, description: siteDescription, canonical: `${SITE_URL}/` });
      document.head.querySelector('meta[name="robots"]')?.remove();
      document.head.querySelector('script[data-atlas-jsonld]')?.remove();
    };
  }, [pathname, search]);
}
