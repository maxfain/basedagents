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
 *     GET /callback             — AgentID's OIDC redirect target (browser).
 *     GET /links/:link_id       — public; poll a link's status (pending/linked/…).
 *
 * The link is an OPTIONAL attestation on top of AgentSig. Linking never grants
 * authority — the agent proves control of its ag_… key to START a link, and the
 * owner proves control of the AgentID in the browser to FINISH it. `owner_sub`
 * is stored for sybil-aware reputation but never exposed publicly.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
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
import { AgentIdStore } from '../agentid/store.js';

const STATUS_HINT = 'AgentID linking is not enabled on this registry. See GET /v1/status -> agentid.';

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
 * AgentID's OIDC redirect target. Exchanges the code, verifies the id_token,
 * records the link, and renders a plain HTML result page for the browser.
 */
publicRoutes.get('/callback', async (c) => {
  const db = c.get('db');
  const store = new AgentIdStore(db);

  const errParam = c.req.query('error');
  const state = c.req.query('state');
  const code = c.req.query('code');

  // Consume the challenge first (single-use) so a replayed callback can't reuse it.
  let challenge = null as Awaited<ReturnType<AgentIdStore['consumeChallengeByState']>>;
  if (state) {
    challenge = await store.consumeChallengeByState(sha256hex(state), new Date().toISOString()).catch(() => null);
  }

  if (errParam) {
    if (challenge) await store.markChallengeFailed(challenge.link_id, `authorize error: ${errParam}`).catch(() => {});
    return resultPage(c, false, 'Sign-in was cancelled or failed', `AgentID returned: ${errParam}`);
  }
  if (!state || !code) {
    return resultPage(c, false, 'Invalid callback', 'Missing code or state.');
  }
  if (!challenge) {
    return resultPage(c, false, 'Link request not found', 'This link request has expired or was already used. Start a new one.');
  }

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
    const message = err instanceof Error ? err.message : String(err);
    await store.markChallengeFailed(challenge.link_id, message).catch(() => {});
    return resultPage(c, false, 'Verification failed', 'Could not verify the AgentID sign-in. Start a new link.');
  }
});

// ─────────────────────────── helpers ───────────────────────────

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

function resultPage(c: Context<AppEnv>, ok: boolean, title: string, detail: string) {
  const accent = ok ? '#16a34a' : '#dc2626';
  const mark = ok ? '✓' : '✕';
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
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
  return c.html(body, ok ? 200 : 400);
}

export { agentScoped as agentScopedAgentIdRoutes, publicRoutes as publicAgentIdRoutes };
