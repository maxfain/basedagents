/**
 * AgentID verified-identity linking — the fail-closed config switch.
 *
 * AgentID (https://agentid.com, by AgentMail) is a standard OpenID Connect
 * provider for AI agents: every AgentID is backed by a verified AgentMail inbox.
 * BasedAgents uses it as an OPTIONAL attestation layered on top of AgentSig — an
 * agent that already holds its ag_… signing key can link an AgentID once to earn
 * a verified-identity badge and contribute an owner grouping key (`owner_sub`)
 * that the trust layer can use for sybil-aware reputation. AgentSig stays the
 * sole request-auth mechanism; AgentID never signs or authorizes a request.
 *
 * `agentIdConfigFor(env)` returns a resolved config ONLY when every required
 * piece is present and well-formed (mirrors payments/index.ts, spec N6):
 *   - AGENTID_ENABLED === '1'        (var; absent by default)
 *   - AGENTID_CLIENT_ID              (var)
 *   - AGENTID_CLIENT_SECRET          (secret)
 *   - AGENTID_REDIRECT_URI is http(s)
 *   - AGENTID_ISSUER (default) is https
 * Otherwise it returns null and callers fail closed with 503. Each distinct
 * disabled reason is logged once per isolate. Tests inject a config through
 * `setAgentIdConfigForTests` (null = forced disabled).
 */

import type { Bindings } from '../types/index.js';

/** AgentID's public OIDC issuer (reference: https://agentid.com/llms-full.txt). */
export const AGENTID_DEFAULT_ISSUER = 'https://auth.agentid.com';
/** Minimum scopes: openid (required) + email (agent inbox) + profile (name, owner_sub). */
export const AGENTID_DEFAULT_SCOPES = 'openid email profile';

export type AgentIdEnv = Pick<
  Bindings,
  | 'AGENTID_ENABLED'
  | 'AGENTID_CLIENT_ID'
  | 'AGENTID_CLIENT_SECRET'
  | 'AGENTID_ISSUER'
  | 'AGENTID_REDIRECT_URI'
  | 'AGENTID_SCOPES'
>;

export interface AgentIdConfig {
  clientId: string;
  clientSecret: string;
  /** Issuer with any trailing slash stripped (exact-match the id_token `iss`). */
  issuer: string;
  redirectUri: string;
  scopes: string;
  authorizeUrl: string;
  tokenUrl: string;
  jwksUrl: string;
}

function trimTrailingSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

/**
 * Why AgentID linking is disabled for this env, or null when fully configured.
 * Also backs `GET /v1/status.agentid`. Pure function of env (no I/O).
 */
export function agentIdDisabledReason(env: AgentIdEnv | undefined | null): string | null {
  if (!env) return 'no env bindings';
  if (env.AGENTID_ENABLED !== '1') return "AGENTID_ENABLED is not '1'";
  if (!env.AGENTID_CLIENT_ID) return 'AGENTID_CLIENT_ID is not set';
  if (!env.AGENTID_CLIENT_SECRET) return 'AGENTID_CLIENT_SECRET is not set';
  if (!env.AGENTID_REDIRECT_URI) return 'AGENTID_REDIRECT_URI is not set';
  const issuer = env.AGENTID_ISSUER || AGENTID_DEFAULT_ISSUER;
  try {
    if (new URL(issuer).protocol !== 'https:') return 'AGENTID_ISSUER is not an https URL';
  } catch {
    return 'AGENTID_ISSUER is not a valid URL';
  }
  try {
    const proto = new URL(env.AGENTID_REDIRECT_URI).protocol;
    if (proto !== 'https:' && proto !== 'http:') return 'AGENTID_REDIRECT_URI is not an http(s) URL';
  } catch {
    return 'AGENTID_REDIRECT_URI is not a valid URL';
  }
  return null;
}

/** `undefined` = derive from env; `null` = forced disabled; else the injected config. */
let testOverride: AgentIdConfig | null | undefined = undefined;
let lastLoggedReason: string | null = null;

export function agentIdConfigFor(env: AgentIdEnv | undefined | null): AgentIdConfig | null {
  if (testOverride !== undefined) return testOverride;

  const reason = agentIdDisabledReason(env);
  if (reason !== null) {
    if (reason !== lastLoggedReason) {
      lastLoggedReason = reason;
      // The flag being off is the expected default (informational); the flag on
      // with a broken value is a misconfiguration worth an error line.
      if (env?.AGENTID_ENABLED === '1') console.error(`[agentid] disabled: ${reason}`);
      else console.log(`[agentid] disabled: ${reason}`);
    }
    return null;
  }

  const issuer = trimTrailingSlash(env!.AGENTID_ISSUER || AGENTID_DEFAULT_ISSUER);
  const scopes = (env!.AGENTID_SCOPES && env!.AGENTID_SCOPES.trim()) || AGENTID_DEFAULT_SCOPES;
  return {
    clientId: env!.AGENTID_CLIENT_ID!,
    clientSecret: env!.AGENTID_CLIENT_SECRET!,
    issuer,
    redirectUri: env!.AGENTID_REDIRECT_URI!,
    scopes,
    authorizeUrl: `${issuer}/v0/authorize`,
    tokenUrl: `${issuer}/v0/token`,
    jwksUrl: `${issuer}/v0/jwks.json`,
  };
}

/**
 * Test hook. `undefined` restores env-derived behaviour (and resets the one-line
 * log flag); `null` forces "disabled"; any object is returned verbatim.
 */
export function setAgentIdConfigForTests(cfg: AgentIdConfig | null | undefined): void {
  testOverride = cfg;
  lastLoggedReason = null;
}

/** A linked-identity row as the public API exposes it (owner_sub is NEVER included). */
export interface AgentIdLinkPublic {
  verified: true;
  issuer: string;
  email: string | null;
  email_verified: boolean;
  display_name: string | null;
  linked_at: string;
}

/**
 * Mask an email for public responses (hansl@agentmail.com → h***l@a******l.com).
 * Same scheme as routes/agents.ts obfuscateEmail, but it NEVER returns an address
 * unmasked: a domain with no dot (e.g. research@inbox) is still masked rather than
 * exposed in full. (Not imported from agents.ts: that module imports this one,
 * which would be a cycle.)
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return email; // no local part to mask
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const mask = (s: string) => (s.length <= 2 ? s : `${s[0]}${'*'.repeat(s.length - 2)}${s[s.length - 1]}`);
  const dotIdx = domain.lastIndexOf('.');
  if (dotIdx < 1) return `${mask(local)}@${mask(domain)}`; // dotless domain: still mask, never expose
  return `${mask(local)}@${mask(domain.slice(0, dotIdx))}${domain.slice(dotIdx)}`;
}

/** Row shape (subset) needed to build the public view. */
export interface AgentIdLinkRowLike {
  issuer: string;
  email: string | null;
  email_verified: number | boolean | null;
  display_name: string | null;
  linked_at: string;
}

/** Public, owner_sub-free view of a verified link. */
export function publicAgentIdView(link: AgentIdLinkRowLike): AgentIdLinkPublic {
  return {
    verified: true,
    issuer: link.issuer,
    email: link.email ? maskEmail(link.email) : null,
    email_verified: !!link.email_verified,
    display_name: link.display_name ?? null,
    linked_at: link.linked_at,
  };
}
