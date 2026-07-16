/**
 * Passkey E2E (coder brief Task 2) — real Chromium + CDP virtual
 * authenticator against the real control plane and the real console.
 *
 * The five scenarios the brief requires, each self-contained with its own
 * owner (the shared API/database persists across tests within a run):
 *   1. signup       — email + passkey ceremony → owner + credential stored
 *   2. login        — fresh cookies, existing resident credential → session
 *   3. step-up      — approval fires a SECOND ceremony whose stored assertion
 *                     VERIFIES (crypto, not UI state) against the owner's
 *                     stored passkey public key over the exact action hash —
 *                     checked with @basedagents/keyring's verifyOwnerAssertion,
 *                     i.e. the daemon's own verification path
 *   4. recovery     — magic link (from the test outbox) + recovery code →
 *                     new passkey; old one no longer authenticates; the
 *                     delegation survives
 *   5. negative     — aborted ceremony → no approval created, request stays
 *                     pending
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

// ─── owners / API helpers ───

let ownerCounter = 0;
function newOwner(): { keypair: Promise<AgentKeypair>; email: string } {
  return { keypair: generateKeypair(), email: `e2e-${Date.now()}-${++ownerCounter}@example.com` };
}

async function sessionCookie(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const c = cookies.find((x) => x.name === 'ba_owner_session');
  if (!c) throw new Error('no session cookie in context');
  return `ba_owner_session=${c.value}`;
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, init);
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await api(path, init);
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
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

async function seedAgent(): Promise<{ agentId: string; publicKeyB58: string }> {
  const kp = await generateKeypair();
  const agentId = publicKeyToAgentId(kp.publicKey);
  await apiJson('/v1/owner/test/seed-agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, public_key_b58: base58Encode(kp.publicKey) }),
  });
  return { agentId, publicKeyB58: base58Encode(kp.publicKey) };
}

// ─── UI flows ───

async function signup(page: Page, vaultB58: string, email: string): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel(/Vault public key/).fill(vaultB58);
  await page.getByLabel(/Email/).fill(email);
  await page.getByRole('button', { name: 'Create account + passkey' }).click();
  await expect(page).toHaveURL(/\/approvals/, { timeout: 20_000 });
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/Email/).fill(email);
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(page).toHaveURL(/\/approvals/, { timeout: 20_000 });
}

async function delegateAgent(page: Page, agentId: string): Promise<void> {
  await page.goto('/agents');
  await page.getByLabel(/Agent ID/).fill(agentId);
  await page.getByRole('button', { name: 'Delegate with passkey' }).click();
  await expect(page.locator('.rows .row').first()).toContainText('active', { timeout: 20_000 });
}

async function bindVault(page: Page): Promise<void> {
  await page.goto('/vault');
  await page.getByRole('button', { name: 'Bind vault key with passkey' }).click();
  await expect(page.locator('.panel').first()).toContainText('bound', { timeout: 20_000 });
}

async function fileRequest(page: Page, agentId: string, credentialId: string): Promise<string> {
  const res = await apiJson<{ id: string }>('/v1/owner/requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: await sessionCookie(page) },
    body: JSON.stringify({
      agent_id: agentId,
      credential_id: credentialId,
      credential_label: 'Stripe key (e2e)',
      provider: 'stripe',
    }),
  });
  return res.id;
}

// ─────────────────────────────────────────────────────────────────────────────

test('1. signup: email + passkey → owner created, credential stored, lands on empty Home', async ({ page }) => {
  const owner = newOwner();
  const keypair = await owner.keypair;
  const auth = await addAuthenticator(page);

  await signup(page, base58Encode(keypair.publicKey), owner.email);
  await expect(page.getByText('No pending requests.')).toBeVisible();
  expect(auth.added).toHaveLength(1); // exactly one credential created

  // The owner exists under the id derived from the vault key, with the
  // passkey's public key on file.
  const me = await apiJson<{ owner_id: string; credentials: Array<{ credential_id: string }> }>(
    '/v1/owner/me',
    { headers: { Cookie: await sessionCookie(page) } },
  );
  expect(me.owner_id).toBe(`ow_${base58Encode(keypair.publicKey)}`);
  expect(me.credentials).toHaveLength(1);
  expect(b64url(me.credentials[0].credential_id)).toBe(b64url(auth.added[0]));
});

test('2. login: fresh cookies, existing credential → session established', async ({ page }) => {
  const owner = newOwner();
  const keypair = await owner.keypair;
  await addAuthenticator(page);
  await signup(page, base58Encode(keypair.publicKey), owner.email);

  // Drop the session; the resident credential stays on the authenticator.
  await page.context().clearCookies();
  await page.goto('/approvals');
  await expect(page).toHaveURL(/\/login/); // gated

  await login(page, owner.email);
  await expect(page.getByText('No pending requests.')).toBeVisible();
});

test('3. step-up on approval: a second ceremony, and the stored assertion VERIFIES against the stored passkey', async ({ page }) => {
  const owner = newOwner();
  const keypair = await owner.keypair;
  const auth = await addAuthenticator(page);
  await signup(page, base58Encode(keypair.publicKey), owner.email);

  // Vault binding (daemon auth) + a delegated agent + a pending request.
  await bindVault(page);
  const agent = await seedAgent();
  await delegateAgent(page, agent.agentId);
  await fileRequest(page, agent.agentId, 'cred_stripe_e2e');

  const assertionsBeforeApprove = auth.asserted();

  await page.goto('/approvals');
  await page.getByRole('button', { name: 'Approve with passkey' }).click();
  await expect(page.locator('.decided')).toContainText('approved', { timeout: 20_000 });

  // A DISTINCT ceremony fired for the approval (beyond session auth).
  expect(auth.asserted()).toBe(assertionsBeforeApprove + 1);

  // THE assertion that matters: pull the queued approval over the daemon's
  // authenticated channel and run the daemon's own verification — the stored
  // signature must verify against the owner's stored passkey public key over
  // exactly the approved action's hash.
  const { passkeys } = await daemonGet<{ passkeys: Array<{ public_key_hex: string }> }>(
    keypair, '/v1/owner/daemon/passkeys',
  );
  expect(passkeys).toHaveLength(1);
  const { approvals } = await daemonGet<{
    approvals: Array<{
      action_hash: string;
      agent_pubkey: string;
      credential_id: string;
      assertion: { credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string };
    }>;
  }>(keypair, '/v1/owner/daemon/approvals');
  expect(approvals).toHaveLength(1);
  const approval = approvals[0];
  expect(approval.agent_pubkey).toBe(agent.publicKeyB58); // pinned seal target
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
});

test('4. recovery: magic link + code → new passkey; old passkey dead, delegation intact', async ({ page }) => {
  const owner = newOwner();
  const keypair = await owner.keypair;
  const oldAuth = await addAuthenticator(page);
  await signup(page, base58Encode(keypair.publicKey), owner.email);
  const oldCredentialId = oldAuth.added[0];

  // A delegation that must SURVIVE the rotation.
  const agent = await seedAgent();
  await delegateAgent(page, agent.agentId);

  // Generate the recovery code (a passkey action) and capture the one-time display.
  await page.goto('/vault');
  await page.getByRole('button', { name: 'Generate recovery code' }).click();
  const code = (await page.locator('.code-block-select').textContent({ timeout: 20_000 }))!.trim();
  expect(code).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{8}){3}$/);
  const oldSession = await sessionCookie(page);

  // Request the magic link and read it from the E2E outbox (never Resend).
  await page.goto('/recover');
  await page.getByLabel(/Email/).fill(owner.email);
  await page.getByRole('button', { name: 'Email me a recovery link' }).click();
  await expect(page.getByText(/recovery link is on its way/)).toBeVisible();
  const outbox = await apiJson<{ messages: Array<{ body: string }> }>(
    `/v1/owner/test/outbox?recipient=${encodeURIComponent(owner.email)}`,
  );
  expect(outbox.messages.length).toBeGreaterThan(0);
  const token = /#t=([A-Za-z0-9_-]+)/.exec(outbox.messages[0].body)![1];

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
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: owner.email }) },
  );
  expect(loginBegin.allowCredentials).toHaveLength(1);
  expect(b64url(loginBegin.allowCredentials[0].id)).not.toBe(b64url(oldCredentialId));

  // …the new passkey signs in, and the delegation survived the rotation.
  await login(page, owner.email);
  await page.goto('/agents');
  await expect(page.locator('.rows .row').first()).toContainText('active');
});

test('5. negative: aborted ceremony → no approval created, request stays pending', async ({ page }) => {
  const owner = newOwner();
  const keypair = await owner.keypair;
  const auth = await addAuthenticator(page);
  await signup(page, base58Encode(keypair.publicKey), owner.email);
  const agent = await seedAgent();
  await delegateAgent(page, agent.agentId);
  await fileRequest(page, agent.agentId, 'cred_abort_e2e');
  const cookie = await sessionCookie(page);

  await page.goto('/approvals');
  await expect(page.getByRole('button', { name: 'Approve with passkey' })).toBeVisible();

  // Abort the ceremony mid-flight: stop auto-presence so the get() request
  // hangs waiting for a touch that never comes, then navigate away — the
  // pending WebAuthn request dies with the document (the user closing the
  // browser sheet). Chrome keeps a pending request alive even if the
  // authenticator is removed, so navigation is the deterministic abort.
  const assertionsBefore = auth.asserted();
  await auth.cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
    authenticatorId: auth.id,
    enabled: false,
  });
  await page.getByRole('button', { name: 'Approve with passkey' }).click();
  await expect(page.getByRole('button', { name: 'Waiting for passkey…' })).toBeVisible();
  await page.reload();

  // Nothing was signed and nothing was stored: no assertion happened, the
  // request is still pending, and the decided list is empty.
  expect(auth.asserted()).toBe(assertionsBefore);
  const { requests } = await apiJson<{ requests: Array<{ status: string }> }>(
    '/v1/owner/requests?status=pending',
    { headers: { Cookie: cookie } },
  );
  expect(requests).toHaveLength(1);
  expect(requests[0].status).toBe('pending');
  await expect(page.getByRole('button', { name: 'Approve with passkey' })).toBeVisible(); // still approvable
  await expect(page.locator('.decided')).toHaveCount(0);
});
