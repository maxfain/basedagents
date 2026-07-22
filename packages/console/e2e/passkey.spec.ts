/**
 * Onboarding-ladder E2E (coder brief v0.2) — real Chromium + CDP virtual
 * authenticator against the real control plane and the real console.
 *
 * The five scenarios the brief requires, each self-contained with its own
 * vault + agent (the shared API/database persists across tests within a run):
 *   1. claim      — `init`-created link code + /link email + magic link →
 *                   account exists, agent connected, session is LOOK-ONLY
 *                   (email rung, no passkey, approvals arm no usable challenge)
 *   2. login      — both rungs: magic link mints a look session (method
 *                   email); the passkey mints the full rung (method passkey)
 *   3. first act  — the FIRST approval mints the passkey (creation ceremony
 *                   fires exactly once) and the stored grant assertion
 *                   VERIFIES (crypto, not UI state) against the NEWLY stored
 *                   key via @basedagents/keyring's verifyOwnerAssertion — the
 *                   daemon's own verification path; the second approval is a
 *                   signature only
 *   4. recovery   — magic link + recovery code → new passkey; old one no
 *                   longer authenticates; the agent connection survives
 *   5. negative   — aborted CREATION ceremony → no passkey stored, request
 *                   stays pending; the retry succeeds
 */
import { test, expect } from '@playwright/test';
import type { Page, CDPSession } from '@playwright/test';
import * as ed from '@noble/ed25519';
import {
  generateKeypair,
  base58Encode,
  publicKeyToAgentId,
  sha256Hex,
  verifyOwnerAssertion,
} from '@basedagents/keyring';
import type { AgentKeypair } from '@basedagents/keyring';

const API = 'http://localhost:3000';
const CONSOLE_ORIGIN = 'http://localhost:5174';

/** CDP reports credential ids as standard base64; the API stores base64url. */
function b64url(s: string): string {
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── virtual authenticator plumbing ───

interface Authenticator {
  cdp: CDPSession;
  id: string;
  /** base64url credential ids created on this authenticator. */
  added: string[];
  /** how many get() assertions this page has produced. */
  asserted: () => number;
}

async function addAuthenticator(page: Page): Promise<Authenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const added: string[] = [];
  let assertedCount = 0;
  cdp.on('WebAuthn.credentialAdded', (e: { credential: { credentialId: string } }) => {
    added.push(e.credential.credentialId);
  });
  cdp.on('WebAuthn.credentialAsserted', () => {
    assertedCount++;
  });
  return { cdp, id: authenticatorId, added, asserted: () => assertedCount };
}

// ─── API helpers ───

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, init);
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await api(path, init);
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function sessionCookie(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const c = cookies.find((x) => x.name === 'ba_owner_session');
  if (!c) throw new Error('no session cookie in context');
  return `ba_owner_session=${c.value}`;
}

/** The daemon's AgentSig auth — sign as the owner's Ed25519 vault key. */
async function daemonGet<T>(keypair: AgentKeypair, path: string): Promise<T> {
  const ts = Math.floor(Date.now() / 1000);
  const bodyHash = sha256Hex(new TextEncoder().encode(''));
  const message = `GET:${path}:${ts}:${bodyHash}`;
  const sig = await ed.signAsync(new TextEncoder().encode(message), keypair.privateKey);
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return apiJson<T>(path, {
    headers: {
      Authorization: `AgentSig ${base58Encode(keypair.publicKey)}:${btoa(bin)}`,
      'X-Timestamp': String(ts),
    },
  });
}

/** Read the newest magic-link token for `email` whose URL path matches. */
async function magicToken(email: string, pathname: '/claim' | '/login' | '/recover' | '/start'): Promise<string> {
  const { messages } = await apiJson<{ messages: Array<{ body: string }> }>(
    `/v1/owner/test/outbox?recipient=${encodeURIComponent(email)}`,
  );
  for (const m of messages) {
    // newest first — the first match IS the latest token
    const hit = new RegExp(`${pathname}#t=([A-Za-z0-9_-]+)`).exec(m.body);
    if (hit) return hit[1];
  }
  throw new Error(`no ${pathname} magic link in the outbox for ${email}`);
}

