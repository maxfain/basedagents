import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import KeypairLoader from './KeypairLoader';

const TABS = [
  { label: 'Agents', to: '/agents' },
  { label: 'Whois',  to: '/whois'  },
  { label: 'Chain',  to: '/chain'  },
  { label: 'Scan',   to: '/scan'   },
];

function isTabActive(tabTo: string, pathname: string): boolean {
  if (tabTo === '/agents') {
    return pathname === '/' || pathname === '/agents' || pathname === '/registry';
  }
  if (tabTo === '/scan') {
    return pathname === '/scan' || pathname.startsWith('/scan/');
  }
  return pathname === tabTo;
}

export default function RegistryShell({ children }: { children: React.ReactNode }): React.ReactElement {
  const { pathname } = useLocation();

  return (
    <div style={{ padding: '48px 0' }}>
      <div className="container-wide">
        {/* Tab bar */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--border)',
          marginBottom: 28,
          flexWrap: 'wrap',
          gap: 12,
        }}>
          <div style={{ display: 'flex', gap: 0 }}>
            {TABS.map(({ label, to }) => {
              const active = isTabActive(to, pathname);
              return (
                <Link
                  key={to}
                  to={to}
                  style={{
                    padding: '10px 18px',
                    fontSize: 14,
                    fontWeight: 500,
                    textDecoration: 'none',
                    color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                    marginBottom: -1,
                    transition: 'color 0.15s',
                    whiteSpace: 'nowrap',
                  }}
                  onMouseEnter={e => { if (!active) (e.currentTarget as HTMLAnchorElement).style.color = 'var(--text-secondary)'; }}
                  onMouseLeave={e => { if (!active) (e.currentTarget as HTMLAnchorElement).style.color = 'var(--text-tertiary)'; }}
                >
                  {label}
                </Link>
              );
            })}
          </div>
          <div style={{ paddingBottom: 8 }}>
            <KeypairLoader />
          </div>
        </div>

        {/* Active tab content */}
        {children}
      </div>
    </div>
  );
}
