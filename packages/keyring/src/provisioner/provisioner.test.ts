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
import type { Driver, EngineHooks, Recipe, RecipeLocator } from './types.js';

const SECRET = 'CANARY_vercel_token_9f3e2a71bc84d605_DO_NOT_LEAK';

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
}

class FakeDriver implements Driver {
  url = 'about:blank';
  log: string[] = [];
  closed = false;
  constructor(private opts: FakeOpts) {}
  private resolves(l: RecipeLocator): boolean {
    if ((this.opts.missing ?? []).includes(l.description)) return false;
    if (l.description.includes('Create button on the Tokens page')) return this.opts.loggedIn !== false;
    return true;
  }
  async goto(url: string): Promise<void> { this.url = url; this.log.push(`goto ${url}`); }
  async currentUrl(): Promise<string> { return this.url; }
  async exists(l: RecipeLocator): Promise<boolean> { return this.resolves(l); }
  async click(l: RecipeLocator): Promise<void> {
    if (!this.resolves(l)) throw new Error(`not found: ${l.description}`);
    this.log.push(`click ${l.description}`);
    const h = this.opts.hijackAfter;
    if (h && l.description === h.description) this.url = h.url;
  }
  async fill(l: RecipeLocator, value: string): Promise<void> {
    if (!this.resolves(l)) throw new Error(`not found: ${l.description}`);
    this.log.push(`fill ${l.description}=${value}`);
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

function vercelFetch(state: { tokens: Array<{ id: string; name: string; expiresAt: number }>; burned: string[]; badTokens?: string[] }) {
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
    expect(checkpoints.some((c) => c.startsWith('open-create'))).toBe(true);
    expect(out.transcript.find((t) => t.step === 'open-create')?.result).toBe('manual');
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
      missing: ['the new token value in the dialog', 'the new token value (fallback)', 'the new token value (fallback 2)'],
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
    const state = { tokens: [] as Array<{ id: string; name: string; expiresAt: number }>, burned: [] as string[] };
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
  const state = { tokens: [] as Array<{ id: string; name: string; expiresAt: number }>, burned: [] as string[] };
  const infoLines: string[] = [];
  let launches = 0;
  const deps = {
    kr, owner,
    hooks: autoHooks(infoLines),
    launchDriver: async () => { launches += 1; return new FakeDriver({ captureValue: opts.captureValue ?? SECRET }); },
    fetchImpl: vercelFetch(state),
    pasteFallback: async () => null,
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

  it('rejected capture is never enshrined — vault stays empty', async () => {
    const f = await connectFixture();
    // Make whoami fail for the captured browser token only.
    (f.state as { badTokens?: string[] }).badTokens = [SECRET];
    await expect(connectVercel(f.deps, { agentRef: 'claude-code' })).rejects.toThrow(/rejected by Vercel/);
    expect(f.kr.findProvisioner('vercel')).toBeNull();
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
