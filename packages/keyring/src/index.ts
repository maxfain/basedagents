/**
 * @basedagents/keyring — scoped, revocable credentials bound to cryptographic
 * agent identities.
 *
 * Your agents already have identities. Keyring is what those identities are
 * trusted to carry.
 *
 * npm install @basedagents/keyring
 * https://basedagents.ai
 */

export {
  Keyring,
  KeyringError,
  deriveEnvVarName,
} from './keyring.js';

export {
  VaultStore,
  defaultVaultDir,
  loadKeypairFile,
  parseKeypairJson,
  expandHome,
  GENESIS_HASH,
  type OwnerKeyFile,
  type HeadAnchor,
} from './store.js';

export {
  generateKeypair,
  sealToPublicKey,
  openSealedBox,
  signPayload,
  verifyPayload,
  type AgentKeypair,
} from './crypto.js';

export {
  createEvent,
  computeEntryHash,
  verifyEventLog,
  type SignablePayload,
  type VerifyOptions,
} from './events.js';

export {
  canonicalJsonStringify,
  base58Encode,
  base58Decode,
  publicKeyToAgentId,
  agentIdToPublicKey,
  sha256Hex,
  randomId,
} from './util.js';

export * from './types.js';
