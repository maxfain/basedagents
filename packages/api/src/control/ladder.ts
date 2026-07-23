/**
 * The authority ladder — anonymous → email (magic link) → passkey.
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * Onboarding redesign (spec v0.2 §5.1): there is no signup form. `keyring
 * init` on the user's machine creates the vault + agent identity and a LINK
 * CODE here; the /link page claims it with one email field. The magic-link
 * click RATIFIES: owner creation (id still derived from the vault Ed25519
 * key), the delegation of the linking agent, and the vault-key binding. The
 * passkey — still the authority root from then on — is minted at the FIRST
 * APPROVAL, the first moment authority is exercised.
 *
 * What the claim's authority rests on, stated honestly: possession of the
 * email inbox plus physical control of the machine that ran `init` (the code
 * never leaves that machine except through the browser the user opened).
 * Every mutating action after the first approval requires a fresh WebAuthn
 * assertion exactly as before; the daemon still independently re-verifies
 * approvals against locally anchored passkeys before sealing (§2).
 *
 * Agent-first entry (§2b): a registered agent may `invite_owner(email)`. An
 * invite is NOT an account — claim-pending holds authority over nothing,
 * structurally (no owner row, no vault key, no delegation exist until a
 * human claims a LINK, which requires running init). Invites expire in 72h
 * and are rate-limited per agent with re-send backoff.
 *
 * Routes (mounted at /v1/owner):
 *   CLI-facing (no session):
 *     POST /link                    create a link code (from `keyring init`)
 *     GET  /link/:code              link status for the /link page + CLI polling
 *     POST /link/:code/claim        submit the email → magic link sent
 *     POST /claim/finish            magic-link token → owner+delegation+binding+session
 *     POST /login/email             magic-link login (look-only session)
 *     POST /login/email/finish      token → session
 *     POST /start/email             browser door: magic link to ANY address
 *     POST /start/finish            token → session (returning) | agent command
 *                                   + a start code binding the verified email
 *                                   (first-time; pre-addresses the /link claim)
 *   Agent-facing (AgentSig):
 *     POST /invites                 invite_owner(email)
 *     POST /invites/claim           invite magic-link → verified, shows init instructions
 *   Owner-facing (session):
 *     POST /connections             browser-SEALED provider token (ciphertext only)
 *     GET  /connections             card polling
 *   Daemon-facing (daemonAuth, in approvals.ts style):
 *     GET  /daemon/connections      pull pending sealed connections
 *     POST /daemon/connections/:id/resolve   stored | failed
 *     POST /daemon/credential-facts per-key rotatability report (metadata only)
 *                                   → owner reads via GET /credential-facts
 *     GET  /daemon/revocations      revoked delegations awaiting the local kill
 *     POST /daemon/revocations/:id/confirm   counts-only kill report
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types/index.js';
import { ControlStore } from './store.js';
import { ownerIdFromVaultPubkey } from './identity.js';
import { ownerSession, mintSession } from './routes.js';
import { daemonAuth } from './approvals.js';
import { agentAuthAllowUnregistered } from '../middleware/auth.js';
import { checkAgentLimit } from './entitlements.js';
import { emailSenderFromEnv, consoleOrigin } from './email.js';
import type { EmailSender } from './email.js';
import { base58Decode, base58Encode, sha256, bytesToHex, verifySignature } from '../crypto/index.js';
import { base64urlEncode } from './webauthn.js';

const LINK_CODE_TTL_SECONDS = 1800; // 30m — init → browser → email round trip
const MAGIC_LINK_TTL_SECONDS = 900; // 15m
// The browser-door start code sits UPSTREAM of the link code: it has to
// survive the gap between the inbox click and the human actually pasting the
// prompt to an agent, so it outlives both TTLs above.
const START_CODE_TTL_SECONDS = 3600; // 60m
const INVITE_TTL_SECONDS = 72 * 3600; // 72h (spec §2b)
const INVITES_PER_AGENT_PER_DAY = 3;
const INVITE_RESEND_MIN_SECONDS = 15 * 60;
const INVITE_MAX_SENDS = 3;

const textEncoder = new TextEncoder();

function sha256hex(input: string): string {
  return bytesToHex(sha256(textEncoder.encode(input)));
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function nowIso(): string {
  return new Date().toISOString();
}

function getStore(c: Context<AppEnv>): ControlStore {
  return new ControlStore(c.get('db'));
}

function getOwnerId(c: Context<AppEnv>): string {
  return (c.get as (k: string) => string)('ownerId');
}

function err(c: Context<AppEnv>, status: 400 | 401 | 402 | 404 | 409 | 429, error: string, message: string) {
  return c.json({ error, message }, status);
}

async function parseJson(c: Context<AppEnv>): Promise<unknown> {
  return c.req.json();
}

function isE2E(env: unknown): boolean {
  return ((env ?? {}) as Record<string, string | undefined>).E2E === '1';
}

/** Same resolution order as recovery.ts: injected → E2E outbox → env. */
function getEmailSender(c: Context<AppEnv>): EmailSender {
  const injected = (c.get as (k: string) => EmailSender | undefined)('emailSender');
  if (injected) return injected;
  if (isE2E(c.env)) {
    const store = getStore(c);
    return { send: async (m) => store.appendTestOutbox(m.to, m.subject, m.text) };
  }
  return emailSenderFromEnv(c.env);
}

