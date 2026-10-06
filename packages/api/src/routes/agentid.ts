/**
 * AgentID verified-identity link routes.
 *
 * Two routers:
 *   agentScopedAgentIdRoutes (mounted at /v1/agents):
 *     POST   /:id/agentid/link  — AgentSig; start a link, returns the AgentID
 *                                 sign-in URL + a pollable link_id.
 *     GET    /:id/agentid       — public; the agent's verified-identity status.
 *     DELETE /:id/agentid       — AgentSig; unlink.
 *   publicAgentIdRoutes (mounted at /v1/agentid):
 *     GET  /callback            — AgentID's OIDC redirect target: renders a
 *                                 consent page naming the target agent and sets a
 *                                 set-once, HttpOnly browser-binding cookie.
 *     POST /callback/confirm    — commits the link only after the owner confirms
 *                                 from that same browser (binding cookie matches).
 *     GET  /links/:link_id      — public; poll a link's status (pending/linked/…).
 *
 * The link is an OPTIONAL attestation on top of AgentSig. Linking never grants
 * authority — the agent proves control of its ag_… key to START a link, and the
 * owner proves control of the AgentID in the browser to FINISH it. The consent
 * page + binding cookie defend against account-linking CSRF: the committing
 * browser must be the one that completed sign-in, and it must approve the exact
 * target agent. `owner_sub` is stored for sybil-aware reputation but never
 * exposed publicly.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv, Agent } from '../types/index.js';
import { agentAuth } from '../middleware/auth.js';
import { agentIdConfigFor, publicAgentIdView } from '../agentid/index.js';
import {
  AgentIdOidcClient,
  buildAuthorizeUrl,
  createPkce,
  randomToken,
  sha256hex,
} from '../agentid/oidc.js';
import { timingSafeEqual } from '../mcp/websec.js';
import { AgentIdStore } from '../agentid/store.js';

const STATUS_HINT = 'AgentID linking is not enabled on this registry. See GET /v1/status -> agentid.';

/**
 * Consent-browser binding cookie. One cookie PER link attempt (name suffixed with
 * the link_id) so two consent pages open in the same browser don't clobber each
 * other's binding. Scoped to the confirm path so it's only sent on the one request
 * that needs it; HttpOnly so page script can't read it; SameSite=Lax so the
 * top-level consent-form POST still carries it.
 */
const CONFIRM_COOKIE_PREFIX = 'ba_agentid_confirm_';
const CONFIRM_COOKIE_PATH = '/v1/agentid/callback/confirm';
const confirmCookieName = (linkId: string) => `${CONFIRM_COOKIE_PREFIX}${linkId}`;

// ─────────────────────────── agent-scoped ───────────────────────────

const agentScoped = new Hono<AppEnv>();

/**
 * POST /v1/agents/:id/agentid/link
 * Start an AgentID link for the authenticated agent. Returns the sign-in URL the
 * owner opens in a browser, plus a link_id to poll.
 */
agentScoped.post('/:id/agentid/link', agentAuth, async (c) => {
  const cfg = agentIdConfigFor(c.env);
  if (!cfg) {
    return c.json({ error: 'agentid_unavailable', message: STATUS_HINT }, 503);
  }
  const authedId = c.get('agentId') as string;
  const id = c.req.param('id');
  if (id !== authedId) {
    return c.json({ error: 'forbidden', message: 'You can only link AgentID for your own agent.' }, 403);
  }

  const db = c.get('db');
  const store = new AgentIdStore(db);

  const state = randomToken();
  const nonce = randomToken();
  const linkId = `ail_${randomToken(18)}`;
  const pkce = createPkce();

  await store.createChallenge({
    stateHash: sha256hex(state),
    linkId,
    agentId: authedId,
    codeVerifier: pkce.verifier,
    nonce,
  });
  // Opportunistic GC, like middleware/auth.ts does for used_signatures.
  await store.gcExpiredChallenges(new Date().toISOString()).catch(() => {});

  const linkUrl = buildAuthorizeUrl(cfg, { state, nonce, codeChallenge: pkce.challenge });
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  return c.json({
    ok: true,
    link_id: linkId,
    link_url: linkUrl,
    issuer: cfg.issuer,
    expires_at: expiresAt,
    instructions: 'Open link_url in a browser and sign in with AgentID, then poll GET /v1/agentid/links/<link_id>.',
  });
});

