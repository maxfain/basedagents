/**
 * Provisioner v1 tests — engine invariants, guardrails, API client, and the
 * canary: no secret value ever escapes into transcripts, events, or hook lines.
 * The browser is a FakeDriver; the API is a mocked fetch — everything the spec
 * calls non-negotiable is asserted here without a display.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Keyring, KeyringError } from '../keyring.js';
import { generateKeypair } from '../crypto.js';
import { publicKeyToAgentId } from '../util.js';
import { hostAllowed, runRecipe } from './engine.js';
import { vercelBootstrapRecipe } from './recipes/vercel.js';
import { VercelApi, VercelApiError } from './vercel-api.js';
import { connectVercel, burnVercelTokensForAgent, PROV_LABEL } from './connect.js';
import { SupabaseApi, SupabaseApiError } from './supabase-api.js';
import { connectSupabase, burnSupabaseKeysForAgent, SUPABASE_PROV_LABEL } from './connect-supabase.js';
import type { Driver, EngineHooks, Recipe, RecipeLocator } from './types.js';

const SECRET = 'CANARY_vercel_token_9f3e2a71bc84d605_DO_NOT_LEAK';
const SBP = 'sbp_CANARY_9f3e2a71bc84d605_DO_NOT_LEAK';

const tempDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provisioner-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ── Fake driver ──────────────────────────────────────────────────────────────

interface FakeOpts {
  /** Locator descriptions that DON'T resolve (simulating drift). */
  missing?: string[];
  /** What read() returns for the capture locator. */
  captureValue?: string;
  /** URL the page "lands on" after the given step's action. */
  hijackAfter?: { description: string; url: string };
  loggedIn?: boolean;
  /** Initial clipboard contents (e.g. a human's earlier Copy); absent = clipboard unavailable. */
  clipboardValue?: string;
  /** What an ENGINE click on the Copy button puts in the clipboard. */
  copyProduces?: string;
}

class FakeDriver implements Driver {
  url = 'about:blank';
  log: string[] = [];
  closed = false;
  private clipboard: string | undefined;
  constructor(private opts: FakeOpts) { this.clipboard = opts.clipboardValue; }
  private resolves(l: RecipeLocator): boolean {
    if ((this.opts.missing ?? []).includes(l.description)) return false;
    if (l.description.includes('Create button on the Tokens page')) return this.opts.loggedIn !== false;
    if (l.description.includes('Generate new token button on the Access Tokens page')) return this.opts.loggedIn !== false;
    return true;
  }
  async goto(url: string): Promise<void> { this.url = url; this.log.push(`goto ${url}`); }
  async currentUrl(): Promise<string> { return this.url; }
  async exists(l: RecipeLocator): Promise<boolean> { return this.resolves(l); }
  async click(l: RecipeLocator): Promise<void> {
    if (!this.resolves(l)) throw new Error(`not found: ${l.description}`);
    this.log.push(`click ${l.description}`);
    if (l.description.includes('Copy button') && this.opts.copyProduces != null) {
      this.clipboard = this.opts.copyProduces;
    }
    const h = this.opts.hijackAfter;
    if (h && l.description === h.description) this.url = h.url;
  }
  async fill(l: RecipeLocator, value: string): Promise<void> {
    if (!this.resolves(l)) throw new Error(`not found: ${l.description}`);
    this.log.push(`fill ${l.description}=${value}`);
  }
  async selectOption(l: RecipeLocator, label: string): Promise<void> {
    if (!this.resolves(l)) throw new Error(`not found: ${l.description}`);
    this.log.push(`select ${l.description}=${label}`);
  }
  async readClipboard(): Promise<string> {
    if (this.clipboard == null) throw new Error('clipboard unavailable');
    this.log.push('read clipboard');
    return this.clipboard;
  }
  async writeClipboard(text: string): Promise<void> {
    this.clipboard = text;
    this.log.push('write clipboard');
  }
  async read(l: RecipeLocator): Promise<string> {
    if (!this.resolves(l)) throw new Error(`not found: ${l.description}`);
    return this.opts.captureValue ?? '';
  }
  async close(): Promise<void> { this.closed = true; }
}

function autoHooks(record?: string[]): EngineHooks {
  return {
    consent: async () => true,
    login: async () => 'continue',
    checkpoint: async () => 'continue',
    info: (m) => { record?.push(m); },
  };
}

