import React, { useState } from 'react';
import { Link } from 'react-router-dom';


const isRegistry = typeof window !== 'undefined' && window.location.hostname.startsWith('registry.');

export default function Layout({ children }: { children: React.ReactNode }): React.ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);

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
            <a href="/" className="nav-logo">
              <span className="nav-logo-mark">&lt;&gt;</span>
              <span>BasedAgents</span>
            </a>
          )}
          {/* Site-wide nav (homepage spec §1). /keyring, /registry are STATIC
              pages, so these are real <a> — they leave the SPA and load the
              served file. */}
          <div className="nav-links">
            <a href="/keyring">Keyring</a>
            <a href="/registry">Registry</a>
            <a href="/docs/getting-started">Docs</a>
            <a href="/blog">Blog</a>
            <a href="/#pricing">Pricing</a>
            <a href="https://github.com/maxfain/basedagents" target="_blank" rel="noopener noreferrer">GitHub</a>
            <a
              href="https://app.basedagents.ai/start"
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
          <a href="/keyring" style={{ textDecoration: 'none', color: 'var(--text-secondary)' }}>Keyring</a>
          <a href="/registry" style={{ textDecoration: 'none', color: 'var(--text-secondary)' }}>Registry</a>
          <a href="/docs/getting-started" style={{ textDecoration: 'none', color: 'var(--text-secondary)' }}>Docs</a>
          <a href="/blog" style={{ textDecoration: 'none', color: 'var(--text-secondary)' }}>Blog</a>
          <a href="/#pricing" style={{ textDecoration: 'none', color: 'var(--text-secondary)' }}>Pricing</a>
          <a href="https://github.com/maxfain/basedagents" target="_blank" rel="noopener noreferrer">GitHub</a>
          <a href="https://app.basedagents.ai/start" style={{ textDecoration: 'none', color: 'var(--accent)', fontWeight: 600 }}>
            Get started
          </a>
        </div>
      </nav>

      <main>{children}</main>

      <footer className="footer">
        <div className="footer-inner">
          <div className="footer-links">
            <a href="/">BasedAgents</a>
            <a href="/keyring">Keyring</a>
            <a href="/registry">Registry</a>
            <a href="https://github.com/maxfain/basedagents" target="_blank" rel="noopener noreferrer">GitHub</a>
            <Link to="/status">Status</Link>
            <Link to="/terms">Terms</Link>
            <Link to="/privacy">Privacy</Link>
          </div>
          <p className="footer-tagline">Scoped, revocable API keys for AI coding agents.</p>
        </div>
      </footer>
    </>
  );
}