// ─── validation schemas ───

const CreateLinkSchema = z.object({
  vault_public_key: z.string().min(1),
  agent_id: z.string().min(1),
  agent_public_key: z.string().min(1),
  agent_name: z.string().max(120).optional(),
  /** Ed25519 signature by the VAULT key over linkCanonical(...) — proof the
   *  caller physically holds the vault private key (base64). */
  vault_signature: z.string().min(1),
  /** Browser-door hand-off (`init --start st_…`): a single-use code minted at
   *  /start/finish, bound to the there-verified email. Carries NO authority —
   *  it only pre-addresses the claim email. Invalid/expired codes are ignored
   *  (the /link page falls back to its email field), never an error. */
  start_code: z.string().max(64).optional(),
});

/** `m•••@example.com` — all any unauthenticated surface ever sees of it. */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  return at > 0 ? `${email[0]}•••${email.slice(at)}` : `${email[0] ?? ''}•••`;
}

/**
 * The message the vault key signs to prove possession when creating a link
 * code. Binds the vault key to the exact agent it is linking, so a captured
 * signature can't be replayed to link a different agent. Must byte-match the
 * daemon's signer (packages/keyring/src/cli/onboard.ts).
 */
function linkCanonical(vaultPublicKey: string, agentId: string, agentPublicKey: string): string {
  return `keyring-link:v1:${vaultPublicKey}:${agentId}:${agentPublicKey}`;
}

// email is optional when the link code carries a start-code-attached address.
const ClaimSubmitSchema = z.object({ email: z.string().email().optional() });
const TokenSchema = z.object({ token: z.string().min(1) });
const EmailLoginSchema = z.object({ email: z.string().email() });
const InviteSchema = z.object({ email: z.string().email() });

/** Providers the daemon can provision end-to-end (Provisioner recipes). */
// Providers the daemon can mint (kind 'provision') and rotate (kind 'rotate')
// on the user's machine. Must track the daemon's PROVISIONABLE list
// (packages/keyring/src/cli/sync.ts) — this gate 400s the console button
// before a row is ever created for a provider no daemon could serve.
const PROVISION_PROVIDERS = new Set(['vercel', 'supabase']);

const CreateConnectionSchema = z
  .object({
    agent_id: z.string().min(1),
    provider: z.string().min(1).max(40),
    label: z.string().max(120).optional(),
    env_var: z.string().max(80).optional(),
    /**
     * 'sealed' (default): the browser sealed a pasted token; sealed_secret is
     * required ciphertext. 'provision': the daemon mints the token itself —
     * no secret travels in either direction, so sealed_secret must be absent.
     * 'rotate': the daemon mints a REPLACEMENT for an existing minted key and
     * burns the old one; rotate_credential_id names the daemon-side target.
     */
    kind: z.enum(['sealed', 'provision', 'rotate']).optional(),
    /** base64 sealed box → the owner's vault key. NEVER a raw secret. */
    sealed_secret: z.string().min(1).max(20_000).optional(),
    /** kind 'rotate' only: the daemon credential id to rotate in place. */
    rotate_credential_id: z.string().min(1).max(200).optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.kind ?? 'sealed') === 'sealed') {
      if (!v.sealed_secret) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'sealed_secret required for sealed connections' });
      }
    } else if (v.sealed_secret) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'provision/rotate connections never carry a secret' });
    }
    if (v.kind === 'rotate' && !v.rotate_credential_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'rotate_credential_id required for rotate connections' });
    }
  });

const ResolveConnectionSchema = z
  .object({
    daemon_credential_id: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
  })
  .refine((v) => !!v.daemon_credential_id || !!v.error, { message: 'daemon_credential_id or error required' });

const PassportRequestSchema = z.object({
  /** base58 Ed25519 pubkey generated in the human's browser, held only there. */
  browser_public_key: z.string().min(32).max(64),
});
const PassportFulfillSchema = z.object({
  /** base64 sealed box → the browser key. The plane can never open it. */
  sealed_passport: z.string().min(1).max(50_000),
});
const ShelfSnapshotSchema = z.object({
  snapshot: z.array(z.object({
    credential_id: z.string().min(1).max(80),
    v: z.number().int().min(1).max(10),
    meta: z.string().max(20_000),
    sealed: z.string().max(200_000),
    grants: z.string().max(100_000),
  })).max(500),
});