// ── Vercel API fetch mock (contract shapes verified live against production) ──

function vercelFetch(state: { tokens: Array<{ id: string; name: string; expiresAt: number }>; burned: string[]; badTokens?: string[]; requireTeam?: string; apiMintForbidden?: boolean }) {
  let seq = 0;
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const auth = ((init?.headers as Record<string, string>)?.Authorization ?? '').replace('Bearer ', '');
    const json = (status: number, body: unknown): Response =>
      ({ ok: status < 400, status, json: async () => body } as unknown as Response);
    if (state.badTokens?.includes(auth)) {
      return json(403, { error: { code: 'forbidden', message: 'not authorized' } });
    }
    const path = new URL(url).pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (path === '/v2/user') return json(200, { user: { username: 'canary' } });
    if (path === '/v3/user/tokens' && method === 'POST') {
      if (state.apiMintForbidden) {
        return json(403, { error: { code: 'forbidden', message: 'Not authorized: Trying to access resource under scope "maxfaingezicht-5224". You must re-authenticate to this scope or use a token with access to this scope.' } });
      }
      const teamId = new URL(url).searchParams.get('teamId');
      if (state.requireTeam && teamId !== state.requireTeam) {
        return json(403, { error: { code: 'forbidden', message: `To create a token you must be authenticated to scope "${state.requireTeam}"` } });
      }
      const body = JSON.parse(String(init?.body)) as { name: string; expiresAt: number };
      const meta = { id: `tok_${++seq}`, name: body.name, expiresAt: body.expiresAt };
      state.tokens.push(meta);
      return json(200, { token: meta, bearerToken: `minted_${meta.id}_secret` });
    }
    if (path === '/v5/user/tokens') return json(200, { tokens: state.tokens });
    if (path.startsWith('/v3/user/tokens/') && method === 'DELETE') {
      const id = path.split('/').pop() as string;
      if (!state.tokens.some((t) => t.id === id)) return json(404, { error: { code: 'not_found', message: 'gone' } });
      state.tokens = state.tokens.filter((t) => t.id !== id);
      state.burned.push(id);
      return json(200, {});
    }
    return json(404, { error: { code: 'not_found', message: path } });
  };
  return impl;
}

// ── Engine ───────────────────────────────────────────────────────────────────