// ─── the ladder's terminal side, simulated: what `keyring init` POSTs ───

let counter = 0;

interface InitResult {
  vault: AgentKeypair;
  agent: AgentKeypair;
  agentId: string;
  agentName: string;
  code: string;
  email: string;
  /** Masked address when a start code was forwarded (`e•••@example.com`). */
  emailHint?: string;
}

async function initLink(startCode?: string): Promise<InitResult> {
  const vault = await generateKeypair();
  const agent = await generateKeypair();
  const agentId = publicKeyToAgentId(agent.publicKey);
  const agentName = `Claude Code @ e2e-${Date.now()}-${++counter}`;
  const vaultB58 = base58Encode(vault.publicKey);
  const agentB58 = base58Encode(agent.publicKey);
  // /link now requires a vault-key signature (proof of possession).
  const canonical = `keyring-link:v1:${vaultB58}:${agentId}:${agentB58}`;
  const sig = await ed.signAsync(new TextEncoder().encode(canonical), vault.privateKey);
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  const { code, email_hint } = await apiJson<{ code: string; email_hint?: string }>('/v1/owner/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vault_public_key: vaultB58,
      agent_id: agentId,
      agent_public_key: agentB58,
      agent_name: agentName,
      vault_signature: btoa(bin),
      ...(startCode ? { start_code: startCode } : {}),
    }),
  });
  return {
    vault, agent, agentId, agentName, code,
    email: `e2e-${Date.now()}-${counter}@example.com`,
    emailHint: email_hint,
  };
}

// ─── UI flows ───

/** /link?code= → one email field → magic link from the outbox → /welcome. */
async function claim(page: Page, init: InitResult): Promise<void> {
  await page.goto(`/link?code=${init.code}`);
  await expect(page.getByRole('heading', { name: 'Take control of this agent' })).toBeVisible();
  await expect(page.getByText(init.agentName)).toBeVisible();
  await page.getByLabel('Email').fill(init.email);
  await page.getByRole('button', { name: 'Send me the link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  const token = await magicToken(init.email, '/claim');
  await page.goto(`/claim#t=${token}`);
  await expect(page).toHaveURL(/\/welcome/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: `${init.agentName} is yours` })).toBeVisible();
}

/** File a request as the connected agent would (session-scoped E2E shortcut). */
async function fileRequest(page: Page, agentId: string, credentialId: string, label: string): Promise<string> {
  const res = await apiJson<{ id: string }>('/v1/owner/requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: await sessionCookie(page) },
    body: JSON.stringify({
      agent_id: agentId,
      credential_id: credentialId,
      credential_label: label,
      provider: 'stripe',
    }),
  });
  return res.id;
}

/** Click the novice home's Allow on the (single) pending ask and wait for it to land. */
async function allowOnHome(page: Page): Promise<void> {
  await page.goto('/home');
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.locator('.asking')).toHaveCount(0, { timeout: 20_000 });
}

interface Me {
  owner_id: string;
  session_method: string;
  has_passkey: boolean;
  delegations: Array<{ agent_id: string; status: string }>;
}

async function me(page: Page): Promise<Me> {
  return apiJson<Me>('/v1/owner/me', { headers: { Cookie: await sessionCookie(page) } });
}

// ─────────────────────────────────────────────────────────────────────────────

test('1. claim: link code + email + magic link → account + agent, look-only session, approvals locked', async ({ page }) => {
  const init = await initLink();
  const auth = await addAuthenticator(page);
  await claim(page, init);

  // No passkey ceremony happened anywhere in the claim.
  expect(auth.added).toHaveLength(0);
  expect(auth.asserted()).toBe(0);

  // The ratified facts: account id derived from the vault key, email rung,
  // no passkey yet, the agent connected.
  const session = await me(page);
  expect(session.owner_id).toBe(`ow_${base58Encode(init.vault.publicKey)}`);
  expect(session.session_method).toBe('email');
  expect(session.has_passkey).toBe(false);
  expect(session.delegations).toHaveLength(1);
  expect(session.delegations[0]).toMatchObject({ agent_id: init.agentId, status: 'active' });

  // The novice home shows the agent and explains the coming first-approval mint.
  await page.goto('/home');
  await expect(page.getByText(init.agentName)).toBeVisible();
  await expect(page.getByText(/first time you allow something/)).toBeVisible();

  // "Sessions to look, signatures to act": with no passkey there is nothing
  // that can sign — the armed approval offers NO usable credential.
  const requestId = await fileRequest(page, init.agentId, 'cred_locked_e2e', 'Stripe key (locked)');
  const begin = await apiJson<{ allowCredentials: Array<unknown> }>(
    `/v1/owner/requests/${requestId}/approve/begin`,
    { method: 'POST', headers: { Cookie: await sessionCookie(page) } },
  );
  expect(begin.allowCredentials).toHaveLength(0);
});