// ─── the sub-app ───

const app = new Hono<AppEnv>();

// ── CLI: create a link code ──

app.post('/link', async (c) => {
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = CreateLinkSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  // Both keys must be real Ed25519 points; the agent id must derive from the
  // agent key (nothing here is trusted yet — the claim is where trust enters).
  let vaultPub: Uint8Array, agentPub: Uint8Array;
  try {
    vaultPub = base58Decode(parsed.data.vault_public_key);
    agentPub = base58Decode(parsed.data.agent_public_key);
    if (vaultPub.length !== 32 || agentPub.length !== 32) throw new Error('bad length');
  } catch {
    return err(c, 400, 'bad_request', 'invalid public key');
  }
  if (parsed.data.agent_id !== `ag_${parsed.data.agent_public_key}`) {
    return err(c, 400, 'bad_request', 'agent_id does not match agent_public_key');
  }

  // PROOF OF POSSESSION (closes the account-takeover hole): the owner id is
  // ow_<base58(vaultPub)>, a NON-secret identifier. Without this check anyone
  // who learns a victim's owner id could mint a link code for their vault and
  // then claim it under an attacker email. Requiring a vault-key signature
  // means only the holder of the vault PRIVATE key — i.e. whoever physically
  // ran `init` — can create a link code, which is exactly the authority the
  // spec says the claim rests on.
  let sigBytes: Uint8Array;
  try {
    sigBytes = Uint8Array.from(atob(parsed.data.vault_signature), (ch) => ch.charCodeAt(0));
  } catch {
    return err(c, 400, 'bad_request', 'invalid vault signature encoding');
  }
  const canonical = linkCanonical(parsed.data.vault_public_key, parsed.data.agent_id, parsed.data.agent_public_key);
  if (!(await verifySignature(textEncoder.encode(canonical), sigBytes, vaultPub))) {
    return err(c, 401, 'unauthorized', 'vault signature does not verify');
  }

  const store = getStore(c);
  const { id: linkId, code } = await store.createLinkCode({
    vaultPublicKey: parsed.data.vault_public_key,
    agentId: parsed.data.agent_id,
    agentPublicKey: parsed.data.agent_public_key,
    agentName: parsed.data.agent_name,
    ttlSeconds: LINK_CODE_TTL_SECONDS,
  });

  // RE-CLAIM detection first (field-hit): if this vault already has a claimed
  // owner, the owner's email is the ONLY address that can ratify — so
  // pre-address the claim to it, and IGNORE any start code (a start code for
  // a different address would aim the confirmation at an email that is
  // guaranteed to 409 at finish; left unconsumed, it stays valid). Otherwise:
  // browser-door hand-off — consume the start code (single-use, atomic) AFTER
  // the link code exists, so a failed create never burns it; on a stale or
  // reused code we degrade silently to the email field — a hint is never
  // worth failing `init` over.
  let emailHint: string | undefined;
  let reClaim = false;
  const existingOwner = await store.getOwner(ownerIdFromVaultPubkey(vaultPub));
  if (existingOwner?.email) {
    reClaim = true;
    await store.attachLinkEmail(linkId, existingOwner.email);
    emailHint = maskEmail(existingOwner.email);
  } else if (parsed.data.start_code) {
    const start = await store.consumeMagicLinkToken(sha256hex(parsed.data.start_code), 'start_code', nowIso());
    if (start) {
      await store.attachLinkEmail(linkId, start.email);
      emailHint = maskEmail(start.email);
    }
  }

  return c.json({
    code,
    url: `${consoleOrigin(c.env)}/link?code=${code}`,
    expires_in_seconds: LINK_CODE_TTL_SECONDS,
    ...(emailHint ? { email_hint: emailHint } : {}),
    ...(reClaim ? { re_claim: true } : {}),
  });
});

// ── Console + CLI polling: link status ──

app.get('/link/:code', async (c) => {
  const store = getStore(c);
  const link = await store.getLinkCode(c.req.param('code'));
  if (!link) return err(c, 404, 'not_found', 'unknown link code');
  const expired = link.status !== 'claimed' && link.expires_at <= nowIso();
  // Re-claim: the vault behind this link already has a claimed account — the
  // console words the page around "welcome back" and the attached address is
  // the account's own (the only one that can ratify).
  const linkOwner = await store.getOwner(ownerIdFromVaultPubkey(base58Decode(link.vault_public_key)));
  return c.json({
    status: expired ? 'expired' : link.status, // pending | email_sent | claimed | expired
    agent_id: link.agent_id,
    agent_name: link.agent_name,
    // Attached address (start-code or account email), MASKED — this endpoint
    // is unauthenticated (the code is in a URL), so the full email never
    // leaves the server.
    ...(link.email && !expired && link.status !== 'claimed'
      ? { email_hint: maskEmail(link.email) }
      : {}),
    ...(linkOwner?.email ? { re_claim: true } : {}),
  });
});