describe('recipe engine', () => {
  it('hostAllowed: exact + subdomain only', () => {
    expect(hostAllowed('https://vercel.com/x', ['vercel.com'])).toBe(true);
    expect(hostAllowed('https://api.vercel.com/x', ['vercel.com'])).toBe(true);
    expect(hostAllowed('https://evilvercel.com/x', ['vercel.com'])).toBe(false);
    expect(hostAllowed('https://vercel.com.evil.io/x', ['vercel.com'])).toBe(false);
  });

  it('completes the happy path and captures the value — window closed after', async () => {
    const driver = new FakeDriver({ captureValue: SECRET });
    const out = await runRecipe(vercelBootstrapRecipe, async () => driver, autoHooks(), { token_name: 'ba/prov/x' }, []);
    expect(out.status).toBe('completed');
    if (out.status !== 'completed') return;
    expect(out.captured.get('token_value')).toBe(SECRET);
    expect(driver.closed).toBe(true);
    // Canary: the value appears nowhere in the transcript.
    expect(JSON.stringify(out.transcript)).not.toContain(SECRET);
  });

  it('aborts and closes the window when navigation leaves the allowlist', async () => {
    const driver = new FakeDriver({
      captureValue: SECRET,
      hijackAfter: { description: 'the Create button', url: 'https://phish.example/steal' },
    });
    const out = await runRecipe(vercelBootstrapRecipe, async () => driver, autoHooks(), { token_name: 'x' }, []);
    expect(out.status).toBe('aborted');
    if (out.status !== 'aborted') return;
    expect(out.reason).toContain('left the allowed domains');
    expect(driver.closed).toBe(true);
  });

  it('refuses a tampered recipe whose steps navigate off-allowlist — before consent', async () => {
    const evil: Recipe = {
      ...vercelBootstrapRecipe,
      steps: [{ id: 'exfil', kind: 'goto', url: 'https://evil.example/' }, ...vercelBootstrapRecipe.steps],
    };
    let consentAsked = false;
    const hooks = { ...autoHooks(), consent: async () => { consentAsked = true; return true; } };
    const out = await runRecipe(evil, async () => new FakeDriver({}), hooks, { token_name: 'x' }, []);
    expect(out.status).toBe('aborted');
    expect(consentAsked).toBe(false);
  });

  it('checkpoint handoff: a missing target pauses for the human, then resumes', async () => {
    const driver = new FakeDriver({ captureValue: SECRET, missing: ['the Create button', 'the Create button (fallback)'] });
    const checkpoints: string[] = [];
    const hooks: EngineHooks = {
      ...autoHooks(),
      checkpoint: async (stepId, message) => { checkpoints.push(`${stepId}: ${message}`); return 'continue'; },
    };
    const out = await runRecipe(vercelBootstrapRecipe, async () => driver, hooks, { token_name: 'x' }, []);
    expect(out.status).toBe('completed');
    if (out.status !== 'completed') return;
    expect(checkpoints.some((c) => c.startsWith('submit'))).toBe(true);
    expect(out.transcript.find((t) => t.step === 'submit')?.result).toBe('manual');
  });

  it('login checkpoint: no steps run until the session exists; abort works', async () => {
    const driver = new FakeDriver({ loggedIn: false });
    const hooks: EngineHooks = { ...autoHooks(), login: async () => 'abort' };
    const out = await runRecipe(vercelBootstrapRecipe, async () => driver, hooks, { token_name: 'x' }, []);
    expect(out.status).toBe('aborted');
    expect(driver.log.filter((l) => l.startsWith('click'))).toHaveLength(0);
  });

  it('failed capture degrades to assisted paste with the window left open', async () => {
    const driver = new FakeDriver({
      captureValue: SECRET,
      missing: [
        'the new token value in the dialog',
        'the new token value (fallback)',
        'the new token value (fallback 2)',
        'the new token value (fallback 3)',
      ],
    });
    const out = await runRecipe(vercelBootstrapRecipe, async () => driver, autoHooks(), { token_name: 'x' }, []);
    expect(out.status).toBe('fallback_paste');
    expect(driver.closed).toBe(false); // value is on the user's screen
  });

  it('cancelling the consent sheet runs nothing — the window never even opens', async () => {
    let launched = 0;
    const hooks: EngineHooks = { ...autoHooks(), consent: async () => false };
    const out = await runRecipe(
      vercelBootstrapRecipe,
      async () => { launched += 1; return new FakeDriver({}); },
      hooks, { token_name: 'x' }, []
    );
    expect(out.status).toBe('aborted');
    expect(launched).toBe(0); // §3: consent BEFORE launch — no blank window
  });

  it('the window opens only AFTER consent is given', async () => {
    const order: string[] = [];
    const hooks: EngineHooks = {
      ...autoHooks(),
      consent: async () => { order.push('consent'); return true; },
    };
    const out = await runRecipe(
      vercelBootstrapRecipe,
      async () => { order.push('launch'); return new FakeDriver({ captureValue: SECRET }); },
      hooks, { token_name: 'x' }, []
    );
    expect(out.status).toBe('completed');
    expect(order).toEqual(['consent', 'launch']);
  });
});

// ── Guardrails ───────────────────────────────────────────────────────────────

describe('provisioning credential guardrails', () => {
  it('is never grantable, never leasable, and invisible to agent listings', async () => {
    const dir = tmpDir();
    const kr = await Keyring.init({ dir });
    const owner = kr.ownerKeypair();
    const agent = await generateKeypair();
    const agentId = publicKeyToAgentId(agent.publicKey);

    const prov = await kr.addCredential(owner, { label: PROV_LABEL, provider: 'vercel', provisioner: true }, SECRET);

    await expect(kr.createGrant(owner, prov.credential_id, agentId)).rejects.toMatchObject({ code: 'provisioner_only' });
    await expect(kr.lease(owner, prov.credential_id)).rejects.toMatchObject({ code: 'provisioner_only' });
    expect(kr.listForAgent(agent)).toHaveLength(0);

    // Owner-only accessor works for provisioner creds and ONLY those.
    expect(kr.provisionerValue(owner, prov.credential_id)).toBe(SECRET);
    const std = await kr.addCredential(owner, { label: 'normal' }, 'std-value');
    expect(() => kr.provisionerValue(owner, std.credential_id)).toThrow(KeyringError);
  });
});

