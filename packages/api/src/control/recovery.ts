/**
 * Account recovery routes for the Keyring control plane (CONTROL_PLANE.md §6).
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * Recovery rotates AUTHORITY only. Two factors, both required, neither
 * sufficient alone:
 *   - the magic-link token (mailbox factor) — mailed on /recover/begin, lives
 *     in the link's URL fragment, sha256-stored, short-lived, single-use;
 *   - the offline recovery code (possession factor) — issued earlier to a
 *     signed-in owner via a passkey ceremony (POST /recovery-code), shown
 *     exactly once, sha256-stored, single-use, superseded by regeneration.
 *
 * A successful /recover/finish enrolls a NEW passkey and then, assuming the
 * account was compromised (that is why one recovers):
 *   - revokes every other passkey (they can no longer log in or sign actions);
 *   - revokes every live look-session.
 * The Ed25519 confidentiality key, the vault binding, and all ciphertext are
 * untouched — daemonAuth keeps working. The daemon's locally-anchored passkey
 * list is now stale BY DESIGN: the owner re-runs `based link` and confirms the
 * new fingerprint (§2 — the anchor is trusted because the human confirms it).
 *
 * Anti-enumeration: /recover/begin always answers {ok:true}; code/token
 * failures elsewhere are a uniform 401. All consumes are atomic conditional
 * writes (§4). Order in /recover/finish is deliberate:
 *   consume challenge → verify registration → consume code → consume token →
 *   add credential → revoke others → revoke sessions.
 * A crypto failure burns only the (re-armable) challenge, never a factor.
 *
 * Mounted by the coordinator at /v1/owner (alongside ./routes.ts).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types/index.js';
import { ControlStore } from './store.js';
import { rpConfig } from './config.js';
import { emailSenderFromEnv, consoleOrigin } from './email.js';
import type { EmailSender } from './email.js';
import { verifyRegistration, base64urlEncode } from './webauthn.js';
import { ownerSession, verifyAndRecordAction, AssertionSchema } from './routes.js';
import { sha256, bytesToHex, canonicalJsonStringify } from '../crypto/index.js';

// ─── small helpers (mirror ./routes.ts conventions) ───

const TOKEN_TTL_SECONDS = 900; // 15m — the mailbox factor is short-lived.
const CHALLENGE_TTL_SECONDS = 300;

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

function err(c: Context<AppEnv>, status: 400 | 401 | 404 | 409, error: string, message: string) {
  return c.json({ error, message }, status);
}

async function parseJson(c: Context<AppEnv>): Promise<unknown> {
  return c.req.json();
}

/** True when this deployment is an E2E test environment (never production). */
function isE2E(env: unknown): boolean {
  return ((env ?? {}) as Record<string, string | undefined>).E2E === '1';
}

/**
 * Tests inject a recording sender via c.set('emailSender'); an E2E=1
 * environment writes to the test_outbox table (readable via the test-only
 * endpoint below — Resend is never called in E2E, per the coder brief);
 * env-derived (Resend or log-only) otherwise.
 */
function getEmailSender(c: Context<AppEnv>): EmailSender {
  const injected = (c.get as (k: string) => EmailSender | undefined)('emailSender');
  if (injected) return injected;
  if (isE2E(c.env)) {
    const store = getStore(c);
    return {
      send: async (m) => {
        await store.appendTestOutbox(m.to, m.subject, m.text);
      },
    };
  }
  return emailSenderFromEnv(c.env);
}

/** Pull the challenge back out of a base64url clientDataJSON (mirror routes.ts). */
function extractChallenge(clientDataJSON: string): string | null {
  try {
    const b64 = clientDataJSON.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(b64)) as { challenge?: unknown };
    return typeof decoded.challenge === 'string' ? decoded.challenge : null;
  } catch {
    return null;
  }
}

// ─── recovery-code formatting ───

/**
 * 16 random bytes as grouped hex: "a1b2c3d4-e5f60718-293a4b5c-6d7e8f90".
 * Normalization strips separators/whitespace and lowercases, so users can
 * paste the code with or without dashes.
 */
