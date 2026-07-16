import { describe, it, expect } from 'vitest';
import { generateKeypair, openSealedBox } from '@basedagents/keyring/crypto';
import { base58Encode } from '@basedagents/keyring/util';
import { sealForOwner } from './seal.js';

describe('browser sealing ↔ daemon opening (byte parity by construction)', () => {
  it('what the connect card seals, the daemon opens', async () => {
    const vault = await generateKeypair(); // the daemon's owner keypair
    const ownerId = `ow_${base58Encode(vault.publicKey)}`;

    const sealed = sealForOwner(ownerId, 'sbp_the-actual-provider-token');
    expect(sealed).not.toContain('sbp_'); // ciphertext, not plaintext

    const opened = new TextDecoder().decode(openSealedBox(vault.privateKey, sealed));
    expect(opened).toBe('sbp_the-actual-provider-token');
  });

  it('a different vault key cannot open it', async () => {
    const vault = await generateKeypair();
    const stranger = await generateKeypair();
    const sealed = sealForOwner(`ow_${base58Encode(vault.publicKey)}`, 'secret');
    expect(() => openSealedBox(stranger.privateKey, sealed)).toThrow();
  });

  it('rejects non-account ids', () => {
    expect(() => sealForOwner('ag_NotAnOwner', 'x')).toThrow(/not an account id/);
  });
});
