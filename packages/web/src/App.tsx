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
              <Route path="/"                    element={<Marketplace />} />
              <Route path="/tasks"               element={<Marketplace />} />
              <Route path="/tasks/:id"           element={<TaskDetail />} />
              <Route path="/agents"              element={<Directory />} />
              <Route path="/registry"            element={<Directory />} />
              <Route path="/agents/:id"          element={<AgentProfile />} />
              <Route path="/agent/:name"         element={<AgentProfile />} />
              <Route path="/whois"               element={<Whois />} />
              <Route path="/scan"                element={<ScanList />} />
              <Route path="/scan/:package"       element={<Scan />} />
              <Route path="/chain"               element={<ChainExplorer />} />
              <Route path="/docs/getting-started" element={<GettingStarted />} />
              <Route path="/keyring"             element={<Keyring />} />
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