// ── API client ───────────────────────────────────────────────────────────────

describe('VercelApi', () => {
  it('mints with the verified {name, expiresAt} contract and burns by id', async () => {
    const state: { tokens: Array<{ id: string; name: string; expiresAt: number }>; burned: string[]; badTokens?: string[]; requireTeam?: string; apiMintForbidden?: boolean } = { tokens: [], burned: [] };
    const client = new VercelApi('prov-token', vercelFetch(state));
    const minted = await client.createToken('ba/claude/abc123', 30);
    expect(minted.bearerToken).toContain(minted.meta.id);
    expect(minted.meta.expiresAt).toBeGreaterThan(Date.now());
    expect(await client.deleteToken(minted.meta.id)).toBe('burned');
    expect(await client.deleteToken(minted.meta.id)).toBe('already_gone');
  });

  it('surfaces the {error:{code,message}} shape', async () => {
    const state = { tokens: [], burned: [], badTokens: ['bad'] };
    const err = await new VercelApi('bad', vercelFetch(state)).whoami().catch((e) => e as VercelApiError);
    expect(err).toBeInstanceOf(VercelApiError);
    expect((err as VercelApiError).code).toBe('forbidden');
  });
});

// ── Connect orchestration ────────────────────────────────────────────────────

async function connectFixture(opts: { captureValue?: string } = {}) {
  const dir = tmpDir();
  const kr = await Keyring.init({ dir });
  const owner = kr.ownerKeypair();
  const agent = await generateKeypair();
  const agentId = publicKeyToAgentId(agent.publicKey);
  await kr.addIdentity(owner, agentId, { name: 'claude-code' });
  const state: { tokens: Array<{ id: string; name: string; expiresAt: number }>; burned: string[]; badTokens?: string[]; requireTeam?: string; apiMintForbidden?: boolean } = { tokens: [], burned: [] };
  const infoLines: string[] = [];
  let launches = 0;
  const deps = {
    kr, owner,
    hooks: autoHooks(infoLines),
    launchDriver: async () => { launches += 1; return new FakeDriver({ captureValue: opts.captureValue ?? SECRET }); },
    fetchImpl: vercelFetch(state),
    pasteFallback: (async () => null) as (message: string) => Promise<string | null>,
  };
  return { kr, owner, agent, agentId, state, deps, infoLines, launches: () => launches };
}