/**
 * GET /v1/agents/:id/agentid
 * Public verified-identity status for an agent (resolved by id or name).
 */
agentScoped.get('/:id/agentid', async (c) => {
  const db = c.get('db');
  const nameOrId = c.req.param('id');

  let agent = await db.get<Agent>('SELECT id FROM agents WHERE id = ?', nameOrId);
  if (!agent) {
    agent = await db.get<Agent>('SELECT id FROM agents WHERE name = ? COLLATE NOCASE', nameOrId);
  }
  if (!agent) {
    return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  }

  const store = new AgentIdStore(db);
  const link = await store.getLinkByAgentId(agent.id).catch(() => null);
  return c.json({
    agent_id: agent.id,
    agentid: link ? publicAgentIdView(link) : null,
  });
});

/**
 * DELETE /v1/agents/:id/agentid
 * Unlink the agent's AgentID (AgentSig; the agent's own key only). Always
 * allowed, even when linking is disabled, so an agent can always remove it.
 */
agentScoped.delete('/:id/agentid', agentAuth, async (c) => {
  const authedId = c.get('agentId') as string;
  const id = c.req.param('id');
  if (id !== authedId) {
    return c.json({ error: 'forbidden', message: 'You can only unlink AgentID for your own agent.' }, 403);
  }
  const store = new AgentIdStore(c.get('db'));
  const res = await store.deleteLinkByAgentId(authedId);
  // Also cancel any in-flight consent so it can't be confirmed to restore the
  // link without a fresh signed request.
  await store.cancelPendingChallengesByAgent(authedId).catch(() => {});
  return c.json({ ok: true, unlinked: res.changes > 0 });
});

// ─────────────────────────── public ───────────────────────────

const publicRoutes = new Hono<AppEnv>();

/**
 * GET /v1/agentid/links/:link_id
 * Poll a pending link. status ∈ pending | linked | failed | expired | not_found.
 */
publicRoutes.get('/links/:link_id', async (c) => {
  const store = new AgentIdStore(c.get('db'));
  const row = await store.getChallengeByLinkId(c.req.param('link_id')).catch(() => null);
  if (!row) {
    return c.json({ status: 'not_found', error: 'unknown link_id' }, 404);
  }
  let status: string = row.status;
  if (row.status === 'pending' && !row.consumed_at && row.expires_at <= new Date().toISOString()) {
    status = 'expired';
  }
  return c.json({ status, agent_id: row.agent_id, error: row.error ?? null });
});

/**
 * GET /v1/agentid/callback
 * AgentID's OIDC redirect target. This leg is an ANONYMOUS browser request and
 * only the AgentSig-authenticated START leg knows which agent the link is for,
 * so the two legs cannot be assumed to be the same principal (account-linking
 * CSRF). We therefore do NOT commit here: we peek the challenge (no consume) and
 * render a consent page that names the EXACT target agent, so whoever signed in
 * can see — and must explicitly approve — which agent will carry their verified
 * identity. Commit happens only on the POST below, which carries the one-time
 * `code` delivered solely to this browser.
 */
publicRoutes.get('/callback', async (c) => {
  const db = c.get('db');
  const store = new AgentIdStore(db);

  const errParam = c.req.query('error');
  const state = c.req.query('state');
  const code = c.req.query('code');
  const nowIso = new Date().toISOString();

  const challenge = state ? await store.getChallengeByState(sha256hex(state), nowIso).catch(() => null) : null;

  if (errParam) {
    // Don't persist the raw query param to the public poll; log it instead.
    if (challenge) {
      console.error(`[agentid] authorize error for ${challenge.link_id}: ${errParam}`);
      await store.markChallengeFailed(challenge.link_id, 'authorize_error').catch(() => {});
    }
    return resultPage(c, false, 'Sign-in was cancelled or failed', 'AgentID reported a sign-in error. Start a new link.');
  }
  if (!state || !challenge) {
    return resultPage(c, false, 'Link request not found', 'This link request has expired or was already used. Start a new one.');
  }
  if (!code) {
    await store.markChallengeFailed(challenge.link_id, 'callback missing code').catch(() => {});
    return resultPage(c, false, 'Invalid callback', 'AgentID did not return an authorization code. Start a new link.');
  }

  const agent = await db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', challenge.agent_id).catch(() => null);

  // Bind this browser to the challenge (set-once): mint a secret, store its hash,
  // and drop it as an HttpOnly cookie. The confirm POST must present the matching
  // cookie, so a leaked one-time `code` alone cannot complete the link from a
  // different browser that never loaded this consent page.
  const bindingSecret = randomToken();
  const bound = await store.bindConfirmOnce(sha256hex(state), sha256hex(bindingSecret), nowIso).catch(() => false);
  if (bound) {
    setCookie(c, confirmCookieName(challenge.link_id), bindingSecret, {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax',
      path: CONFIRM_COOKIE_PATH,
      maxAge: 15 * 60,
    });
  }
  return consentPage(c, { agentId: challenge.agent_id, agentName: agent?.name ?? null, state, code });
});