// ── Console: submit the claim email ──

app.post('/link/:code/claim', async (c) => {
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = ClaimSubmitSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'a valid email is required');

  const store = getStore(c);
  const link = await store.getLinkCode(c.req.param('code'));
  if (!link || link.status === 'claimed' || link.expires_at <= nowIso()) {
    return err(c, 404, 'not_found', 'this link has expired — run the setup command again');
  }

  // A typed email always wins ("use a different email"); with none, fall back
  // to the attached address (start-code or, for a re-claim, the account's
  // own). The confirmation email + click are NEVER skipped — pre-addressing
  // routes, it does not ratify.
  const email = parsed.data.email?.trim().toLowerCase() ?? link.email;
  if (!email) return err(c, 400, 'bad_request', 'a valid email is required');

  // Early mismatch rejection (field-hit): claim/finish would 409 a wrong
  // email anyway, but only AFTER the inbox round trip — reject it here, at
  // submission, with the fix in the message. No enumeration: this only
  // triggers for the holder of a vault-key-signed link code, about the
  // account that vault already belongs to.
  const claimOwner = await store.getOwner(ownerIdFromVaultPubkey(base58Decode(link.vault_public_key)));
  if (claimOwner?.email && claimOwner.email !== email) {
    return err(c, 409, 'conflict', 'this agent already belongs to an account — use the email you first claimed it with');
  }
  await store.markLinkEmailSent(link.id, email);

  const token = base64urlEncode(randomBytes(32));
  await store.createMagicLinkToken({
    tokenHash: sha256hex(token),
    purpose: 'claim',
    email,
    linkCodeId: link.id,
    ttlSeconds: MAGIC_LINK_TTL_SECONDS,
  });

  const agentName = link.agent_name ?? 'your agent';
  await getEmailSender(c).send({
    to: email,
    subject: `Take control of ${agentName}`,
    text:
      `${agentName} is ready to be set up with BasedAgents Keyring.\n\n` +
      `Click within 15 minutes to take control:\n\n` +
      `${consoleOrigin(c.env)}/claim#t=${token}\n\n` +
      `If you didn't run the setup command, ignore this email — nothing happens without this link.`,
  });
  return c.json({ ok: true });
});

// ── Console: finish the claim (the ratifying moment) ──

app.post('/claim/finish', async (c) => {
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = TokenSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  const store = getStore(c);
  const now = nowIso();

  // 1. ATOMICALLY consume the magic-link token (single-use). This is the
  //    authorization; a replayed click loses the race here.
  const consumed = await store.consumeMagicLinkToken(sha256hex(parsed.data.token), 'claim', now);
  if (!consumed || !consumed.link_code_id) return err(c, 401, 'unauthorized', 'invalid or expired link');

  const link = await store.getLinkCodeById(consumed.link_code_id);
  if (!link) return err(c, 401, 'unauthorized', 'invalid or expired link');
  if (link.status === 'claimed') return err(c, 409, 'conflict', 'this agent was already claimed');
  if (link.expires_at <= now) return err(c, 401, 'unauthorized', 'this link has expired');

  const ownerId = ownerIdFromVaultPubkey(base58Decode(link.vault_public_key));

  // 2. Resolve (or create) the owner IDEMPOTENTLY, and do it BEFORE the
  //    irreversible link-claim so a real conflict returns a clean error with
  //    the link still open (the CLI keeps polling instead of falsely showing
  //    "set up"). An EXISTING account may only be re-claimed by its own
  //    verified email — belt-and-suspenders behind /link's vault-key proof.
  let owner = await store.getOwner(ownerId);
  if (owner) {
    if (owner.email && owner.email !== consumed.email) {
      return err(c, 409, 'conflict', 'this vault already belongs to a different account');
    }
  } else {
    try {
      owner = await store.createOwner({ ownerId, email: consumed.email });
      await store.setEmailVerified(ownerId);
    } catch {
      // A concurrent claim created it first (PK race) → adopt it; otherwise
      // the email is registered to a DIFFERENT vault → real conflict.
      owner = await store.getOwner(ownerId);
      if (!owner) return err(c, 409, 'conflict', 'that email already belongs to another account');
      if (owner.email && owner.email !== consumed.email) {
        return err(c, 409, 'conflict', 'this vault already belongs to a different account');
      }
    }
  }

  // 3. Agent + vault binding (both idempotent).
  const agentPub = base58Decode(link.agent_public_key);
  await store.ensureAgent(link.agent_id, agentPub, link.agent_name ?? 'keyring agent');
  if (!(await store.getActiveVaultKey(ownerId))) {
    await store.createVaultBinding({ ownerId, vaultPublicKey: link.vault_public_key });
  }

  // 4. Delegation — idempotent: reactivate a REVOKED edge (re-running init for
  //    a previously-killed agent) instead of an INSERT that would collide on
  //    UNIQUE(owner_id, agent_id) and 500 the handler.
  let delegationBlocked: { active: number; max: number } | null = null;
  const existing = await store.getDelegation(ownerId, link.agent_id);
  if (!existing || existing.status !== 'active') {
    const limit = await checkAgentLimit(store, owner);
    if (!limit.allowed) {
      delegationBlocked = { active: limit.activeAgents, max: limit.maxAgents };
    } else if (existing) {
      await store.activateDelegation(ownerId, link.agent_id, link.agent_name ?? undefined);
    } else {
      await store.createDelegation({
        ownerId,
        agentId: link.agent_id,
        label: link.agent_name ?? undefined,
        authorizedVia: 'claim',
      });
    }
  }

  // 5. ATOMICALLY claim the link LAST — only now is the CLI's "set up" signal
  //    (link status === 'claimed') actually true. A second claim loses here.
  if (!(await store.claimLinkCode(link.id, now))) {
    return err(c, 409, 'conflict', 'this agent was already claimed');
  }
  await store.markInviteClaimed(consumed.email, now);

  // 6. A look session (email rung). The passkey is minted at the first approval.
  await mintSession(c, ownerId, { method: 'email' });

  return c.json({
    owner_id: ownerId,
    agent_id: link.agent_id,
    agent_name: link.agent_name,
    delegation_blocked: delegationBlocked, // null in the base case
  });
});

