import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useOwner } from '../state/session.js';

/** Truncate an owner id for the header (ow_ + base58 is long). */
function shortOwner(id: string): string {
  return id.length > 16 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
}

export default function Layout() {
  const { owner, logout } = useOwner();
  const navigate = useNavigate();

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
          <span className="brand-sub">Console</span>
        </div>
        <nav className="nav">
          <NavLink to="/approvals" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            Approvals
          </NavLink>
        </nav>
        <div className="topbar-right">
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
