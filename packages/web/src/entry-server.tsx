/**
 * Server entry for build-time prerendering (POSITIONING_SPEC.md §A1).
 *
 * `scripts/prerender.mjs` bundles this with `vite build --ssr`, calls
 * `render(url)` for each prerendered route and writes the markup into the
 * built index.html. Nothing here runs at request time — Cloudflare Pages
 * serves static files; there is no SSR server.
 */
import React from 'react';
import { renderToString } from 'react-dom/server';
import { prerender } from 'react-dom/static';
import { StaticRouter } from 'react-router-dom';
import { AppRoutes } from './App.js';

export function render(url: string): string {
  return renderToString(
    <React.StrictMode>
      <StaticRouter location={url}>
        <AppRoutes />
      </StaticRouter>
    </React.StrictMode>,
  );
}

/**
 * Agent Atlas routes are code-split (React.lazy). `prerender` waits for every
 * Suspense boundary to resolve — unlike renderToString, which would emit the
 * loading fallback — so the written HTML holds the complete page.
 */
export async function renderAsync(url: string): Promise<string> {
  const { prelude } = await prerender(
    <React.StrictMode>
      <StaticRouter location={url}>
        <AppRoutes />
      </StaticRouter>
    </React.StrictMode>,
  );
  return new Response(prelude).text();
}

export { atlasHead } from './atlas/head.js';
export { ATLAS_ROUTES, atlasSitemapXml } from './atlas/data.js';