describe('connectVercel (bootstrap-then-API)', () => {
  it('first connect: browser once → two tokens (provisioning + agent), grant created', async () => {
    const f = await connectFixture();
    const result = await connectVercel(f.deps, { agentRef: 'claude-code' });

    expect(result.browserRan).toBe(true);
    expect(f.launches()).toBe(1);
    expect(result.tokenName).toMatch(/^ba\/claude-code\/[0-9a-f]{8}$/);
    expect(result.agentId).toBe(f.agentId);

    // Two-tier: provisioning credential + agent credential in the vault.
    const prov = f.kr.findProvisioner('vercel');
    expect(prov?.label).toBe(PROV_LABEL);
    // The agent can lease its token; the provisioning credential stays locked.
    const lease = await f.kr.lease(f.agent, result.credential.credential_id);
    expect(lease.value).toBe(`minted_${result.credential.provider_key_id}_secret`);
    await expect(f.kr.lease(f.agent, prov!.credential_id)).rejects.toMatchObject({ code: /provisioner_only|no_grant/ as unknown as string });

    // Canary: no secret value in any signed event or info line.
    const events = JSON.stringify(f.kr.timeline({}));
    expect(events).not.toContain(SECRET);
    expect(events).not.toContain('minted_');
    expect(JSON.stringify(f.infoLines)).not.toContain(SECRET);
  });

  it('second connect for a new agent: zero browser, API-only', async () => {
    const f = await connectFixture();
    await connectVercel(f.deps, { agentRef: 'claude-code' });
    const other = await generateKeypair();
    const otherId = publicKeyToAgentId(other.publicKey);
    await f.kr.addIdentity(f.owner, otherId, { name: 'cursor' });

    const second = await connectVercel(f.deps, { agentRef: 'cursor' });
    expect(second.browserRan).toBe(false);
    expect(f.launches()).toBe(1); // still just the bootstrap launch
  });

  it('rejected capture salvages via paste — the visible token is never thrown away', async () => {
    const f = await connectFixture();
    // The captured browser value doesn't authenticate; the human pastes the real one.
    (f.state as { badTokens?: string[] }).badTokens = [SECRET];
    const GOOD = 'PASTED_real_token_value_1234567890abcdef';
    let pasteAsked = 0;
    f.deps.pasteFallback = async () => { pasteAsked += 1; return GOOD; };
    const result = await connectVercel(f.deps, { agentRef: 'claude-code' });
    expect(pasteAsked).toBe(1);
    expect(result.browserRan).toBe(true);
    expect(f.kr.findProvisioner('vercel')).not.toBeNull();
    // The rejected capture value is nowhere in events; the pasted one isn't either.
    const events = JSON.stringify(f.kr.timeline({}));
    expect(events).not.toContain(SECRET);
    expect(events).not.toContain(GOOD);
  });

  it('rejected capture + cancelled paste saves nothing', async () => {
    const f = await connectFixture();
    (f.state as { badTokens?: string[] }).badTokens = [SECRET];
    await expect(connectVercel(f.deps, { agentRef: 'claude-code' })).rejects.toThrow(/cancelled during assisted paste/);
    expect(f.kr.findProvisioner('vercel')).toBeNull();
  });

  it('masked capture (ellipsis) skips straight to paste without a doomed verify', async () => {
    const f = await connectFixture({ captureValue: 'vc_abc…' });
    const GOOD = 'PASTED_real_token_value_1234567890abcdef';
    f.deps.pasteFallback = async () => GOOD;
    const result = await connectVercel(f.deps, { agentRef: 'claude-code' });
    expect(result.browserRan).toBe(true);
    expect(f.kr.findProvisioner('vercel')).not.toBeNull();
  });

  it('clipboard route: all DOM capture locators miss, Copy button + clipboard save the run', async () => {
    const f = await connectFixture();
    f.deps.launchDriver = async () => new FakeDriver({
      missing: [
        'the new token value in the dialog',
        'the new token value (fallback)',
        'the new token value (fallback 2)',
        'the new token value (fallback 3)',
      ],
      clipboardValue: '',
      copyProduces: SECRET,
    });
    let pasteAsked = 0;
    f.deps.pasteFallback = async () => { pasteAsked += 1; return null; };
    const result = await connectVercel(f.deps, { agentRef: 'claude-code' });
    expect(result.browserRan).toBe(true);
    expect(pasteAsked).toBe(0); // clipboard made terminal paste unnecessary
    expect(f.kr.findProvisioner('vercel')).not.toBeNull();
  });

  it('a stale clipboard value can never masquerade as an engine capture (pre-clear)', async () => {
    const f = await connectFixture();
    f.deps.launchDriver = async () => new FakeDriver({
      missing: [
        'the new token value in the dialog',
        'the new token value (fallback)',
        'the new token value (fallback 2)',
        'the new token value (fallback 3)',
      ],
      clipboardValue: 'STALE_HUMAN_COPY_1234567890abcdef', // human clicked Copy earlier
      // engine's own click produces nothing (wrong element labeled Copy)
    });
    let pasteAsked = 0;
    f.deps.pasteFallback = async () => { pasteAsked += 1; return 'PASTED_real_token_value_1234567890abcdef'; };
    await connectVercel(f.deps, { agentRef: 'claude-code' });
    expect(pasteAsked).toBe(1); // stale value was wiped, engine fell to paste honestly
  });

  it('team-scoped provisioning token: mint retries with the slug from the 403 and persists it', async () => {
    const f = await connectFixture();
    f.state.requireTeam = 'maxfaingezicht-5224';
    const result = await connectVercel(f.deps, { agentRef: 'claude-code' });
    expect(result.credential.provider_key_id).toBeTruthy();
    // The slug is remembered on the provisioning credential for future mints.
    expect(f.kr.findProvisioner('vercel')?.provider_team).toBe('maxfaingezicht-5224');

    // Second connect mints with teamId from the start — zero browser, no retry needed.
    const other = await generateKeypair();
    const otherId = publicKeyToAgentId(other.publicKey);
    await f.kr.addIdentity(f.owner, otherId, { name: 'cursor' });
    const second = await connectVercel(f.deps, { agentRef: 'cursor' });
    expect(second.browserRan).toBe(false);
  });

  it('mint ladder rung 3: API minting forbidden entirely → agent token minted in the browser', async () => {
    const f = await connectFixture();
    f.state.apiMintForbidden = true;
    const result = await connectVercel(f.deps, { agentRef: 'claude-code' });
    // Bootstrap browser + agent-token browser = two launches, and it SUCCEEDS.
    expect(f.launches()).toBe(2);
    expect(result.browserRan).toBe(true);
    expect(result.scope).toContain('browser');
    const lease = await f.kr.lease(f.agent, result.credential.credential_id);
    expect(lease.value).toBe(SECRET);
  });

  it('mint ladder rung 2: an existing prov that cannot mint is discarded and re-bootstrapped', async () => {
    const f = await connectFixture();
    await connectVercel(f.deps, { agentRef: 'claude-code' }); // healthy first connect (1 launch)
    f.state.apiMintForbidden = true;
    const other = await generateKeypair();
    await f.kr.addIdentity(f.owner, publicKeyToAgentId(other.publicKey), { name: 'cursor' });
    const second = await connectVercel(f.deps, { agentRef: 'cursor' });
    // Existing prov fails to mint → re-bootstrap (launch 2) → still forbidden →
    // browser-per-mint (launch 3). Never a dead end.
    expect(f.launches()).toBe(3);
    expect(second.browserRan).toBe(true);
    expect(f.kr.findProvisioner('vercel')).not.toBeNull(); // fresh prov kept for burns/list
  });

  it('unknown agent identity fails BEFORE any token is minted (no provider side effects)', async () => {
    const f = await connectFixture();
    await connectVercel(f.deps, { agentRef: 'claude-code' }); // healthy bootstrap
    const before = f.state.tokens.length;
    await expect(connectVercel(f.deps, { agentRef: 'max_test' })).rejects.toMatchObject({ code: 'unknown_identity' });
    expect(f.state.tokens.length).toBe(before); // nothing minted at Vercel
    expect(f.kr.credentialsView().filter((c) => !c.provisioner)).toHaveLength(1); // no orphan credential
  });

  it('bootstrap sweeps stray ba/provisioning tokens from earlier failed attempts', async () => {
    const f = await connectFixture();
    f.state.tokens.push({ id: 'tok_stray', name: 'ba/provisioning/deadbeef', expiresAt: Date.now() + 86_400_000 });
    f.state.tokens.push({ id: 'tok_user', name: 'Login with otp', expiresAt: Date.now() + 86_400_000 });
    await connectVercel(f.deps, { agentRef: 'claude-code' });
    expect(f.state.burned).toContain('tok_stray');
    expect(f.state.burned).not.toContain('tok_user'); // never touch user-made tokens
  });

  it('kill switch burns the agent token at the provider, by id', async () => {
    const f = await connectFixture();
    const result = await connectVercel(f.deps, { agentRef: 'claude-code' });
    await f.kr.killSwitch(f.owner, 'claude-code');
    const burns = await burnVercelTokensForAgent(
      { kr: f.kr, owner: f.owner, fetchImpl: f.deps.fetchImpl },
      [result.credential.credential_id]
    );
    expect(burns).toHaveLength(1);
    expect(burns[0].result).toBe('burned');
    expect(f.state.burned).toContain(result.credential.provider_key_id);
    // The provisioning token itself is NEVER auto-burned (§6).
    expect(f.kr.findProvisioner('vercel')).not.toBeNull();
  });
});