function formatRecoveryCode(bytes: Uint8Array): string {
  const hex = bytesToHex(bytes);
  return [hex.slice(0, 8), hex.slice(8, 16), hex.slice(16, 24), hex.slice(24, 32)].join('-');
}

export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, '').toLowerCase();
}

// ─── validation schemas ───

const GenerateCodeSchema = z.object({
  nonce: z.string().min(1),
  assertion: AssertionSchema,
});

const RecoverBeginSchema = z.object({ email: z.string().email() });

const RecoverOptionsSchema = z.object({
  token: z.string().min(1),
  recovery_code: z.string().min(1),
});

const RecoverFinishSchema = z.object({
  token: z.string().min(1),
  recovery_code: z.string().min(1),
  attestationObject: z.string().min(1),
  clientDataJSON: z.string().min(1),
  transports: z.array(z.string()).optional(),
});

// ─── the sub-app ───

const app = new Hono<AppEnv>();

// ── E2E-only: read the test outbox (404s in every non-E2E environment) ──
//
// The Playwright suite reads recovery magic links from here instead of a real
// mailbox. Guarded by env, not by auth: the endpoint simply does not exist
// unless the deployment was explicitly started with E2E=1.
app.get('/test/outbox', async (c) => {
  if (!isE2E(c.env)) return err(c, 404, 'not_found', 'not found');
  const recipient = c.req.query('recipient');
  const store = getStore(c);
  return c.json({ messages: await store.listTestOutbox(recipient) });
});

// ── Issue a recovery code (signed-in owner, passkey ceremony) ──

app.post('/recovery-code', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = GenerateCodeSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  // The ceremony canonical has no params beyond the standard triple — issuing
  // a code is not parameterizable, but it IS authority (it can rotate every
  // passkey), so it demands a fresh assertion like any other mutation.
  const canonical = canonicalJsonStringify({
    action_type: 'generate_recovery_code',
    owner_id: ownerId,
    nonce: parsed.data.nonce,
  });
  const outcome = await verifyAndRecordAction(c, ownerId, 'generate_recovery_code', canonical, parsed.data.assertion);
  if (!outcome.ok) return outcome.res;

  const code = formatRecoveryCode(randomBytes(16));
  const store = getStore(c);
  const { created_at } = await store.createRecoveryCode(ownerId, sha256hex(normalizeRecoveryCode(code)));

  // The ONLY time the plaintext exists outside the owner's custody.
  return c.json({ recovery_code: code, created_at });
});

// ── Begin: mail a magic link (never reveals whether the email exists) ──

app.post('/recover/begin', async (c) => {
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = RecoverBeginSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  const store = getStore(c);
  const owner = await store.getOwnerByEmail(parsed.data.email);
  if (owner) {
    const token = base64urlEncode(randomBytes(32));
    await store.createRecoveryToken(owner.id, sha256hex(token), TOKEN_TTL_SECONDS);
    const link = `${consoleOrigin(c.env)}/recover#t=${token}`;
    await getEmailSender(c).send({
      to: parsed.data.email,
      subject: 'BasedAgents account recovery',
      text:
        `A recovery of your BasedAgents owner account was requested.\n\n` +
        `Open this link within 15 minutes and enter your recovery code:\n\n${link}\n\n` +
        `Completing recovery enrolls a NEW passkey and signs out every other ` +
        `passkey and session. If you did not request this, you can ignore this ` +
        `email — the link alone cannot change anything without your recovery code.`,
    });
  }
  // Uniform response — no account enumeration via this endpoint.
  return c.json({ ok: true });
});

// ── Options: both factors check out → arm a registration challenge ──

