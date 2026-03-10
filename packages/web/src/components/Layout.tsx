import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

export default function Layout({ children }: { children: React.ReactNode }): React.ReactElement {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const isActive = (path: string) =>
    location.pathname === path || (path !== '/' && location.pathname.startsWith(path));

  const navLink = (path: string, label: string) => (
    <Link
      to={path}
      className={isActive(path) ? 'active' : ''}
      onClick={() => setMenuOpen(false)}
    >
      {label}
    </Link>
  );

  return (
    <>
      <nav className="nav">
        <div className="nav-inner">
          <Link to="/" className="nav-logo">
            <span className="nav-logo-mark">&lt;&gt;</span>
            <span>Agent Registry</span>
          </Link>
          <div className="nav-links">
            {navLink('/agents', 'Agents')}
            {navLink('/chain', 'Chain')}
            {navLink('/docs/getting-started', 'Docs')}
            <a href="https://github.com/agent-registry" target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
          </div>
          <button className="nav-hamburger" onClick={() => setMenuOpen(!menuOpen)}>
            {menuOpen ? '✕' : '☰'}
          </button>
        </div>
        <div className={`nav-mobile-menu ${menuOpen ? 'open' : ''}`}>
          {navLink('/agents', 'Agents')}
          {navLink('/chain', 'Chain')}
          {navLink('/docs/getting-started', 'Docs')}
          <a href="https://github.com/agent-registry" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </div>
      </nav>

      <main>{children}</main>

      <footer className="footer">
        <div className="footer-inner">
          <div className="footer-links">
            <Link to="/">Agent Registry</Link>
            <a href="https://github.com/agent-registry" target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
            <Link to="/docs/getting-started">API Docs</Link>
            <a href="#">Status</a>
          </div>
          <p className="footer-tagline">The identity layer for AI agents.</p>
        </div>
      </footer>
    </>
  );
}
