import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = dirname(fileURLToPath(import.meta.url));

// Static marketing pages served by their own file; everything else is the SPA.
const STATIC_PAGES = new Set(['/', '/keyring', '/registry', '/docs/agents']);

/**
 * Dev-only: production routing lives in public/_redirects (SPA paths →
 * app.html). `vite dev` doesn't read that, and its default SPA fallback would
 * serve the static index.html for every unknown path — so SPA routes like
 * /agents would render the homepage. This rewrites extension-less HTML
 * navigations that aren't a static page to /app.html, matching production.
 */
function devAppShellFallback() {
  return {
    name: 'dev-app-shell-fallback',
    apply: 'serve' as const,
    configureServer(server: { middlewares: { use: (fn: (req: { url?: string; headers: Record<string, string | undefined> }, res: unknown, next: () => void) => void) => void } }) {
      server.middlewares.use((req, _res, next) => {
        const path = (req.url ?? '/').split('?')[0];
        const wantsHtml = (req.headers.accept ?? '').includes('text/html');
        if (wantsHtml && !STATIC_PAGES.has(path) && !path.includes('.')) {
          req.url = '/app.html';
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devAppShellFallback()],
  build: {
    rollupOptions: {
      input: {
        // The marketing homepage is STATIC (homepage spec): index.html carries
        // the full Keyring-first copy, curl-readable with no JS.
        home: resolve(root, 'index.html'),
        // The React SPA (registry directory, whois, chain, scan, blog, …) lives
        // in its own shell; _redirects routes SPA paths here.
        app: resolve(root, 'app.html'),
        // Static marketing pages (served at /keyring, /registry, /docs/agents by
        // Cloudflare Pages' pretty-URL asset serving, ahead of the SPA fallback).
        keyring: resolve(root, 'keyring.html'),
        registry: resolve(root, 'registry.html'),
        docsAgents: resolve(root, 'docs/agents.html'),
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
