/**
 * Custody Fix 1 — the canary invariant (change order §Fix 1 "Guardrail test").
 *
 * Seed a known fake secret, drive the real execution-brokering path, and assert
 * the canary string appears in ZERO model-visible output: not in keyring_run's
 * returned text, not in keyring_render's returned text, and not in any signed
 * event in the vault log. The child process DID receive the value (proving the
 * broker actually works) — it is only ever redacted out of what the model sees.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Keyring } from '../keyring.js';
import { generateKeypair, type AgentKeypair } from '../crypto.js';
import { publicKeyToAgentId } from '../util.js';
import { runBrokered, renderBrokered, redactSecrets } from './broker.js';

// A distinctive fake marker (not shaped like any real provider key, so push
// protection stays quiet). Only needs to be unique + long enough to redact.
const CANARY = 'CANARY_DO_NOT_LEAK_5f3e9c2a7b1d4e6f_9z8y7x0w';

const tempDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyring-broker-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function seed(constraints = {}): Promise<{ kr: Keyring; agent: AgentKeypair }> {
  const kr = await Keyring.init({ dir: tmpDir() });
  const owner = kr.ownerKeypair();
  const agent = await generateKeypair();
  const cred = await kr.addCredential(owner, { label: 'Canary token', env_var: 'CANARY_TOKEN' }, CANARY);
  await kr.createGrant(owner, cred.credential_id, publicKeyToAgentId(agent.publicKey), constraints);
  return { kr, agent };
}

/** A child that prints its injected secret to stdout — the worst case for leakage. */
function echoSecretCmd(): string[] {
  return [process.execPath, '-e', 'process.stdout.write("child-saw:" + process.env.CANARY_TOKEN)'];
}

describe('Custody Fix 1 — keyring_run brokering', () => {
  it('injects the secret into the child but redacts it from the returned text', async () => {
    const { kr, agent } = await seed();
    const res = await runBrokered(kr, agent, {
      credential_refs: ['CANARY_TOKEN'],
      command: echoSecretCmd(),
      purpose: 'canary test',
    });

    expect(res.isError).toBe(false);
    // The child received the real value (it printed "child-saw:<value>")...
    expect(res.text).toContain('child-saw:');
    // ...but the value itself is nowhere in the model-visible text.
    expect(res.text).not.toContain(CANARY);
    // The redaction marker proves the child's echo was scrubbed, not just absent.
    expect(res.text).toContain('‹redacted:CANARY_TOKEN›');
    expect(res.text).toContain('Exit code:** 0');
  });

  it('never writes the secret into any signed event in the log', async () => {
    const { kr, agent } = await seed();
    await runBrokered(kr, agent, {
      credential_refs: ['CANARY_TOKEN'], command: echoSecretCmd(), purpose: 'canary test',
    });
    const events = kr.timeline();
    const runEvent = events.find(e => e.event_type === 'run');
    expect(runEvent).toBeTruthy();
    for (const e of events) {
      expect(e.signed_payload).not.toContain(CANARY);
      expect(JSON.stringify(e.detail ?? {})).not.toContain(CANARY);
    }
    expect((await kr.verifyLog()).ok).toBe(true);
  });

  it('refuses all-or-nothing when a ref cannot be leased and runs nothing', async () => {
    const { kr, agent } = await seed();
    const res = await runBrokered(kr, agent, {
      credential_refs: ['CANARY_TOKEN', 'NOPE_MISSING'],
      command: [process.execPath, '-e', 'process.stdout.write("SHOULD-NOT-RUN")'],
      purpose: 'canary test',
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('refused');
    expect(res.text).not.toContain('SHOULD-NOT-RUN');
  });

  it('surfaces a nonzero exit code as an error, still redacted', async () => {
    const { kr, agent } = await seed();
    const res = await runBrokered(kr, agent, {
      credential_refs: ['CANARY_TOKEN'],
      command: [process.execPath, '-e', 'process.stdout.write(process.env.CANARY_TOKEN); process.exit(3)'],
      purpose: 'canary test',
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('Exit code:** 3');
    expect(res.text).not.toContain(CANARY);
  });
});

describe('Custody Fix 1 — keyring_render brokering', () => {
  it('writes the value to disk but never returns it to the model', async () => {
    const { kr, agent } = await seed();
    const dest = path.join(tmpDir(), 'deploy.env');
    const res = await renderBrokered(kr, agent, {
      dest_path: dest,
      content: 'DATABASE_URL=postgres://x\nTOKEN={{keyring:CANARY_TOKEN}}\n',
      purpose: 'canary render',
    });
    expect(res.isError).toBe(false);
    expect(res.text).not.toContain(CANARY);
    // The file on disk DOES contain the real value.
    expect(fs.readFileSync(dest, 'utf8')).toContain(CANARY);
    const renderEvent = kr.timeline().find(e => e.event_type === 'render');
    expect(renderEvent).toBeTruthy();
    expect(renderEvent!.signed_payload).not.toContain(CANARY);
  });

  it('refuses when a placeholder cannot be filled and writes nothing', async () => {
    const { kr, agent } = await seed();
    const dest = path.join(tmpDir(), 'deploy.env');
    const res = await renderBrokered(kr, agent, {
      dest_path: dest,
      content: 'A={{keyring:CANARY_TOKEN}}\nB={{keyring:MISSING_REF}}\n',
    });
    expect(res.isError).toBe(true);
    expect(fs.existsSync(dest)).toBe(false);
  });
});

describe('Custody Fix 1 — keyring_lease value-release gate', () => {
  it('refuses raw value release unless the grant opts in', async () => {
    const { kr, agent } = await seed(); // no unsafe_value_release
    await expect(
      kr.lease(agent, 'CANARY_TOKEN', { requireValueRelease: true }),
    ).rejects.toMatchObject({ code: 'value_release_disabled' });
  });

  it('allows raw value release when the owner enabled it', async () => {
    const { kr, agent } = await seed({ unsafe_value_release: true });
    const lease = await kr.lease(agent, 'CANARY_TOKEN', { requireValueRelease: true });
    expect(lease.value).toBe(CANARY);
  });

  it('env-injection leases (keyring_run path) are never blocked by the gate', async () => {
    const { kr, agent } = await seed(); // no unsafe_value_release
    const lease = await kr.lease(agent, 'CANARY_TOKEN'); // no requireValueRelease
    expect(lease.value).toBe(CANARY);
  });
});

describe('redactSecrets', () => {
  it('replaces every occurrence and ignores trivially short values', () => {
    expect(redactSecrets('a=SECRETVAL b=SECRETVAL', [{ value: 'SECRETVAL', env_var: 'X' }]))
      .toBe('a=‹redacted:X› b=‹redacted:X›');
    // Values under 4 chars are not redacted (too many false positives) — the
    // gate + env injection are the real protection, this is defence in depth.
    expect(redactSecrets('ab', [{ value: 'ab', env_var: 'X' }])).toBe('ab');
  });
});
