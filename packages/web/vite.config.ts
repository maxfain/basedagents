import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = dirname(fileURLToPath(import.meta.url));

// Extension-less pretty URLs for the STATIC marketing leaf pages → their .html
// file. In production Cloudflare Pages serves these as assets ahead of the SPA
// fallback; in `vite dev` the default SPA fallback would otherwise serve
// index.html (the SPA shell) for them. Everything NOT listed here falls through
// to Vite's default index.html SPA fallback — matching production's
// `/* /index.html 200`. (The homepage `/` is served by the SPA shell + the React
// `Home` route, so it is intentionally NOT a static leaf here.)
const STATIC_PAGES: Record<string, string> = {
  '/keyring': '/keyring.html',
  '/registry': '/registry.html',
  '/docs/agents': '/docs/agents.html',
  '/codex': '/codex.html',
};

function devStaticPages() {
  return {
    name: 'dev-static-pages',
    apply: 'serve' as const,
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, _res, next) => {
        const path = (req.url ?? '/').split('?')[0];
        const wantsHtml = (req.headers.accept ?? '').includes('text/html');
        const target = STATIC_PAGES[path];
        if (wantsHtml && target) req.url = target;
        next();
      });
    },
  };
}

// Google Analytics (GA4). Injected at the top of <head> in EVERY built HTML
// entry — the SPA shell (and so every prerendered route) plus the static leaf
// pages below — so the tag lives in one place. Build only: local dev sends no
// hits. The CSP in public/_headers allows Google's GA4 origins; the privacy
// page discloses it.
const GA_MEASUREMENT_ID = 'G-988W9C9SMZ';

function googleAnalytics() {
  return {
    name: 'google-analytics',
    apply: 'build' as const,
    transformIndexHtml(html: string) {
      if (html.includes('googletagmanager.com/gtag/js')) return html;
      return {
        html,
        tags: [
          { tag: 'script', attrs: { async: true, src: `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}` }, injectTo: 'head-prepend' as const },
          {
            tag: 'script',
            children: `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${GA_MEASUREMENT_ID}');`,
            injectTo: 'head-prepend' as const,
          },
        ],
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), devStaticPages(), googleAnalytics()],
  build: {
    rollupOptions: {
      input: {
        // The SPA shell AND the homepage (/) — index.html carries the SPA mount
        // plus a curl-readable static fallback in <noscript>/#root.
        main: resolve(root, 'index.html'),
        // Static marketing leaf pages, served at /keyring, /registry,
        // /docs/agents by Cloudflare Pages' pretty-URL asset serving ahead of
        // the SPA fallback. Fully self-contained (inline styles + JS), curl-readable.
        keyring: resolve(root, 'keyring.html'),
        registry: resolve(root, 'registry.html'),
        docsAgents: resolve(root, 'docs/agents.html'),
        codex: resolve(root, 'codex.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
