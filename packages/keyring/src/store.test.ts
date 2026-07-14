import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VaultStore, GENESIS_HASH, parseKeypairJson, loadKeypairFile } from './store.js';
import { generateKeypair } from './crypto.js';
import { base58Encode, bytesToHex, publicKeyToAgentId, nowIso } from './util.js';
import type { VaultFile, AccessEvent } from './types.js';

const tempDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyring-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function minimalVault(): VaultFile {
  return {
    version: 1,
    created_at: nowIso(),
    owner: { agent_id: 'ag_test', public_key_b58: 'testkey' },
    identities: {},
    credentials: {},
    grants: {},
    requests: {},
  };
}

function fakeEvent(sequence: number, prevHash: string): AccessEvent {
  return {
    event_id: `evt_${sequence}`,
    sequence,
    timestamp: nowIso(),
    event_type: 'lease',
    agent_pubkey: 'pk',
    agent_signature: 'sig',
    signed_payload: '{}',
    credential_id: null,
    grant_id: null,
    requesting_context: null,
    detail: null,
    prev_hash: prevHash,
    entry_hash: String(sequence).repeat(64).slice(0, 64),
  };
}

// ─── parseKeypairJson ───

describe('parseKeypairJson', () => {
  it('accepts the { public_key_b58, private_key_hex } format', async () => {
    const kp = await generateKeypair();
    const json = JSON.stringify({
      agent_id: publicKeyToAgentId(kp.publicKey),
      public_key_b58: base58Encode(kp.publicKey),
      private_key_hex: bytesToHex(kp.privateKey),
    });
    const parsed = parseKeypairJson(json);
    expect(bytesToHex(parsed.publicKey)).toBe(bytesToHex(kp.publicKey));
    expect(bytesToHex(parsed.privateKey)).toBe(bytesToHex(kp.privateKey));
  });

  it('accepts the { publicKey, privateKey } hex format', async () => {
    const kp = await generateKeypair();
    const json = JSON.stringify({
      publicKey: bytesToHex(kp.publicKey),
      privateKey: bytesToHex(kp.privateKey),
    });
    const parsed = parseKeypairJson(json);
    expect(bytesToHex(parsed.publicKey)).toBe(bytesToHex(kp.publicKey));
    expect(bytesToHex(parsed.privateKey)).toBe(bytesToHex(kp.privateKey));
  });

  it('rejects a JSON object without recognized keys', () => {
    expect(() => parseKeypairJson('{"foo":"bar"}')).toThrow(/Unrecognized keypair file/);
    expect(() => parseKeypairJson('{}')).toThrow(/Unrecognized keypair file/);
  });

  it('rejects non-JSON garbage', () => {
    expect(() => parseKeypairJson('definitely not json')).toThrow();
  });

  it('loadKeypairFile reads a keypair from disk', async () => {
    const kp = await generateKeypair();
    const file = path.join(tmpDir(), 'keypair.json');
    fs.writeFileSync(file, JSON.stringify({
      publicKey: bytesToHex(kp.publicKey),
      privateKey: bytesToHex(kp.privateKey),
    }));
    const loaded = loadKeypairFile(file);
    expect(bytesToHex(loaded.publicKey)).toBe(bytesToHex(kp.publicKey));
  });
});

// ─── File modes & atomic writes ───

describe('vault file permissions', () => {
  it('writes vault.json with mode 0600 inside a 0700 directory', () => {
    // Use a not-yet-existing subdirectory so ensureDir controls its mode.
    const dir = path.join(tmpDir(), 'vault');
    const store = new VaultStore(dir);
    store.writeVault(minimalVault());

    expect(fs.statSync(store.vaultPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('writes owner.json with mode 0600', async () => {
    const store = new VaultStore(path.join(tmpDir(), 'vault'));
    const kp = await generateKeypair();
    const file = store.writeOwnerKey(kp);
    expect(fs.statSync(store.ownerKeyPath).mode & 0o777).toBe(0o600);
    expect(file.agent_id).toBe(publicKeyToAgentId(kp.publicKey));
    expect(file.public_key_b58).toBe(base58Encode(kp.publicKey));
    expect(file.private_key_hex).toBe(bytesToHex(kp.privateKey));
    // Round-trips through readOwnerKey.
    const read = store.readOwnerKey();
    expect(bytesToHex(read.privateKey)).toBe(bytesToHex(kp.privateKey));
  });

  it('atomic write leaves no temp files behind', () => {
    const dir = path.join(tmpDir(), 'vault');
    const store = new VaultStore(dir);
    store.writeVault(minimalVault());
    store.writeVault(minimalVault());
    const leftovers = fs.readdirSync(dir).filter(f => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('readVault round-trips content and rejects missing/unsupported vaults', () => {
    const dir = path.join(tmpDir(), 'vault');
    const store = new VaultStore(dir);
    expect(() => store.readVault()).toThrow(/No keyring vault/);

    const vault = minimalVault();
    store.writeVault(vault);
    expect(store.readVault()).toEqual(vault);
    expect(store.exists()).toBe(true);

    fs.writeFileSync(store.vaultPath, JSON.stringify({ ...vault, version: 99 }));
    expect(() => store.readVault()).toThrow(/Unsupported vault version/);
  });
});

// ─── Locking ───

describe('withLock', () => {
  it('serializes concurrent critical sections', async () => {
    const store = new VaultStore(path.join(tmpDir(), 'vault'));
    const order: string[] = [];
    const section = (name: string): Promise<void> => store.withLock(async () => {
      order.push(`${name}-start`);
      await new Promise(resolve => setTimeout(resolve, 60));
      order.push(`${name}-end`);
    });

    await Promise.all([section('a'), section('b')]);

    expect(order).toHaveLength(4);
    // No overlap: whichever section starts first must finish before the other starts.
    expect(order[1]).toBe(order[0].replace('-start', '-end'));
    expect(order[3]).toBe(order[2].replace('-start', '-end'));
    expect(order[0]).not.toBe(order[2]);
  });

  it('returns the section value and releases the lock after an error', async () => {
    const store = new VaultStore(path.join(tmpDir(), 'vault'));
    await expect(store.withLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // Lock must have been released — the next section runs immediately.
    const value = await store.withLock(async () => 42);
    expect(value).toBe(42);
  });
});

// ─── Event log ───

describe('event log', () => {
  it('chainHead on an empty log returns sequence 0 and the 64-zero genesis hash', () => {
    const store = new VaultStore(path.join(tmpDir(), 'vault'));
    expect(GENESIS_HASH).toBe('0'.repeat(64));
    expect(store.chainHead()).toEqual({ sequence: 0, entry_hash: GENESIS_HASH });
  });

  it('readEvents returns [] when no log file exists', () => {
    const store = new VaultStore(path.join(tmpDir(), 'vault'));
    expect(store.readEvents()).toEqual([]);
  });

  it('appendEvent/readEvents round-trip in order and chainHead tracks the last event', () => {
    const store = new VaultStore(path.join(tmpDir(), 'vault'));
    const e1 = fakeEvent(1, GENESIS_HASH);
    const e2 = fakeEvent(2, e1.entry_hash);
    store.appendEvent(e1);
    store.appendEvent(e2);

    expect(store.readEvents()).toEqual([e1, e2]);
    expect(store.chainHead()).toEqual({ sequence: 2, entry_hash: e2.entry_hash });
  });
});
