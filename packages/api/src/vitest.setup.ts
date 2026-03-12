/**
 * Global vitest setup.
 * @noble/ed25519 requires sha512Sync to be set for synchronous operations in Node.js.
 */
import { etc } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// Configure sha512Sync so @noble/ed25519 works in Node.js
etc.sha512Sync = (...m: Parameters<typeof sha512>) => sha512(...m);