// ── Email login (look-only rung) ──

app.post('/login/email', async (c) => {
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = EmailLoginSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'a valid email is required');

  const store = getStore(c);
  const email = parsed.data.email.trim().toLowerCase();
  const owner = await store.getOwnerByEmail(email);
  if (owner) {
    const token = base64urlEncode(randomBytes(32));
    await store.createMagicLinkToken({
      tokenHash: sha256hex(token),
      purpose: 'login',
      email,
      ownerId: owner.id,
      ttlSeconds: MAGIC_LINK_TTL_SECONDS,
    });
    await getEmailSender(c).send({
      to: email,
      subject: 'Sign in to BasedAgents',
      text:
        `Click within 15 minutes to sign in:\n\n` +
        `${consoleOrigin(c.env)}/login#t=${token}\n\n` +
        `If you didn't request this, ignore this email.`,
    });
  }
  return c.json({ ok: true }); // uniform — no account enumeration
});

app.post('/login/email/finish', async (c) => {
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = TokenSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  const store = getStore(c);
  const consumed = await store.consumeMagicLinkToken(sha256hex(parsed.data.token), 'login', nowIso());
  if (!consumed?.owner_id) return err(c, 401, 'unauthorized', 'invalid or expired link');

  await mintSession(c, consumed.owner_id, { method: 'email' });
  return c.json({ owner_id: consumed.owner_id });
});

// ── Browser start door (onboarding redesign §2, /start) ──
//
// The web "Start in your browser" door: one email field, no password, no form.
// A magic link is sent to ANY address (unlike /login/email, which is silent for
// unknowns) because the finish page is useful either way — returning owners get
// a look session; a brand-new address gets the command to paste to its agent.
// The email text is uniform, so this still leaks nothing about who has an
// account (the branch is only visible to the recipient, and shows public copy).

app.post('/start/email', async (c) => {
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = EmailLoginSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'a valid email is required');

  const store = getStore(c);
  const email = parsed.data.email.trim().toLowerCase();
  const owner = await store.getOwnerByEmail(email);

  const token = base64urlEncode(randomBytes(32));
  await store.createMagicLinkToken({
    tokenHash: sha256hex(token),
    purpose: 'start',
    email,
    ownerId: owner?.id, // null for a first-time visitor — resolved at finish
    ttlSeconds: MAGIC_LINK_TTL_SECONDS,
  });
  await getEmailSender(c).send({
    to: email,
    subject: 'Continue with BasedAgents',
    text:
      `Click within 15 minutes to pick up where you left off:\n\n` +
      `${consoleOrigin(c.env)}/start#t=${token}\n\n` +
      `If you didn't request this, ignore this email.`,
  });
  return c.json({ ok: true }); // uniform response
});

