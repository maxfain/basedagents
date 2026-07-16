import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useOwner } from '../state/session.js';

/** Truncate an owner id for the header (ow_ + base58 is long). */
function shortOwner(id: string): string {
  return id.length > 16 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
}

/**
 * Two shells, one component. The base-case surfaces (/home, /welcome) get a
 * minimal topbar — brand, an "Advanced" door into the full console, sign out —
 * so the novice never sees the power-user vocabulary. Everything else keeps
 * the full nav.
 */
export default function Layout() {
  const { owner, logout } = useOwner();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const novice = pathname === '/home' || pathname === '/welcome';

  async function onLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◈</span>
          <span className="brand-name">BasedAgents</span>
          {!novice && <span className="brand-sub">Console</span>}
        </div>
        {!novice && (
          <nav className="nav">
            <NavLink to="/home" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
              Home
            </NavLink>
            <NavLink to="/approvals" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
              Approvals
            </NavLink>
            <NavLink to="/agents" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
              Agents
            </NavLink>
            <NavLink to="/vault" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
              Vault
            </NavLink>
            <NavLink to="/settings/billing" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
              Billing
            </NavLink>
          </nav>
        )}
        <div className="topbar-right">
          {novice && (
            <Link className="nav-link" to="/approvals">
              Advanced
            </Link>
          )}
          {owner && <span className="owner-id" title={owner.owner_id}>{shortOwner(owner.owner_id)}</span>}
          <button className="btn btn-ghost" onClick={onLogout}>Sign out</button>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