test('2. login, both rungs: magic link → look session (email); passkey → full rung', async ({ page }) => {
  const init = await initLink();
  await addAuthenticator(page);
  await claim(page, init);

  // Setup: mint the passkey with a first approval so the second rung exists.
  await fileRequest(page, init.agentId, 'cred_login_e2e', 'Stripe key (login)');
  await allowOnHome(page);
  expect((await me(page)).has_passkey).toBe(true);

  // Fresh browser state — the console is gated again.
  await page.context().clearCookies();
  await page.goto('/home');
  await expect(page).toHaveURL(/\/login/);

  // Rung 1 — email magic link. Uniform "check your email", token from outbox.
  await page.getByLabel('Email').fill(init.email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const token = await magicToken(init.email, '/login');
  await page.goto('/signup'); // leave /login: #t= alone would be a fragment-only (no-reload) navigation
  await page.goto(`/login#t=${token}`);
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
  expect((await me(page)).session_method).toBe('email');

  // Rung 2 — the passkey. Fresh cookies again; the resident credential signs.
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('Email').fill(init.email);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
  expect((await me(page)).session_method).toBe('passkey');
});

test('3. first approval mints the passkey; the stored assertion verifies against the newly stored key; second approval is signature-only', async ({ page }) => {
  const init = await initLink();
  const auth = await addAuthenticator(page);
  await claim(page, init);

  await fileRequest(page, init.agentId, 'cred_stripe_e2e', 'Stripe key (e2e)');

  // FIRST approval: the creation ceremony fires (once), then the assertion.
  await allowOnHome(page);
  expect(auth.added).toHaveLength(1);
  expect(auth.asserted()).toBe(1);
  await expect(page.locator('.chip', { hasText: 'Can use: Stripe key (e2e)' })).toBeVisible();

  const session = await me(page);
  expect(session.has_passkey).toBe(true);
  expect(session.session_method).toBe('email'); // still the email rung — the passkey signs acts, not looks

  // THE assertion that matters: pull the queued approval over the daemon's
  // authenticated channel (the claim bound the vault key) and run the
  // daemon's own verification — the stored signature must verify against the
  // JUST-MINTED passkey public key over exactly the approved action's hash.
  const { passkeys } = await daemonGet<{ passkeys: Array<{ public_key_hex: string; credential_id: string }> }>(
    init.vault, '/v1/owner/daemon/passkeys',
  );
  expect(passkeys).toHaveLength(1);
  expect(b64url(passkeys[0].credential_id)).toBe(b64url(auth.added[0])); // the newly stored key IS the minted one

  const { approvals } = await daemonGet<{
    approvals: Array<{
      action_hash: string;
      agent_pubkey: string;
      credential_id: string;
      assertion: { credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string };
    }>;
  }>(init.vault, '/v1/owner/daemon/approvals');
  expect(approvals).toHaveLength(1);
  const approval = approvals[0];
  expect(approval.agent_pubkey).toBe(base58Encode(init.agent.publicKey)); // pinned seal target
  expect(approval.credential_id).toBe('cred_stripe_e2e');

  const verify = (signature: string) =>
    verifyOwnerAssertion({
      publicKeyHex: passkeys[0].public_key_hex,
      authenticatorData: approval.assertion.authenticatorData,
      clientDataJSON: approval.assertion.clientDataJSON,
      signature,
      expectedChallenge: approval.action_hash,
      expectedOrigins: [CONSOLE_ORIGIN],
      expectedRPID: 'localhost',
    });
  expect(() => verify(approval.assertion.signature)).not.toThrow();

  // Negative control — the check is not vacuous: a tampered signature fails.
  const tampered =
    approval.assertion.signature.slice(0, -2) +
    (approval.assertion.signature.endsWith('AA') ? 'BB' : 'AA');
  expect(() => verify(tampered)).toThrow();

  // SECOND approval: signature only — no new credential is created.
  await fileRequest(page, init.agentId, 'cred_second_e2e', 'Stripe key (second)');
  await allowOnHome(page);
  expect(auth.added).toHaveLength(1); // unchanged
  expect(auth.asserted()).toBe(2);
});

test('4. recovery: magic link + code → new passkey; old passkey dead, agent connection intact', async ({ page }) => {
  const init = await initLink();
  const oldAuth = await addAuthenticator(page);
  await claim(page, init);

  // Mint the passkey (recovery-code generation is itself a signed act).
  await fileRequest(page, init.agentId, 'cred_recovery_e2e', 'Stripe key (recovery)');
  await allowOnHome(page);
  const oldCredentialId = oldAuth.added[0];

  // Generate the recovery code (a passkey action) and capture the one-time display.
  await page.goto('/vault');
  await page.getByRole('button', { name: 'Generate recovery code' }).click();
  const code = (await page.locator('.code-block-select').textContent({ timeout: 20_000 }))!.trim();
  expect(code).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{8}){3}$/);
  const oldSession = await sessionCookie(page);

  // Request the magic link and read it from the E2E outbox (never Resend).
  await page.goto('/recover');
  await page.getByLabel(/Email/).fill(init.email);
  await page.getByRole('button', { name: 'Email me a recovery link' }).click();
  await expect(page.getByText(/recovery link is on its way/)).toBeVisible();
  const token = await magicToken(init.email, '/recover');

  // The lost-device story: the old authenticator is gone; a NEW one enrolls.
  await oldAuth.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: oldAuth.id });
  const newAuth = await addAuthenticator(page);

  // Leave /recover first: navigating /recover → /recover#t=… is a FRAGMENT
  // navigation (no reload), and the page reads the token once at mount.
  await page.goto('/login');
  await page.goto(`/recover#t=${token}`);
  await page.getByLabel(/Recovery code/).fill(code);
  await page.getByRole('button', { name: 'Enroll new passkey' }).click();
  await expect(page.getByText(/New passkey enrolled/)).toBeVisible({ timeout: 20_000 });
  expect(newAuth.added).toHaveLength(1);

  // The pre-recovery session is revoked…
  const deadSession = await api('/v1/owner/me', { headers: { Cookie: oldSession } });
  expect(deadSession.status).toBe(401);

  // …the old credential no longer authenticates (not offered at login)…
  const loginBegin = await apiJson<{ allowCredentials: Array<{ id: string }> }>(
    '/v1/owner/login/begin',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: init.email }) },
  );
  expect(loginBegin.allowCredentials).toHaveLength(1);
  expect(b64url(loginBegin.allowCredentials[0].id)).not.toBe(b64url(oldCredentialId));

  // …the new passkey signs in, and the agent connection survived the rotation.
  await page.goto('/login');
  await page.getByLabel('Email').fill(init.email);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
  await expect(page.getByText(init.agentName)).toBeVisible();
  expect((await me(page)).delegations[0]).toMatchObject({ agent_id: init.agentId, status: 'active' });
});