app.post('/start/finish', async (c) => {
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = TokenSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  const store = getStore(c);
  const consumed = await store.consumeMagicLinkToken(sha256hex(parsed.data.token), 'start', nowIso());
  if (!consumed) return err(c, 401, 'unauthorized', 'invalid or expired link');

  // Returning owner → mint the look session. First-time visitor → no account
  // yet; the console shows the agent-paste command (setup still happens where
  // the agent lives, never a browser-side vault) — but the just-verified email
  // is NOT discarded: a single-use start code binds it, rides the prompt as
  // `--start st_…`, and pre-addresses the eventual /link claim (CONTROL_PLANE
  // §8, "the start code"). The code carries no authority — the magic-link
  // click still ratifies.
  if (consumed.owner_id) {
    await mintSession(c, consumed.owner_id, { method: 'email' });
    return c.json({ has_account: true });
  }
  const startCode = `st_${base58Encode(randomBytes(9))}`;
  await store.createMagicLinkToken({
    tokenHash: sha256hex(startCode),
    purpose: 'start_code',
    email: consumed.email,
    ttlSeconds: START_CODE_TTL_SECONDS,
  });
  return c.json({
    has_account: false,
    start_code: startCode,
    start_code_expires_in_seconds: START_CODE_TTL_SECONDS,
  });
});

// ── Agent-first entry: invite_owner ──

app.post('/invites', agentAuthAllowUnregistered, async (c) => {
  const agentId = (c.get as (k: string) => string)('agentId');
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = InviteSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'a valid email is required');
  const email = parsed.data.email.trim().toLowerCase();

  const store = getStore(c);

  // Abuse brakes (§2b): per-agent daily cap; per-(email,agent) send backoff.
  const daily = await store.countRecentInvitesByAgent(agentId, new Date(Date.now() - 86_400_000).toISOString());
  if (daily >= INVITES_PER_AGENT_PER_DAY) {
    return err(c, 429, 'rate_limited', 'invite limit reached for this agent — try again tomorrow');
  }

  const agentRow = await c.get('db').get<Record<string, unknown>>(
    `SELECT name FROM agents WHERE id = ?`, agentId,
  );
  const agentName = (agentRow?.name as string | undefined) ?? 'An agent';

  const open = await store.getOpenInvite(email, agentId);
  if (open) {
    if (open.invite_count >= INVITE_MAX_SENDS) {
      return err(c, 429, 'rate_limited', 'this email has not responded — no more invites will be sent');
    }
    if (open.last_sent_at && Date.now() - Date.parse(open.last_sent_at) < INVITE_RESEND_MIN_SECONDS * 1000) {
      return err(c, 429, 'rate_limited', 'an invite was sent recently — wait before re-sending');
    }
    await store.touchInvite(open.id, nowIso());
  } else {
    await store.createInvite({ email, agentId, agentName, ttlSeconds: INVITE_TTL_SECONDS });
  }

  const token = base64urlEncode(randomBytes(32));
  await store.createMagicLinkToken({
    tokenHash: sha256hex(token),
    purpose: 'claim', // invite claims verify the email; account creation still requires a link code
    email,
    ttlSeconds: INVITE_TTL_SECONDS,
  });
  await getEmailSender(c).send({
    to: email,
    subject: `An agent named ${agentName} wants you as its owner`,
    text:
      `${agentName} registered itself with BasedAgents and asked to be set up under your account.\n\n` +
      `Click to accept (valid 72 hours):\n\n` +
      `${consoleOrigin(c.env)}/invited#t=${token}\n\n` +
      `Until you accept and finish setup on your own machine, this agent can hold nothing ` +
      `and access nothing. If you don't know this agent, ignore this email.`,
  });
  return c.json({ ok: true, status: 'invited' });
});

app.post('/invites/claim', async (c) => {
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = TokenSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  const store = getStore(c);
  const now = nowIso();
  const consumed = await store.consumeMagicLinkToken(sha256hex(parsed.data.token), 'claim', now);
  if (!consumed) return err(c, 401, 'unauthorized', 'invalid or expired invite');
  // Email possession is now verified; the account itself is created only when
  // a link code (from `init` on the human's machine) is claimed — an agent can
  // never finish creating its own owner.
  await store.markInviteClaimed(consumed.email, now);
  return c.json({
    ok: true,
    email: consumed.email,
    next_step: 'Run the setup command on your machine to finish taking control.',
  });
});

// ── Connections (the connect card): sealed in the browser, resolved by the daemon ──

