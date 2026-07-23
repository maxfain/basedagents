/**
 * based sync — provision-kind connections (the console Connect button).
 *
 * The runner is injected, so these tests never touch a browser or the real
 * Provisioner; they pin the daemon's routing, resolve payloads, and the
 * plain-words failure reasons the console card will show a base-case user.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keyring } from '../keyring.js';
import {
  processConnections, watchSecondsFrom, DEFAULT_WATCH_SECONDS,
  credentialFactsFrom, reportCredentialFacts,
} from './sync.js';
import { parseFlags, CliError } from './shared.js';
import type { ControlClient, RemoteConnection } from './control-client.js';

function fakeClient(rows: RemoteConnection[]) {
  const calls = { claims: [] as string[], resolves: [] as Array<{ id: string; result: unknown }> };
  const client = {
    getConnections: async () => rows,
    claimConnection: async (id: string) => {
      calls.claims.push(id);
      return true;
    },
    resolveConnection: async (id: string, result: unknown) => {
      calls.resolves.push({ id, result });
    },
  } as unknown as ControlClient;
  return { client, calls };
}

const provisionRow = (id: string, over: Partial<RemoteConnection> = {}): RemoteConnection => ({
  id,
  agent_id: 'ag_TestAgent',
  provider: 'vercel',
  label: 'Vercel',
  env_var: 'VERCEL_TOKEN',
  sealed_secret: '',
  kind: 'provision',
  created_at: new Date().toISOString(),
  ...over,
});

async function vault(): Promise<Keyring> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyring-sync-test-'));
  return Keyring.init({ dir });
}

describe('based sync — provision-kind connections (console Connect button)', () => {
  it('runs the injected provisioner for the row agent and resolves with the minted id', async () => {
    const kr = await vault();
    const { client, calls } = fakeClient([provisionRow('pcx_ok')]);
    const seen: string[] = [];
    await processConnections(kr, client, async (_k, agentId) => {
      seen.push(agentId);
      return { credentialId: 'cred_minted_1' };
    });
    expect(seen).toEqual(['ag_TestAgent']);
    expect(calls.claims).toEqual(['pcx_ok']);
    expect(calls.resolves).toEqual([{ id: 'pcx_ok', result: { daemonCredentialId: 'cred_minted_1' } }]);
  });

  it('maps "Unknown identity" to a plain-words reason the console can show', async () => {
    const kr = await vault();
    const { client, calls } = fakeClient([provisionRow('pcx_unknown')]);
    await processConnections(kr, client, async () => {
      throw new Error('Unknown identity: ag_TestAgent');
    });
    expect(calls.resolves).toHaveLength(1);
    expect((calls.resolves[0].result as { error: string }).error).toBe(
      'That agent is not set up on this computer — run the setup command here first.',
    );
  });

  it('refuses providers without a recipe, without ever invoking the provisioner', async () => {
    const kr = await vault();
    const { client, calls } = fakeClient([provisionRow('pcx_nope', { provider: 'railway', label: 'Railway' })]);
    let ran = false;
    await processConnections(kr, client, async () => {
      ran = true;
      return { credentialId: 'x' };
    });
    expect(ran).toBe(false);
    expect((calls.resolves[0].result as { error: string }).error).toContain('not available yet');
  });

  it('rotate rows run the rotate runner against the row credential and resolve with it', async () => {
    const kr = await vault();
    const { client, calls } = fakeClient([
      provisionRow('pcx_rot', { kind: 'rotate', provider: 'vercel', label: 'Vercel', daemon_credential_id: 'cred_v1' }),
    ]);
    const rotated: string[] = [];
    await processConnections(kr, client, async () => ({ credentialId: 'never' }), async (_kr, credentialId) => {
      rotated.push(credentialId);
    });
    expect(rotated).toEqual(['cred_v1']);
    expect(calls.resolves[0].result).toEqual({ daemonCredentialId: 'cred_v1' });
  });

  it('a failed rotation resolves with the plain-words reason', async () => {
    const kr = await vault();
    const { client, calls } = fakeClient([
      provisionRow('pcx_rotfail', { kind: 'rotate', provider: 'supabase', label: 'Supabase', daemon_credential_id: 'cred_s1' }),
    ]);
    await processConnections(kr, client, async () => ({ credentialId: 'never' }), async () => {
      throw new Error('rotate it in the Supabase dashboard');
    });
    expect((calls.resolves[0].result as { error: string }).error).toContain('Supabase dashboard');
  });

  it('dispatches the provision run with the row provider (supabase included)', async () => {
    const kr = await vault();
    const { client, calls } = fakeClient([provisionRow('pcx_sb', { provider: 'supabase', label: 'Supabase' })]);
    const providers: string[] = [];
    await processConnections(kr, client, async (_kr, _agent, provider) => {
      providers.push(provider);
      return { credentialId: 'cred_sb' };
    });
    expect(providers).toEqual(['supabase']);
    expect(calls.resolves[0].result).toEqual({ daemonCredentialId: 'cred_sb' });
  });

  it('never routes a sealed row through the provisioner', async () => {
    const kr = await vault();
    const { client, calls } = fakeClient([
      provisionRow('pcx_sealed', { kind: 'sealed', sealed_secret: 'not-real-ciphertext' }),
    ]);
    let ran = false;
    await processConnections(kr, client, async () => {
      ran = true;
      return { credentialId: 'x' };
    });
    expect(ran).toBe(false);
    // The sealed path fails on the bogus ciphertext and reports sealed-style.
    expect(calls.resolves).toHaveLength(1);
    expect((calls.resolves[0].result as { error?: string }).error).toBeTruthy();
  });
});

describe('sync --watch flag (field-hit: bare --watch must not error)', () => {
  const SPEC = { value: ['api'], optionalValue: ['watch'] };

  it('bare --watch parses as a switch and defaults the interval', () => {
    const flags = parseFlags(['--watch'], SPEC);
    expect(flags.switches.has('watch')).toBe(true);
    expect(watchSecondsFrom(flags)).toBe(DEFAULT_WATCH_SECONDS);
  });

  it('--watch before another --flag stays bare instead of swallowing the flag', () => {
    const flags = parseFlags(['--watch', '--api', 'https://x.test'], SPEC);
    expect(flags.switches.has('watch')).toBe(true);
    expect(flags.values['api']).toBe('https://x.test');
    expect(watchSecondsFrom(flags)).toBe(DEFAULT_WATCH_SECONDS);
  });

  it('--watch 30 still takes the explicit interval', () => {
    expect(watchSecondsFrom(parseFlags(['--watch', '30'], SPEC))).toBe(30);
  });

  it('absent --watch stays one-shot (undefined)', () => {
    expect(watchSecondsFrom(parseFlags([], SPEC))).toBeUndefined();
  });

  it('a non-numeric or sub-1 interval fails with the seconds hint', () => {
    for (const bad of ['abc', '0']) {
      expect(() => watchSecondsFrom(parseFlags(['--watch', bad], SPEC))).toThrowError(
        expect.objectContaining({ name: 'CliError', message: expect.stringContaining('seconds') }) as unknown as CliError,
      );
    }
  });
});

describe('credential facts — the console must only offer Rotate where rotate can work', () => {
  it('mirrors the rotate guard chain exactly', async () => {
    const kr = await vault();
    const owner = kr.ownerKeypair();
    const add = (meta: Parameters<typeof kr.addCredential>[1]) => kr.addCredential(owner, meta, 'secret-value');

    const pasted = await add({ label: 'Vercel pasted', provider: 'vercel' });
    const minted = await add({ label: 'Vercel minted', provider: 'vercel', provider_key_id: 'tok_1' });
    const sbNoRef = await add({ label: 'SB no ref', provider: 'supabase', provider_key_id: 'key_1' });
    const sbFull = await add({ label: 'SB full', provider: 'supabase', provider_key_id: 'key_2', provider_team: 'projref' });
    const provisioning = await add({ label: 'Vercel PAT', provider: 'vercel', provider_key_id: 'tok_2', provisioner: true });
    const other = await add({ label: 'Stripe', provider: 'stripe', provider_key_id: 'sk_1' });

    const byId = new Map(credentialFactsFrom(kr).map((f) => [f.id, f]));
    expect(byId.get(pasted.credential_id)?.rotatable).toBe(false);
    expect(byId.get(minted.credential_id)?.rotatable).toBe(true);
    expect(byId.get(sbNoRef.credential_id)?.rotatable).toBe(false);
    expect(byId.get(sbFull.credential_id)?.rotatable).toBe(true);
    expect(byId.get(provisioning.credential_id)?.rotatable).toBe(false);
    expect(byId.get(other.credential_id)?.rotatable).toBe(false);
    expect(byId.get(minted.credential_id)?.provider).toBe('vercel');
  });

  it('reports only when the facts changed, and a failed report retries', async () => {
    const kr = await vault();
    const owner = kr.ownerKeypair();
    await kr.addCredential(owner, { label: 'Vercel minted', provider: 'vercel', provider_key_id: 'tok_9' }, 'v');

    let fail = true;
    const sent: unknown[] = [];
    const client = {
      reportCredentialFacts: async (facts: unknown) => {
        if (fail) throw new Error('control plane unreachable');
        sent.push(facts);
      },
    } as unknown as ControlClient;

    await reportCredentialFacts(kr, client); // fails — must not count as delivered
    expect(sent).toHaveLength(0);
    fail = false;
    await reportCredentialFacts(kr, client); // retried because nothing was delivered
    expect(sent).toHaveLength(1);
    await reportCredentialFacts(kr, client); // unchanged facts — no second call
    expect(sent).toHaveLength(1);
    await kr.addCredential(owner, { label: 'SB', provider: 'supabase', provider_key_id: 'k', provider_team: 'p' }, 's');
    await reportCredentialFacts(kr, client); // changed facts — reported again
    expect(sent).toHaveLength(2);
  });
});