test('5. negative: aborted creation ceremony → no passkey, request stays pending; retry succeeds', async ({ page }) => {
  const init = await initLink();
  const auth = await addAuthenticator(page);
  await claim(page, init);
  await fileRequest(page, init.agentId, 'cred_abort_e2e', 'Stripe key (abort)');

  await page.goto('/home');
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();

  // Abort the CREATION ceremony mid-flight: stop auto-presence so create()
  // hangs waiting for a touch that never comes, then reload — the pending
  // WebAuthn request dies with the document (the user closing the sheet).
  await auth.cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
    authenticatorId: auth.id,
    enabled: false,
  });
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Waiting…' })).toBeVisible();
  await page.reload();

  // Nothing was minted and nothing moved: no credential, no assertion, the
  // account still has no passkey, and the ask is still pending.
  expect(auth.added).toHaveLength(0);
  expect(auth.asserted()).toBe(0);
  const session = await me(page);
  expect(session.has_passkey).toBe(false);
  const { requests } = await apiJson<{ requests: Array<{ status: string }> }>(
    '/v1/owner/requests?status=pending',
    { headers: { Cookie: await sessionCookie(page) } },
  );
  expect(requests).toHaveLength(1);
  expect(requests[0].status).toBe('pending');

  // The flow recovers: presence back on, the same Allow mints and signs.
  await auth.cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
    authenticatorId: auth.id,
    enabled: true,
  });
  await allowOnHome(page);
  expect(auth.added).toHaveLength(1);
  expect((await me(page)).has_passkey).toBe(true);
});