app.post('/connections', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = CreateConnectionSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  const store = getStore(c);
  const delegation = await store.getDelegation(ownerId, parsed.data.agent_id);
  if (!delegation || delegation.status !== 'active') {
    return err(c, 400, 'bad_request', 'that agent is not connected to this account');
  }

  const kind = parsed.data.kind ?? 'sealed';
  if ((kind === 'provision' || kind === 'rotate') && !PROVISION_PROVIDERS.has(parsed.data.provider)) {
    return err(c, 400, 'bad_request', kind === 'rotate'
      ? 'that provider cannot be rotated automatically yet'
      : 'that provider cannot be set up automatically yet');
  }

  const id = await store.createPendingConnection({
    ownerId,
    agentId: parsed.data.agent_id,
    provider: parsed.data.provider,
    label: parsed.data.label,
    envVar: parsed.data.env_var,
    sealedSecret: parsed.data.sealed_secret ?? '',
    kind,
    // Rotate rows are BORN with their target — the daemon credential to
    // rotate in place. (Sealed/provision rows get this set at resolve time.)
    daemonCredentialId: kind === 'rotate' ? parsed.data.rotate_credential_id : undefined,
  });
  return c.json({ id, status: 'pending' });
});

app.get('/connections', ownerSession, async (c) => {
  const store = getStore(c);
  // Reap stale rows first — the console must never spin forever: an abandoned
  // claim (daemon died mid-work) OR a pending "Do it for me" with no daemon
  // running at all. includePending fires only here, where a human is watching
  // and wants an end state (store.expireStaleConnections).
  await store.expireStaleConnections(getOwnerId(c), { includePending: true });
  const rows = await store.listPendingConnections(getOwnerId(c));
  // Never echo ciphertext back to the browser — status only. The daemon
  // credential id is metadata (an opaque local id), and the console needs it
  // to offer per-key rotation on stored rows.
  return c.json({
    connections: rows.map((r) => ({
      id: r.id, agent_id: r.agent_id, provider: r.provider, label: r.label, kind: r.kind,
      status: r.status, failure_reason: r.failure_reason, created_at: r.created_at,
      daemon_credential_id: r.daemon_credential_id ?? null,
    })),
  });
});

// ── Daemon: pull + resolve sealed connections ──

app.get('/daemon/connections', daemonAuth, async (c) => {
  const store = getStore(c);
  // Processing-only reap here: a freshly-started daemon must still be able to
  // claim an old PENDING row and service it, so we never fail pending work on
  // the daemon path (only the console path does, above).
  await store.expireStaleConnections(getOwnerId(c));
  const rows = await store.listPendingConnections(getOwnerId(c), 'pending');
  // Non-sealed rows only go to daemons that ask for that kind by name
  // (?include=provision,rotate) — an older daemon must never receive a row
  // it would misread as sealed.
  const include = new Set((c.req.query('include') ?? '').split(','));
  return c.json({
    connections: rows
      .filter((r) => r.kind === 'sealed' || include.has(r.kind))
      .map((r) => ({
        id: r.id, agent_id: r.agent_id, provider: r.provider, label: r.label,
        env_var: r.env_var, sealed_secret: r.sealed_secret, kind: r.kind, created_at: r.created_at,
        daemon_credential_id: r.daemon_credential_id ?? null,
      })),
  });
});

app.post('/daemon/connections/:id/claim', daemonAuth, async (c) => {
  const claimed = await getStore(c).claimPendingConnection(c.req.param('id'), getOwnerId(c));
  return c.json({ claimed });
});

app.post('/daemon/connections/:id/resolve', daemonAuth, async (c) => {
  const ownerId = getOwnerId(c);
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = ResolveConnectionSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  const ok = await getStore(c).resolvePendingConnection({
    id: c.req.param('id'),
    ownerId,
    outcome: parsed.data.daemon_credential_id ? 'stored' : 'failed',
    daemonCredentialId: parsed.data.daemon_credential_id,
    failureReason: parsed.data.error,
  });
  if (!ok) return err(c, 404, 'not_found', 'connection not found or already resolved');
  return c.json({ ok: true });
});

// ─── Credential facts (migration 0031) ───
//
// The daemon reports which machine-local keys the console's per-key actions
// can actually work on (currently: rotatable). Only the machine knows —
// provider-side ids live in the vault and never leave it — so the console
// hides Rotate only on an affirmative rotatable:false; unreported keys keep
// the optimistic button (old daemons lose nothing). Metadata only.

const CredentialFactsSchema = z.object({
  credentials: z.array(z.object({
    id: z.string().min(1).max(200),
    provider: z.string().min(1).max(50),
    rotatable: z.boolean(),
  })).max(200),
});

app.post('/daemon/credential-facts', daemonAuth, async (c) => {
  let body: unknown;
  try { body = await parseJson(c); } catch { return err(c, 400, 'bad_request', 'invalid JSON body'); }
  const parsed = CredentialFactsSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');
  await getStore(c).upsertCredentialFacts(
    getOwnerId(c),
    parsed.data.credentials.map((f) => ({ credentialId: f.id, provider: f.provider, rotatable: f.rotatable })),
  );
  return c.json({ ok: true });
});

