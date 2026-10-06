/**
 * Wallet-signed task actions (wallets/action.ts): the exact message format and
 * the checks before the signature. The signature check itself is the payout
 * bind's (bind.test.ts covers smart wallets).
 */
import { describe, it, expect } from 'vitest';
import {
  buildActionMessage, parseActionMessage, freshActionMessage, verifyActionProof, ACTION_FOOTERS, ACTION_MAX_AGE_MS, type ActionFields,
} from './action.js';
import { personalSign, TEST_WALLET_KEYS } from '../test-helpers.js';
import { addressFromPrivateKey, parseHousePrivateKey } from '../payments/house-wallet.js';

const WALLET = addressFromPrivateKey(parseHousePrivateKey('0x' + TEST_WALLET_KEYS.a)).toLowerCase();
const TASK = 'task_AbC123xyz';
const FIELDS: ActionFields = { taskId: TASK, action: 'accept', wallet: WALLET, network: 'eip155:8453', issuedAt: '2026-10-06T19:06:13Z', nonce: '53dca6690f12cf6b' };
const MESSAGE = buildActionMessage(FIELDS);
const AT = new Date('2026-10-06T19:07:00Z');

const prove = (over: Partial<Parameters<typeof verifyActionProof>[1]> = {}) => verifyActionProof({}, {
  taskId: TASK, action: 'accept', wallet: WALLET, network: 'eip155:8453', message: MESSAGE, signature: personalSign(MESSAGE, TEST_WALLET_KEYS.a), now: AT, ...over,
});

describe('action message', () => {
  it('says what each action does with the escrowed bounty', () => {
    expect(ACTION_FOOTERS.accept).toMatch(/releases this task's escrowed bounty/);
    expect(ACTION_FOOTERS.cancel).toMatch(/refunds its escrowed bounty/);
    for (const a of ['accept', 'cancel', 'revision', 'dispute'] as const) expect(ACTION_FOOTERS[a]).not.toMatch(/moves no funds/);
  });

  it('is the documented text, line for line', () => {
    expect(MESSAGE.split('\n')).toEqual([
      'BasedAgents task action', `Task: ${TASK}`, 'Action: accept', `Wallet: ${WALLET}`, 'Network: eip155:8453',
      'Issued: 2026-10-06T19:06:13Z', 'Nonce: 53dca6690f12cf6b', '', ACTION_FOOTERS.accept,
    ]);
  });

  it('round-trips the canonical form; anything else is refused', () => {
    expect(parseActionMessage(MESSAGE)).toEqual(FIELDS);
    expect(parseActionMessage(MESSAGE.replace(/\n/g, '\r\n'))).toBeNull();
    expect(parseActionMessage(MESSAGE + '\n')).toBeNull();
    expect(parseActionMessage(MESSAGE.replace('Action: accept', 'Action: withdraw'))).toBeNull();
    expect(parseActionMessage(MESSAGE.replace(ACTION_FOOTERS.accept, 'Sure, take my money.'))).toBeNull();
    // Each action carries its own footer: an accept message with the "read" wording is refused.
    expect(parseActionMessage(MESSAGE.replace(ACTION_FOOTERS.accept, ACTION_FOOTERS.read))).toBeNull();
    expect(parseActionMessage(MESSAGE.replace('Action: accept', 'Action: read'))).toBeNull();
    expect(parseActionMessage(MESSAGE.replace('Task: ', 'Task:  '))).toBeNull();
  });

  it('freshActionMessage drops milliseconds and draws a 16-hex nonce', () => {
    const fields = parseActionMessage(freshActionMessage(TASK, 'read', WALLET, 'eip155:8453', new Date('2026-10-06T19:06:13.789Z')));
    expect(fields).toMatchObject({ action: 'read', issuedAt: '2026-10-06T19:06:13Z' });
    expect(fields!.nonce).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('verifyActionProof', () => {
  it('accepts the paying wallet signing this task and action', async () => {
    expect(await prove()).toMatchObject({ ok: true, signerKind: 'eoa', fields: FIELDS });
    // The address compares case-insensitively.
    expect(await prove({ wallet: WALLET.toUpperCase().replace('0X', '0x') })).toMatchObject({ ok: true });
  });

  it('refuses another task, action, wallet or network before checking the signature', async () => {
    expect(await prove({ taskId: 'task_Other123' })).toMatchObject({ ok: false, reason: 'task_mismatch' });
    expect(await prove({ action: 'cancel' })).toMatchObject({ ok: false, reason: 'action_mismatch' });
    expect(await prove({ wallet: '0x' + '9'.repeat(40) })).toMatchObject({ ok: false, reason: 'wallet_mismatch' });
    expect(await prove({ network: 'eip155:84532' })).toMatchObject({ ok: false, reason: 'network_mismatch' });
    expect(await prove({ message: 'hello' })).toMatchObject({ ok: false, reason: 'malformed_message' });
  });

  it('is good for ACTION_MAX_AGE_MS, and not from the future', async () => {
    expect(await prove({ now: new Date(Date.parse(FIELDS.issuedAt) + ACTION_MAX_AGE_MS + 1000) })).toMatchObject({ ok: false, reason: 'expired' });
    expect(await prove({ now: new Date(Date.parse(FIELDS.issuedAt) - 10 * 60_000) })).toMatchObject({ ok: false, reason: 'issued_in_future' });
  });
});