test('6. /start browser door: returning account signs in with one email field; a new email gets the agent command', async ({ page }) => {
  // A claimed account exists (browser-only human returning later).
  const init = await initLink();
  await addAuthenticator(page);
  await claim(page, init);
  await page.context().clearCookies();

  // The web "Get started" door — one email field, no password.
  await page.goto('/start');
  await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible();
  await page.getByRole('tab', { name: 'Start in your browser' }).click();
  await page.getByLabel('Email').fill(init.email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  const token = await magicToken(init.email, '/start');
  await page.goto('/login');                 // leave /start so #t= is a real load
  await page.goto(`/start#t=${token}`);
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
  await expect(page.getByText(init.agentName)).toBeVisible();
  expect((await me(page)).session_method).toBe('email');

  // A brand-new email gets NO session — just the paste-to-your-agent command.
  await page.context().clearCookies();
  await page.goto('/start');
  await page.getByRole('tab', { name: 'Start in your browser' }).click();
  const fresh = `e2e-fresh-${Date.now()}@example.com`;
  await page.getByLabel('Email').fill(fresh);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  const freshToken = await magicToken(fresh, '/start');
  await page.goto('/login');
  await page.goto(`/start#t=${freshToken}`);
  await expect(page.getByRole('heading', { name: /one step to finish/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Paste this to your agent:')).toBeVisible();
  await expect(page).toHaveURL(/\/start/); // no session, no redirect to /home
});

test('7. the start code: the browser-door email rides the prompt into /link — one click, the magic link still ratifies', async ({ page }) => {
  // A brand-new human starts in the browser. The email they verify there must
  // survive into the claim without ever being re-typed.
  const email = `e2e-start-${Date.now()}@example.com`;
  await page.goto('/start');
  await page.getByRole('tab', { name: 'Start in your browser' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  const token = await magicToken(email, '/start');
  await page.goto('/login');
  await page.goto(`/start#t=${token}`);
  await expect(page.getByRole('heading', { name: /one step to finish/ })).toBeVisible({ timeout: 20_000 });

  // The rendered prompt carries the start code — that IS the hand-off.
  const prompt = await page.locator('.agent-setup .code-block').first().textContent();
  const startCode = /--start (st_[A-Za-z0-9]+)/.exec(prompt ?? '')?.[1];
  expect(startCode).toBeTruthy();

  // `init --start <code>` → the link code comes back pre-addressed (masked).
  const init = await initLink(startCode);
  expect(init.emailHint).toBe(`${email[0]}•••@example.com`);

  // /link is one click: masked address on show, no email field, and the full
  // address is never rendered.
  await page.goto(`/link?code=${init.code}`);
  await expect(page.getByRole('heading', { name: 'Take control of this agent' })).toBeVisible();
  await expect(page.getByText(init.emailHint!)).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveCount(0);
  await expect(page.getByText(email)).toHaveCount(0);
  await page.getByRole('button', { name: 'Send me the link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  // The magic-link click is still the ratifying moment; the account comes out
  // carrying the door email, look-only session, id derived from the vault key.
  const claimToken = await magicToken(email, '/claim');
  await page.goto(`/claim#t=${claimToken}`);
  await expect(page).toHaveURL(/\/welcome/, { timeout: 20_000 });
  const session = await me(page);
  expect(session.owner_id).toBe(`ow_${base58Encode(init.vault.publicKey)}`);
  expect(session.session_method).toBe('email');
  expect(session.has_passkey).toBe(false);
});
