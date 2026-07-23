import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { OwnerProvider, useOwner } from './state/session.js';
import { useStaleTabGuard } from './lib/version.js';
import Layout from './components/Layout.js';
import Login from './pages/Login.js';
import Start from './pages/Start.js';
import Recover from './pages/Recover.js';
import LinkPage from './pages/Link.js';
import Claim from './pages/Claim.js';
import Invited from './pages/Invited.js';
import Home from './pages/Home.js';
import Welcome from './pages/Welcome.js';
import Approvals from './pages/Approvals.js';
import Agents from './pages/Agents.js';
import Vault from './pages/Vault.js';
import Billing from './pages/Billing.js';

/** Gate the console behind a live look-session; render the shell once in. */
function Protected() {
  const { owner, loading } = useOwner();
  if (loading) return <div className="boot">Loading…</div>;
  if (!owner) return <Navigate to="/login" replace />;
  return <Layout />;
}

/** Fixed banner shown when this tab's bundle is older than the deploy. */
function StaleTabBanner() {
  const stale = useStaleTabGuard();
  if (!stale) return null;
  return (
    <div className="stale-banner" role="status">
      <span>This page has been updated since this tab loaded.</span>
      <button className="btn btn-primary btn-sm" onClick={() => window.location.reload()}>
        Refresh
      </button>
    </div>
  );
}

export default function App() {
  return (
    <OwnerProvider>
      <StaleTabBanner />
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          {/* /start is the web "Get started" door; /signup 301s to it. */}
          <Route path="/start" element={<Start />} />
          <Route path="/signup" element={<Navigate to="/start" replace />} />
          <Route path="/recover" element={<Recover />} />
          {/* The onboarding ladder's public pages (no session yet). */}
          <Route path="/link" element={<LinkPage />} />
          <Route path="/claim" element={<Claim />} />
          <Route path="/invited" element={<Invited />} />
          <Route element={<Protected />}>
            <Route path="/" element={<Navigate to="/home" replace />} />
            <Route path="/home" element={<Home />} />
            <Route path="/welcome" element={<Welcome />} />
            <Route path="/approvals" element={<Approvals />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/vault" element={<Vault />} />
            <Route path="/settings/billing" element={<Billing />} />
          </Route>
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
      </BrowserRouter>
    </OwnerProvider>
  );
}
