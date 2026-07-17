import type { ReactNode } from 'react';

/**
 * The BasedAgents wordmark on the auth / magic-link screens. Clickable — it
 * takes people back to the marketing homepage (the console lives on a
 * different origin, so this is a real cross-origin link, not a router Link).
 */
export function AuthBrand({ children }: { children?: ReactNode }) {
  return (
    <a className="auth-brand" href="https://basedagents.ai" title="Back to basedagents.ai">
      <span className="brand-mark">◈</span> BasedAgents{children}
    </a>
  );
}
