import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { OwnerProvider, useOwner } from './state/session.js';
import Layout from './components/Layout.js';
import Login from './pages/Login.js';
import Signup from './pages/Signup.js';
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

export default function App() {
  return (
    <OwnerProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
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