// ── Supabase: API client + connect orchestration ─────────────────────────────

interface SupabaseState {
  projects: Array<{ id: string; name: string }>;
  minted: Array<{ id: string; name: string; project: string }>;
  burned: string[];
  badTokens?: string[];
  /** POST api-keys 4xxs (legacy-only project) → service_role fallback path. */
  mintForbidden?: boolean;
}

function supabaseFetch(state: SupabaseState) {
  let seq = 0;
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const auth = ((init?.headers as Record<string, string>)?.Authorization ?? '').replace('Bearer ', '');
    const json = (status: number, body: unknown): Response =>
      ({ ok: status < 400, status, json: async () => body } as unknown as Response);
    if (state.badTokens?.includes(auth)) return json(401, { message: 'unauthorized' });
    const p = new URL(url).pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (p === '/v1/projects') {
      return json(200, state.projects.map((x) => ({ ...x, status: 'ACTIVE_HEALTHY' })));
    }
    const keys = /^\/v1\/projects\/([^/]+)\/api-keys$/.exec(p);
    if (keys && method === 'POST') {
      if (state.mintForbidden) return json(400, { message: 'new API keys are not enabled for this project' });
      const body = JSON.parse(String(init?.body)) as { type: string; name: string };
      const key = { id: `key_${++seq}`, name: body.name, project: keys[1] };
      state.minted.push(key);
      return json(200, { id: key.id, name: key.name, type: 'secret', api_key: `sb_secret_${key.id}_value` });
    }
    if (keys && method === 'GET') {
      const legacy = [
        { name: 'anon', api_key: 'eyJ_anon_1234567890abcdefghijklmnopqrstuvwxyz' },
        { name: 'service_role', api_key: 'eyJ_service_role_1234567890abcdefghijklmnop' },
      ];
      const mintedHere = state.minted
        .filter((k) => k.project === keys[1])
        .map((k) => ({ id: k.id, name: k.name, type: 'secret' }));
      return json(200, [...legacy, ...mintedHere]);
    }
    const del = /^\/v1\/projects\/([^/]+)\/api-keys\/([^/]+)$/.exec(p);
    if (del && method === 'DELETE') {
      if (!state.minted.some((k) => k.id === del[2])) return json(404, { message: 'not found' });
      state.minted = state.minted.filter((k) => k.id !== del[2]);
      state.burned.push(del[2]);
      return json(200, {});
    }
    return json(404, { message: p });
  };
}

