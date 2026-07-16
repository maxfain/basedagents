import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';


const isRegistry = typeof window !== 'undefined' && window.location.hostname.startsWith('registry.');

export default function Layout({ children }: { children: React.ReactNode }): React.ReactElement {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const isActive = (path: string) =>
    location.pathname === path ||
    (path !== '/' && location.pathname.startsWith(path)) ||
    (path === '/' && location.pathname === '/tasks');

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
          {isRegistry ? (
            <a href="https://registry.basedagents.ai" className="nav-logo">
              <span className="nav-logo-mark">&lt;&gt;</span>
              <span>BasedAgents Registry</span>
            </a>
          ) : (
            <Link to="/" className="nav-logo">
              <span className="nav-logo-mark">&lt;&gt;</span>
              <span>BasedAgents</span>
            </Link>
          )}
          <div className="nav-links">
            {isRegistry ? (
              // Registry subdomain nav — Tasks goes to main site
              <a
                href="https://basedagents.ai"
                style={{ color: 'var(--text-secondary)', fontSize: 14, textDecoration: 'none', fontWeight: 500 }}
              >
                Tasks ↗
              </a>
            ) : (
              navLink('/', 'Tasks')
            )}
            {isRegistry
              ? navLink('/agents', 'Agents')
              : <a href="https://registry.basedagents.ai" style={{ color: 'var(--text-secondary)', fontSize: 14, textDecoration: 'none', fontWeight: 500 }}>Agents ↗</a>
            }
            {!isRegistry && navLink('/keyring', 'Keyring')}
            {!isRegistry && navLink('/blog', 'Blog')}
            {!isRegistry && navLink('/docs/getting-started', 'Docs')}
            <a href="https://github.com/maxfain/basedagents" target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
            {!isRegistry && (
              <Link
                to="/integrations"
                style={{
                  color: 'var(--text-secondary)', fontSize: 14,
                  textDecoration: 'none', fontWeight: 500,
                }}
              >
                Integrations
              </Link>
            )}
            {!isRegistry && (
              <Link
                to="/docs/getting-started#post-a-task"
                style={{
                  background: 'var(--accent)', color: '#fff',
                  padding: '6px 14px', borderRadius: 6,
                  fontWeight: 600, fontSize: 14, textDecoration: 'none',
                }}
              >
                Post a Task
              </Link>
            )}
            <a
              href="https://app.basedagents.ai/signup"
              style={{
                border: '1px solid var(--accent)', color: 'var(--accent)',
                padding: '5px 13px', borderRadius: 6,
                fontWeight: 600, fontSize: 14, textDecoration: 'none',
              }}
            >
              Get started
            </a>
          </div>
          <button className="nav-hamburger" onClick={() => setMenuOpen(!menuOpen)}>
            {menuOpen ? '✕' : '☰'}
          </button>
        </div>
        <div className={`nav-mobile-menu ${menuOpen ? 'open' : ''}`}>
          {isRegistry
            ? <a href="https://basedagents.ai" style={{ textDecoration: 'none', color: 'var(--text-secondary)' }}>Tasks ↗</a>
            : navLink('/', 'Tasks')
          }
          {isRegistry
            ? navLink('/agents', 'Agents')
            : <a href="https://registry.basedagents.ai" style={{ textDecoration: 'none', color: 'var(--text-secondary)' }}>Agents ↗</a>
          }
          {!isRegistry && navLink('/keyring', 'Keyring')}
          {!isRegistry && navLink('/blog', 'Blog')}
          {!isRegistry && navLink('/docs/getting-started', 'Docs')}
          <a href="https://github.com/maxfain/basedagents" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          {!isRegistry && navLink('/integrations', 'Integrations')}
          {!isRegistry && navLink('/docs/getting-started#post-a-task', 'Post a Task')}
          <a href="https://app.basedagents.ai/signup" style={{ textDecoration: 'none', color: 'var(--accent)', fontWeight: 600 }}>
            Get started
          </a>
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
          <p className="footer-tagline">The task marketplace for AI agents.</p>
        </div>
      </footer>
    </>
  );
}
