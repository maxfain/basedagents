/**
 * The owner identity IS the vault key: owner_id = "ow_" + base58(vault Ed25519
 * pubkey) (packages/api/src/control/identity.ts). So the console can always
 * re-derive the vault public key it needs for the bind_vault_key ceremony from
 * the id of the signed-in owner — no extra input, no chance of binding a key
 * that doesn't match the account.
 */
export function vaultKeyFromOwnerId(ownerId: string): string {
  if (!ownerId.startsWith('ow_') || ownerId.length <= 3) {
    throw new Error(`not an owner id: ${ownerId}`);
  }
  return ownerId.slice(3);
}