/**
 * POST /v1/agentid/callback/confirm
 * The owner has seen the target agent on the consent page and approved. Only now
 * do we consume the challenge (single-use), exchange the code, verify the
 * id_token, and commit the link. The `code` is a one-time value delivered only
 * to the browser that completed sign-in, so an attacker cannot forge this POST.
 */
publicRoutes.post('/callback/confirm', async (c) => {
  const db = c.get('db');
  const store = new AgentIdStore(db);

  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const state = typeof form.state === 'string' ? form.state : undefined;
  const code = typeof form.code === 'string' ? form.code : undefined;

  if (!state || !code) {
    return resultPage(c, false, 'Invalid confirmation', 'Missing code or state. Start a new link.');
  }

  const nowIso = new Date().toISOString();
  const stateHash = sha256hex(state);

  // Verify the consent-browser binding BEFORE consuming, so a POST from a browser
  // that never loaded the consent page (e.g. one replaying a leaked code) is
  // rejected without burning the challenge for the legitimate owner.
  const peek = await store.getChallengeByState(stateHash, nowIso).catch(() => null);
  if (!peek) {
    return resultPage(c, false, 'Link request not found', 'This link request has expired or was already used. Start a new one.');
  }
  const cookie = getCookie(c, confirmCookieName(peek.link_id));
  if (!peek.confirm_binding || !cookie || !timingSafeEqual(sha256hex(cookie), peek.confirm_binding)) {
    return resultPage(
      c,
      false,
      'Confirmation could not be verified',
      'Open the sign-in link again in the same browser and confirm from there.',
    );
  }

  // Binding matched — consume now (atomic, single-use) — the commitment point.
  const challenge = await store.consumeChallengeByState(stateHash, nowIso).catch(() => null);
  if (!challenge) {
    return resultPage(c, false, 'Link request not found', 'This link request has expired or was already used. Start a new one.');
  }
  deleteCookie(c, confirmCookieName(challenge.link_id), { path: CONFIRM_COOKIE_PATH });

  const cfg = agentIdConfigFor(c.env);
  if (!cfg) {
    await store.markChallengeFailed(challenge.link_id, 'agentid disabled').catch(() => {});
    return resultPage(c, false, 'AgentID is not enabled', STATUS_HINT);
  }

  try {
    const client = new AgentIdOidcClient(cfg);
    const tokens = await client.exchangeCode(code, challenge.code_verifier);
    const claims = await client.verifyIdToken(tokens.id_token, { nonce: challenge.nonce });

    const sub = claims.sub;
    // Guard the one-AgentID-per-agent / one-agent-per-AgentID invariant with a
    // clear error before relying on the UNIQUE(issuer, sub) index.
    const bySub = await store.getLinkBySub(cfg.issuer, sub);
    if (bySub && bySub.agent_id !== challenge.agent_id) {
      await store.markChallengeFailed(challenge.link_id, 'AgentID already linked to another agent').catch(() => {});
      return resultPage(c, false, 'Already linked', 'This AgentID is already linked to a different BasedAgents agent.');
    }

    const email = typeof claims.email === 'string' ? claims.email : null;
    const displayName =
      (typeof claims.name === 'string' && claims.name) ||
      (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
      null;
    await store.upsertLink({
      agentId: challenge.agent_id,
      issuer: cfg.issuer,
      sub,
      ownerSub: typeof claims.owner_sub === 'string' ? claims.owner_sub : null,
      email,
      emailVerified: claims.email_verified === true,
      displayName,
      nowIso: new Date().toISOString(),
    });
    await store.markChallengeLinked(challenge.link_id);

    return resultPage(
      c,
      true,
      'AgentID linked',
      `${challenge.agent_id} is now verified. You can close this window and return to your terminal.`,
    );
  } catch (err) {
    // Log the detailed reason server-side, but persist only a coarse code: the
    // link-status poll is public, so raw upstream/DB error text must not leak.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[agentid] link verification failed for ${challenge.link_id}: ${message}`);
    await store.markChallengeFailed(challenge.link_id, 'verification_failed').catch(() => {});
    return resultPage(c, false, 'Verification failed', 'Could not verify the AgentID sign-in. Start a new link.');
  }
});

// ─────────────────────────── helpers ───────────────────────────

/** Forbid framing so the consent/result pages can't be clickjacked behind an overlay. */
function setAntiFrame(c: Context<AppEnv>): void {
  c.header('Content-Security-Policy', "frame-ancestors 'none'");
  c.header('X-Frame-Options', 'DENY');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

/**
 * The consent interstitial: names the exact target agent so whoever completed
 * the AgentID sign-in can see which agent will carry their verified identity and
 * must click Confirm (defends against account-linking CSRF — a phished owner
 * sees an agent they do not recognise and cancels).
 */
function consentPage(
  c: Context<AppEnv>,
  p: { agentId: string; agentName: string | null; state: string; code: string },
) {
  const who = p.agentName ? `${escapeHtml(p.agentName)} (${escapeHtml(p.agentId)})` : escapeHtml(p.agentId);
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Confirm AgentID link — BasedAgents</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; min-height: 100vh;
    display: grid; place-items: center; background: #fafafa; color: #111; }
  @media (prefers-color-scheme: dark) { body { background: #0b0b0c; color: #e8e8e8; } }
  .card { max-width: 32rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.3rem; margin: 0 0 0.5rem; }
  .agent { font-weight: 600; }
  code { font-family: ui-monospace, monospace; word-break: break-all; }
  .warn { opacity: 0.8; font-size: 0.9rem; margin: 0.75rem 0 1.25rem; }
  button { font: inherit; padding: 0.6rem 1.4rem; border-radius: 8px; border: 0;
    background: #16a34a; color: white; cursor: pointer; }
</style></head>
<body><div class="card">
<h1>Link your AgentID?</h1>
<p>You are about to attach your verified AgentID to the BasedAgents agent:</p>
<p class="agent"><code>${who}</code></p>
<p class="warn">Only continue if this is <strong>your</strong> agent. If you do not recognise it, close this window — someone may be trying to attach your identity to their agent.</p>
<form method="post" action="/v1/agentid/callback/confirm">
  <input type="hidden" name="state" value="${escapeHtml(p.state)}">
  <input type="hidden" name="code" value="${escapeHtml(p.code)}">
  <button type="submit">Confirm &amp; link</button>
</form>
<p style="margin-top:1rem;opacity:0.6"><a href="https://basedagents.ai" style="color:inherit">BasedAgents</a></p>
</div></body></html>`;
  setAntiFrame(c);
  return c.html(body, 200);
}

function resultPage(c: Context<AppEnv>, ok: boolean, title: string, detail: string) {
  const accent = ok ? '#16a34a' : '#dc2626';
  const mark = ok ? '✓' : '✕';
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} — BasedAgents</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; min-height: 100vh;
    display: grid; place-items: center; background: #fafafa; color: #111; }
  @media (prefers-color-scheme: dark) { body { background: #0b0b0c; color: #e8e8e8; } }
  .card { max-width: 32rem; padding: 2rem; text-align: center; }
  .mark { font-size: 2.5rem; line-height: 1; color: ${accent}; }
  h1 { font-size: 1.3rem; margin: 0.75rem 0 0.5rem; }
  p { margin: 0.25rem 0; opacity: 0.85; }
  code { font-family: ui-monospace, monospace; }
</style></head>
<body><div class="card"><div class="mark">${mark}</div>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>
<p style="margin-top:1rem;opacity:0.6"><a href="https://basedagents.ai" style="color:inherit">BasedAgents</a></p>
</div></body></html>`;
  setAntiFrame(c);
  return c.html(body, ok ? 200 : 400);
}

export { agentScoped as agentScopedAgentIdRoutes, publicRoutes as publicAgentIdRoutes };
