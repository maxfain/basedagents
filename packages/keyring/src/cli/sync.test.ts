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
import { processConnections } from './sync.js';
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