async function supabaseFixture(opts: { projects?: Array<{ id: string; name: string }>; captureValue?: string } = {}) {
  const dir = tmpDir();
  const kr = await Keyring.init({ dir });
  const owner = kr.ownerKeypair();
  const agent = await generateKeypair();
  const agentId = publicKeyToAgentId(agent.publicKey);
  await kr.addIdentity(owner, agentId, { name: 'claude-code' });
  const state: SupabaseState = {
    projects: opts.projects ?? [{ id: 'abcdefghij1234567890', name: 'beanstalk' }],
    minted: [],
    burned: [],
  };
  const infoLines: string[] = [];
  let launches = 0;
  const deps = {
    kr, owner,
    hooks: autoHooks(infoLines),
    launchDriver: async () => { launches += 1; return new FakeDriver({ captureValue: opts.captureValue ?? SBP }); },
    fetchImpl: supabaseFetch(state),
    pasteFallback: (async () => null) as (message: string) => Promise<string | null>,
  };
  return { kr, owner, agent, agentId, state, deps, infoLines, launches: () => launches };
}

describe('SupabaseApi', () => {
  it('mints a secret key and burns by id', async () => {
    const state: SupabaseState = { projects: [{ id: 'ref1', name: 'p' }], minted: [], burned: [] };
    const client = new SupabaseApi(SBP, supabaseFetch(state));
    const minted = await client.createSecretKey('ref1', 'ba_claude_code_abc123');
    expect(minted.apiKey).toContain(minted.id);
    expect(await client.deleteApiKey('ref1', minted.id)).toBe('burned');
    expect(await client.deleteApiKey('ref1', minted.id)).toBe('already_gone');
  });

  it('surfaces the {message} error shape', async () => {
    const state: SupabaseState = { projects: [], minted: [], burned: [], badTokens: ['bad'] };
    const err = await new SupabaseApi('bad', supabaseFetch(state)).listProjects().catch((e) => e as SupabaseApiError);
    expect(err).toBeInstanceOf(SupabaseApiError);
    expect((err as SupabaseApiError).status).toBe(401);
  });
});

