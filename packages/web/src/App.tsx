import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import RegistryShell from './components/RegistryShell';
import Marketplace from './pages/Marketplace';
import Directory from './pages/Directory';
import AgentProfile from './pages/AgentProfile';
import ChainExplorer from './pages/ChainExplorer';
import GettingStarted from './pages/GettingStarted';
import Status from './pages/Status';
import Whois from './pages/Whois';
import Terms from './pages/Terms';
import Privacy from './pages/Privacy';
import Register from './pages/Register';
import Integrations from './pages/Integrations';
import Keyring from './pages/Keyring';
import Blog from './pages/Blog';
import BlogPost from './pages/BlogPost';
import TaskDetail from './pages/TaskDetail';
import Scan from './pages/Scan';
import ScanList from './pages/ScanList';
import { AgentAuthProvider } from './hooks/useAgentAuth';

export const isRegistrySubdomain =
  typeof window !== 'undefined' &&
  window.location.hostname.startsWith('registry.');

// Wrap a page in RegistryShell when on the registry subdomain
function R({ children }: { children: React.ReactNode }): React.ReactElement {
  return <RegistryShell>{children}</RegistryShell>;
}

/**
 * `/` and `/registry` are STATIC marketing pages now (served by Cloudflare
 * Pages before the SPA). A direct load never reaches the SPA; but if internal
 * SPA navigation lands here, do a real page load so the static file is served.
 */
function FullReload({ to }: { to: string }): null {
  React.useEffect(() => { window.location.replace(to); }, [to]);
  return null;
}

export default function App(): React.ReactElement {
  return (
    <AgentAuthProvider>
    <BrowserRouter>
      <Layout>
        <Routes>
          {isRegistrySubdomain ? (
            // ── Registry subdomain routes ──────────────────────────────
            <>
              <Route path="/"              element={<R><Directory bare /></R>} />
              <Route path="/agents"        element={<R><Directory bare /></R>} />
              <Route path="/registry"      element={<R><Directory bare /></R>} />
              <Route path="/whois"         element={<R><Whois /></R>} />
              <Route path="/chain"         element={<R><ChainExplorer /></R>} />
              <Route path="/scan"          element={<R><ScanList /></R>} />
              <Route path="/scan/:package" element={<R><Scan /></R>} />
              {/* Tasks redirects to main site */}
              <Route path="/tasks"         element={<RedirectToMain />} />
              <Route path="/tasks/:id"     element={<RedirectToMain />} />
              {/* Shared routes */}
              <Route path="/agents/:id"    element={<AgentProfile />} />
              <Route path="/agent/:name"   element={<AgentProfile />} />
              <Route path="/status"        element={<Status />} />
              <Route path="/register"      element={<Register />} />
              <Route path="/terms"         element={<Terms />} />
              <Route path="/privacy"       element={<Privacy />} />
            </>
          ) : (
            // ── Main site routes ───────────────────────────────────────
            <>
              {/* Static pages (served by Pages ahead of the SPA); these only
                  fire if internal SPA navigation reaches them. */}
              <Route path="/"                    element={<FullReload to="/" />} />
              <Route path="/registry"            element={<FullReload to="/registry" />} />
              <Route path="/tasks"               element={<Marketplace />} />
              <Route path="/tasks/:id"           element={<TaskDetail />} />
              <Route path="/agents"              element={<Directory />} />
              <Route path="/agents/:id"          element={<AgentProfile />} />
              <Route path="/agent/:name"         element={<AgentProfile />} />
              <Route path="/whois"               element={<Whois />} />
              <Route path="/scan"                element={<ScanList />} />
              <Route path="/scan/:package"       element={<Scan />} />
              <Route path="/chain"               element={<ChainExplorer />} />
              <Route path="/docs/getting-started" element={<GettingStarted />} />
              {/* /keyring is a static HTML page (keyring/index.html, served by
                  Pages before the SPA fallback) — required to read without JS.
                  The old in-browser demo lives on at /keyring/demo. */}
              <Route path="/keyring/demo"        element={<Keyring />} />
              <Route path="/status"              element={<Status />} />
              <Route path="/register"            element={<Register />} />
              <Route path="/blog"                element={<Blog />} />
              <Route path="/blog/:slug"          element={<BlogPost />} />
              <Route path="/integrations"        element={<Integrations />} />
              <Route path="/terms"               element={<Terms />} />
              <Route path="/privacy"             element={<Privacy />} />
            </>
          )}
        </Routes>
      </Layout>
    </BrowserRouter>
    </AgentAuthProvider>
  );
}

// Redirect to main site preserving the path
function RedirectToMain(): React.ReactElement {
  React.useEffect(() => {
    window.location.href = 'https://basedagents.ai' + window.location.pathname + window.location.search;
  }, []);
  return <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--text-tertiary)' }}>Redirecting…</div>;
}
