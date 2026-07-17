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

export default defineConfig({
  plugins: [react(), devStaticPages()],
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