describe('connectSupabase (bootstrap-then-API, per-project)', () => {
  it('first connect: browser once → PAT provisioner + per-agent secret key, grant with our expiry leash', async () => {
    const f = await supabaseFixture();
    const result = await connectSupabase(f.deps, { agentRef: 'claude-code' });

    expect(result.browserRan).toBe(true);
    expect(f.launches()).toBe(1);
    expect(result.tokenName).toMatch(/^ba_claude_code_[0-9a-f]{8}$/);
    expect(result.projectRef).toBe('abcdefghij1234567890');
    expect(result.projectUrl).toBe('https://abcdefghij1234567890.supabase.co');
    expect(result.credential.env_var).toBe('SUPABASE_SECRET_KEY');
    // provider_team doubles as the project ref — the burn address.
    expect(result.credential.provider_team).toBe('abcdefghij1234567890');

    const prov = f.kr.findProvisioner('supabase');
    expect(prov?.label).toBe(SUPABASE_PROV_LABEL);
    // The agent can lease its key; the provisioning PAT stays locked.
    const lease = await f.kr.lease(f.agent, result.credential.credential_id);
    expect(lease.value).toBe(`sb_secret_${result.credential.provider_key_id}_value`);

    // Canary: no secret value in any signed event or info line.
    const events = JSON.stringify(f.kr.timeline({}));
    expect(events).not.toContain(SBP);
    expect(events).not.toContain('sb_secret_');
    expect(JSON.stringify(f.infoLines)).not.toContain(SBP);
  });

  it('second connect for a new agent: zero browser, API-only', async () => {
    const f = await supabaseFixture();
    await connectSupabase(f.deps, { agentRef: 'claude-code' });
    const other = await generateKeypair();
    const otherId = publicKeyToAgentId(other.publicKey);
    await f.kr.addIdentity(f.owner, otherId, { name: 'cursor' });

    const second = await connectSupabase(f.deps, { agentRef: 'cursor' });
    expect(second.browserRan).toBe(false);
    expect(f.launches()).toBe(1);
  });

  it('multi-project accounts require --project and get the roster; --project picks by ref or name', async () => {
    const projects = [{ id: 'refaaa', name: 'alpha' }, { id: 'refbbb', name: 'beta' }];
    const f = await supabaseFixture({ projects });
    await expect(connectSupabase(f.deps, { agentRef: 'claude-code' }))
      .rejects.toThrow(/pick one with --project .*refaaa \(alpha\), refbbb \(beta\)/);

    const byName = await connectSupabase(f.deps, { agentRef: 'claude-code', projectRef: 'beta' });
    expect(byName.projectRef).toBe('refbbb');
  });

  it('legacy-only project degrades to service_role with the honesty on the card', async () => {
    const f = await supabaseFixture();
    f.state.mintForbidden = true;
    const result = await connectSupabase(f.deps, { agentRef: 'claude-code' });

    expect(result.credential.env_var).toBe('SUPABASE_SERVICE_ROLE_KEY');
    expect(result.credential.provider_key_id).toBeUndefined();
    expect(result.scope).toContain('LEGACY service_role');

    // No id → the kill switch can only revoke locally, and says so.
    const burns = await burnSupabaseKeysForAgent(
      { kr: f.kr, owner: f.owner, fetchImpl: f.deps.fetchImpl },
      [result.credential.credential_id],
    );
    expect(burns[0].result).toContain('revoke only');
  });

  it('kill switch burns the minted key at the provider, by id; the PAT is never auto-burned', async () => {
    const f = await supabaseFixture();
    const result = await connectSupabase(f.deps, { agentRef: 'claude-code' });
    await f.kr.killSwitch(f.owner, 'claude-code');
    const burns = await burnSupabaseKeysForAgent(
      { kr: f.kr, owner: f.owner, fetchImpl: f.deps.fetchImpl },
      [result.credential.credential_id],
    );
    expect(burns).toHaveLength(1);
    expect(burns[0].result).toBe('burned');
    expect(f.state.burned).toContain(result.credential.provider_key_id);
    expect(f.kr.findProvisioner('supabase')).not.toBeNull();
  });

  it('rejected capture + cancelled paste saves nothing', async () => {
    const f = await supabaseFixture();
    f.state.badTokens = [SBP];
    await expect(connectSupabase(f.deps, { agentRef: 'claude-code' })).rejects.toThrow(/cancelled during assisted paste/);
    expect(f.kr.findProvisioner('supabase')).toBeNull();
  });

  it('non-sbp_ capture skips straight to paste without a doomed verify', async () => {
    const f = await supabaseFixture({ captureValue: 'Copy' });
    const GOOD = 'sbp_PASTED_real_token_1234567890abcdef';
    f.deps.pasteFallback = async () => GOOD;
    const result = await connectSupabase(f.deps, { agentRef: 'claude-code' });
    expect(result.browserRan).toBe(true);
    expect(f.kr.findProvisioner('supabase')).not.toBeNull();
  });
});