app.post('/recover/options', async (c) => {
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = RecoverOptionsSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  const store = getStore(c);
  // Validate WITHOUT consuming: a cancelled passkey prompt must not strand the
  // user. /recover/finish is the atomic point of no return.
  const live = await store.getLiveRecoveryToken(sha256hex(parsed.data.token));
  if (!live) return err(c, 401, 'unauthorized', 'invalid or expired recovery link');
  const codeOk = await store.peekRecoveryCode(
    live.owner_id,
    sha256hex(normalizeRecoveryCode(parsed.data.recovery_code)),
  );
  if (!codeOk) return err(c, 401, 'unauthorized', 'invalid or expired recovery link');

  const { challenge } = await store.createChallenge({
    ownerId: live.owner_id,
    purpose: 'recovery',
    ttlSeconds: CHALLENGE_TTL_SECONDS,
  });
  const owner = await store.getOwner(live.owner_id);
  const { rpId, rpName } = rpConfig(c.env);
  const name = owner?.email || live.owner_id;

  return c.json({
    owner_id: live.owner_id,
    options: {
      rp: { id: rpId, name: rpName },
      user: { id: base64urlEncode(textEncoder.encode(live.owner_id)), name, displayName: name },
      challenge,
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      attestation: 'none',
      // No excludeCredentials: the old passkeys are being rotated OUT — a lost
      // authenticator obviously cannot be excluded, and re-registering a still-
      // held one under rotation is legitimate.
      timeout: 60_000,
    },
  });
});

// ── Finish: verify the new passkey, consume both factors, rotate ──

app.post('/recover/finish', async (c) => {
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = RecoverFinishSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  const store = getStore(c);
  const tokenHash = sha256hex(parsed.data.token);
  const codeHash = sha256hex(normalizeRecoveryCode(parsed.data.recovery_code));

  // Re-check the factors (uniform 401 — no oracle for which one failed).
  const live = await store.getLiveRecoveryToken(tokenHash);
  if (!live) return err(c, 401, 'unauthorized', 'recovery verification failed');
  const ownerId = live.owner_id;

  const challenge = extractChallenge(parsed.data.clientDataJSON);
  if (!challenge) return err(c, 400, 'bad_request', 'invalid clientDataJSON');

  // 1. Consume the single-use challenge FIRST (atomic; replay loses the race).
  const consumed = await store.consumeChallenge(challenge, 'recovery', nowIso());
  if (!consumed) return err(c, 401, 'unauthorized', 'unknown or replayed challenge');

  // 2. Verify the registration (throws → 401; the factors are still intact —
  //    a fresh /recover/options re-arms and the user retries).
  const { rpId, origins } = rpConfig(c.env);
  let reg;
  try {
    reg = await verifyRegistration({
      attestationObject: parsed.data.attestationObject,
      clientDataJSON: parsed.data.clientDataJSON,
      expectedChallenge: challenge,
      expectedOrigin: origins,
      expectedRPID: rpId,
    });
  } catch {
    return err(c, 401, 'unauthorized', 'registration verification failed');
  }

  // 3. Point of no return: consume BOTH factors atomically. Code first (it is
  //    owner-scoped), then the token; either failing means a concurrent
  //    recovery won the race — stop with nothing further changed.
  const now = nowIso();
  if (!(await store.consumeRecoveryCode(ownerId, codeHash, now))) {
    return err(c, 401, 'unauthorized', 'recovery verification failed');
  }
  if (!(await store.consumeRecoveryToken(tokenHash, now))) {
    return err(c, 401, 'unauthorized', 'recovery verification failed');
  }

  // 4. Enroll the new passkey.
  let cred;
  try {
    cred = await store.addCredential({
      ownerId,
      credentialId: reg.credentialId,
      publicKey: reg.cosePublicKey,
      counter: reg.counter,
      aaguid: reg.aaguid,
      backedUp: reg.backedUp,
      transports: parsed.data.transports ?? reg.transports,
    });
  } catch {
    return err(c, 409, 'conflict', 'credential already registered');
  }

  // 5. Rotate: every other passkey and every live session dies.
  const revokedPasskeys = await store.revokeOtherCredentials(ownerId, cred.id, now);
  await store.revokeAllSessionsForOwner(ownerId, now);

  return c.json({
    owner_id: ownerId,
    credential_id: reg.credentialId,
    revoked_passkeys: revokedPasskeys,
    // The daemon's anchored passkeys are now stale by design — surface the fix.
    next_step: 'Sign in with the new passkey, then run `based link` to re-anchor it on your machine.',
  });
});

export default app;
