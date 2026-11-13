/**
 * Real 404s for unknown Agent Atlas slugs.
 *
 * Cloudflare Pages answers every unmatched path with the SPA shell (200), so
 * /projects/<typo> would be a soft 404. The Pages Functions in
 * functions/{projects,categories,guides,compare}/[slug].ts run this guard:
 *
 *   known route (in the route manifest)  → the prerendered page, unchanged
 *   anything else                        → the prerendered not-found page, 404
 *
 * Pages skips _headers for function responses, so the site-wide headers
 * (CSP, X-Agent-*, X-Robots-Tag) are passed in and re-applied here, the same
 * way functions/index.ts does for `/`. Previews (*.pages.dev) are noindex.
 */
import routeManifest from './content/implementation/route-manifest.json';

export interface AtlasGuardContext {
  request: Request;
  env: { ASSETS: { fetch(request: Request): Promise<Response> } };
  next(): Promise<Response>;
}

const KNOWN = new Set((routeManifest as { route: string }[]).map((r) => r.route));

/** Published by scripts/prerender.mjs as dist/atlas-not-found.html. */
export const NOT_FOUND_ASSET = '/atlas-not-found';

const FALLBACK_404 = '<!doctype html><meta charset="utf-8"><title>Not found | BasedAgents</title><meta name="robots" content="noindex"><p>No atlas record at this address. <a href="/atlas">Search the atlas</a>.</p>';

export const isKnownAtlasPath = (pathname: string): boolean => KNOWN.has(pathname.replace(/\/+$/, '') || '/');

export async function atlasGuard(ctx: AtlasGuardContext, siteHeaders: Record<string, string>): Promise<Response> {
  const { request } = ctx;
  const url = new URL(request.url);
  const passThrough = (request.method !== 'GET' && request.method !== 'HEAD') || isKnownAtlasPath(url.pathname);

  let res: Response;
  if (passThrough) {
    const page = await ctx.next();
    res = new Response(page.body, page);
  } else {
    // A fresh request: the caller's conditional headers must not turn this into a 304.
    const asset = await ctx.env.ASSETS.fetch(new Request(new URL(NOT_FOUND_ASSET, url)));
    const body = asset.ok ? asset.body : FALLBACK_404;
    res = new Response(request.method === 'HEAD' ? null : body, { status: 404 });
    res.headers.set('Content-Type', 'text/html; charset=utf-8');
    res.headers.set('Cache-Control', 'no-store');
  }

  // The "/*" rule of public/_headers (the "/" rule's Link header belongs to the homepage only).
  for (const [name, value] of Object.entries(siteHeaders)) if (name !== 'Link') res.headers.set(name, value);
  if (!passThrough || url.hostname.endsWith('.pages.dev')) res.headers.set('X-Robots-Tag', 'noindex');
  return res;
}
