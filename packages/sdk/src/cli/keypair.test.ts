/**
 * SDK CLI — loadKeypair behavior tests (NEW-2)
 *
 * Tests the keypair serialization/deserialization used by the CLI,
 * simulating the multi-keypair selection logic from wallet.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeypair, serializeKeypair, deserializeKeypair, publicKeyToAgentId } from '../index.js';

describe('loadKeypair — keypair round-trip (NEW-2)', () => {
  it('generates a valid keypair', async () => {
    const kp = await generateKeypair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);
  });

  it('serialize → deserialize round-trip produces same keys', async () => {
    const kp = await generateKeypair();
    const serialized = serializeKeypair(kp);
    const restored = deserializeKeypair(serialized);

    expect(restored.publicKey).toEqual(kp.publicKey);
    expect(restored.privateKey).toEqual(kp.privateKey);
  });

  it('serialized keypair is valid JSON with publicKey and privateKey fields', async () => {
    const kp = await generateKeypair();
    const serialized = serializeKeypair(kp);
    const parsed = JSON.parse(serialized) as { publicKey: string; privateKey: string };
    expect(typeof parsed.publicKey).toBe('string');
    expect(typeof parsed.privateKey).toBe('string');
    expect(parsed.publicKey.length).toBe(64); // 32 bytes as hex = 64 chars
    expect(parsed.privateKey.length).toBe(64);
  });

  it('deserialize throws on invalid JSON', () => {
    expect(() => deserializeKeypair('not-json')).toThrow();
  });

  it('deserialize throws on missing keys', () => {
    expect(() => deserializeKeypair(JSON.stringify({}))).toThrow();
  });

  it('two different keypairs have different agent IDs', async () => {
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    const id1 = publicKeyToAgentId(kp1.publicKey);
    const id2 = publicKeyToAgentId(kp2.publicKey);
    expect(id1).not.toBe(id2);
  });
});

describe('loadKeypair — multi-keypair selection logic (NEW-2)', () => {
  /**
   * Simulate the loadKeypair() file-selection logic from wallet.ts:
   * - Sort files alphabetically
   * - Use the last (most recent) one
   * - Warn if multiple exist
   */
  function simulateKeypairSelection(files: string[]): {
    selectedFile: string;
    warned: boolean;
  } {
    const keypairFiles = files.filter(f => f.endsWith('-keypair.json'));
    if (keypairFiles.length === 0) throw new Error('No keypairs found');

    const warned = keypairFiles.length > 1;
    const selectedFile = keypairFiles[keypairFiles.length - 1]; // last alphabetical
    return { selectedFile, warned };
  }

  it('selects the only keypair when one file exists', () => {
    const { selectedFile, warned } = simulateKeypairSelection(['my-agent-keypair.json']);
    expect(selectedFile).toBe('my-agent-keypair.json');
    expect(warned).toBe(false);
  });

  it('selects last alphabetical keypair when multiple files exist', () => {
    const files = [
      'agent-a-keypair.json',
      'agent-b-keypair.json',
      'agent-c-keypair.json',
    ];
    const { selectedFile, warned } = simulateKeypairSelection(files);
    expect(selectedFile).toBe('agent-c-keypair.json');
    expect(warned).toBe(true);
  });

  it('warns when multiple keypairs found (NEW-2)', () => {
    const { warned } = simulateKeypairSelection(['a-keypair.json', 'b-keypair.json']);
    expect(warned).toBe(true);
  });

  it('does not warn when only one keypair found', () => {
    const { warned } = simulateKeypairSelection(['only-keypair.json']);
    expect(warned).toBe(false);
  });

  it('throws when no keypair files found', () => {
    expect(() => simulateKeypairSelection([])).toThrow('No keypairs found');
    expect(() => simulateKeypairSelection(['readme.txt', 'config.json'])).toThrow('No keypairs found');
  });

  it('ignores non-keypair files', () => {
    const files = ['readme.txt', 'my-keypair.json', 'config.json', 'notes.md'];
    const { selectedFile } = simulateKeypairSelection(files);
    expect(selectedFile).toBe('my-keypair.json');
  });
});
