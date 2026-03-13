import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import KeypairLoader from './KeypairLoader';

export default function Layout({ children }: { children: React.ReactNode }): React.ReactElement {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const isActive = (path: string) =>
    location.pathname === path ||
    (path !== '/' && location.pathname.startsWith(path)) ||
    (path === '/agents' && location.pathname === '/');

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
            <span>BasedAgents</span>
          </Link>
          <div className="nav-links">
            {navLink('/agents', 'Agents')}
            {navLink('/whois', 'Whois')}
            {navLink('/chain', 'Chain')}
            {navLink('/docs/getting-started', 'Docs')}
            <a href="https://github.com/maxfain/basedagents" target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
            <KeypairLoader />
            <Link
              to="/integrations"
              style={{
                color: 'var(--text-secondary)', fontSize: 14,
                textDecoration: 'none', fontWeight: 500,
              }}
            >
              Integrations
            </Link>
            <Link
              to="/register"
              style={{
                background: 'var(--accent)', color: '#fff',
                padding: '6px 14px', borderRadius: 6,
                fontWeight: 600, fontSize: 14, textDecoration: 'none',
              }}
            >
              Register Agent
            </Link>
          </div>
          <button className="nav-hamburger" onClick={() => setMenuOpen(!menuOpen)}>
            {menuOpen ? '✕' : '☰'}
          </button>
        </div>
        <div className={`nav-mobile-menu ${menuOpen ? 'open' : ''}`}>
          {navLink('/agents', 'Agents')}
          {navLink('/whois', 'Whois')}
          {navLink('/chain', 'Chain')}
          {navLink('/docs/getting-started', 'Docs')}
          <a href="https://github.com/maxfain/basedagents" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          {navLink('/integrations', 'Integrations')}
          {navLink('/register', 'Register Agent')}
        </div>
      </nav>

      <main>{children}</main>

      <footer className="footer">
        <div className="footer-inner">
          <div className="footer-links">
            <Link to="/">BasedAgents</Link>
            <a href="https://github.com/maxfain/basedagents" target="_blank" rel="noopener noreferrer">GitHub</a>
            <Link to="/docs/getting-started">Docs</Link>
            <Link to="/status">Status</Link>
            <Link to="/terms">Terms</Link>
            <Link to="/privacy">Privacy</Link>
          </div>
          <p className="footer-tagline">The identity layer for AI agents.</p>
        </div>
      </footer>
    </>
  );
}