app.get('/credential-facts', ownerSession, async (c) => {
  return c.json({ facts: await getStore(c).listCredentialFacts(getOwnerId(c)) });
});

// ─── Revocation orders (migration 0032) — the kill switch's local half ───
//
// The console kill revokes the delegation HERE; the machine holding the vault
// must still revoke local grants, burn minted provider-side keys, and sweep
// for ambient residuals. The daemon pulls revoked-but-unconfirmed delegations,
// runs the same local kill as `based kill`, and confirms with a counts-only
// report (numbers and a short note, never values). Until a confirm arrives the
// console shows "cut off at the account" — never "your machine dropped it" on
// faith. Field-hit: this half used to not exist while the UI copy promised it.

const KillReportSchema = z.object({
  revoked_grants: z.number().int().min(0).max(10_000),
  burned: z.number().int().min(0).max(10_000),
  burn_failures: z.number().int().min(0).max(10_000),
  residuals: z.number().int().min(0).max(10_000),
  note: z.string().max(500).optional(),
});

app.get('/daemon/revocations', daemonAuth, async (c) => {
  const rows = await getStore(c).listUnconfirmedRevocations(getOwnerId(c));
  return c.json({
    revocations: rows.map((r) => ({
      delegation_id: r.id, agent_id: r.agent_id, label: r.label, revoked_at: r.revoked_at,
    })),
  });
});

app.post('/daemon/revocations/:id/confirm', daemonAuth, async (c) => {
  let body: unknown;
  try { body = await parseJson(c); } catch { return err(c, 400, 'bad_request', 'invalid JSON body'); }
  const parsed = KillReportSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');
  const ok = await getStore(c).confirmDelegationKill(
    getOwnerId(c), c.req.param('id'), JSON.stringify(parsed.data),
  );
  if (!ok) return err(c, 404, 'not_found', 'revocation not found or already confirmed');
  return c.json({ ok: true });
});

// ─── Cloud passport (SANDBOX_SPEC §4b) ───

// Console: ask the machine that holds the vault authority to seal a passport
// to a browser-held ephemeral key. Carries only a public key.
app.post('/passport', ownerSession, async (c) => {
  let body: unknown;
  try { body = await parseJson(c); } catch { return err(c, 400, 'bad_request', 'invalid JSON body'); }
  const parsed = PassportRequestSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');
  const id = await getStore(c).createPassportHandoff(getOwnerId(c), parsed.data.browser_public_key);
  return c.json({ id, status: 'pending' });
});

// Console poll: one-shot — the ciphertext is returned exactly once, then blanked.
app.get('/passport/:id', ownerSession, async (c) => {
  const out = await getStore(c).consumePassportHandoff(c.req.param('id'), getOwnerId(c));
  if (out.status === 'not_found') return err(c, 404, 'not_found', 'no such request');
  return c.json({ status: out.status, sealed_passport: out.sealed_passport });
});

// Daemon: pending passport requests (public keys only).
app.get('/daemon/passport', daemonAuth, async (c) => {
  const handoffs = await getStore(c).listPendingPassportHandoffs(getOwnerId(c));
  return c.json({ handoffs });
});

app.post('/daemon/passport/:id/fulfill', daemonAuth, async (c) => {
  let body: unknown;
  try { body = await parseJson(c); } catch { return err(c, 400, 'bad_request', 'invalid JSON body'); }
  const parsed = PassportFulfillSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');
  const ok = await getStore(c).fulfillPassportHandoff(c.req.param('id'), getOwnerId(c), parsed.data.sealed_passport);
  if (!ok) return err(c, 404, 'not_found', 'request not found or already fulfilled');
  return c.json({ ok: true });
});

// ─── The shelf: control-plane copy of vault ciphertext for cloud re-materialization ───

// Deposits are gated on a fulfilled passport — laptop-only owners keep
// today's no-retention behavior. Snapshot semantics: absence deletes, so
// local revocation/removal propagates.
app.put('/daemon/shelf', daemonAuth, async (c) => {
  const store = getStore(c);
  const ownerId = getOwnerId(c);
  if (!(await store.hasFulfilledPassport(ownerId))) {
    return c.json({ ok: false, enabled: false });
  }
  let body: unknown;
  try { body = await parseJson(c); } catch { return err(c, 400, 'bad_request', 'invalid JSON body'); }
  const parsed = ShelfSnapshotSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');
  await store.putShelfSnapshot(ownerId, parsed.data.snapshot);
  return c.json({ ok: true, enabled: true });
});

app.get('/daemon/shelf', daemonAuth, async (c) => {
  const store = getStore(c);
  const ownerId = getOwnerId(c);
  const enabled = await store.hasFulfilledPassport(ownerId);
  const credentials = enabled ? await store.listShelf(ownerId) : [];
  return c.json({ enabled, credentials });
});

export default app;
