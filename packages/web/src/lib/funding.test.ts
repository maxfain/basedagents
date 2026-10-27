import { describe, it, expect } from 'vitest';
import { fundingState, type FundingTask } from './funding';
import type { ApiEscrowView } from '../api/types';

/**
 * The funding badge must never let a declared-only bounty (sign-at-accept,
 * nothing deposited) read like money held in escrow, and must agree with the
 * Payment panel on the task page for every other state.
 */
const escrow = (status: ApiEscrowView['status']): ApiEscrowView => ({
  status, leg: null, wallet: '0xescrow', deposit_tx_hash: null, funded_at: null,
  release_tx_hash: null, released_at: null, refund_tx_hash: null, refunded_at: null,
});

function task(over: Partial<FundingTask> = {}): FundingTask {
  return {
    status: 'open',
    bounty: { amount_atomic: '2000000', amount_display: '2.00', token: 'USDC', network: 'eip155:8453' },
    bounty_amount: '2000000',
    payment_status: 'pending',
    payment_due: false,
    escrow: null,
    ...over,
  };
}

describe('fundingState', () => {
  it('is null for a task without a bounty', () => {
    expect(fundingState(task({ bounty: null, bounty_amount: null, payment_status: 'none' }))).toBeNull();
  });

  it('reads the legacy flat bounty column when the bounty object is absent', () => {
    expect(fundingState(task({ bounty: null, bounty_amount: '250000' }))?.key).toBe('declared');
  });

  it('is "Funded" only when the escrow deposit has landed', () => {
    const s = fundingState(task({ escrow: escrow('funded') }));
    expect(s?.key).toBe('funded');
    expect(s?.label).toBe('Funded');
    expect(s?.tone).toBe('held');
  });

  it('is "Pay at accept" for an open sign-at-accept bounty, never "Funded"', () => {
    // The shape of every open task on the public board on 2026-10-27: a bounty,
    // escrow null, payment pending.
    const s = fundingState(task({ bounty: { amount_atomic: '250000', amount_display: '0.25', token: 'USDC', network: 'eip155:8453' }, bounty_amount: '250000' }));
    expect(s?.key).toBe('declared');
    expect(s?.label).toBe('Pay at accept');
    expect(s?.tone).toBe('declared');
    expect(s?.title).toMatch(/Nothing is held/);
  });

  it('is "Paid" once the payout settled, with or without escrow', () => {
    expect(fundingState(task({ status: 'verified', payment_status: 'settled' }))?.key).toBe('paid');
    expect(fundingState(task({ status: 'verified', payment_status: 'settled', escrow: escrow('released') }))?.key).toBe('paid');
    // The escrow row says released before the payment column catches up.
    expect(fundingState(task({ status: 'verified', payment_status: 'settling', escrow: escrow('released') }))?.key).toBe('paid');
  });

  it('shows the in-flight and failed escrow legs', () => {
    expect(fundingState(task({ escrow: escrow('funding') }))?.label).toBe('Funding escrow');
    expect(fundingState(task({ status: 'verified', escrow: escrow('releasing') }))?.label).toBe('Releasing');
    expect(fundingState(task({ escrow: escrow('unfunded') }))?.label).toBe('Deposit failed');
    expect(fundingState(task({ status: 'cancelled', escrow: escrow('refunding') }))?.label).toBe('Refunded');
    expect(fundingState(task({ status: 'cancelled', payment_status: 'refunded', escrow: escrow('refunded') }))?.label).toBe('Refunded');
  });

  it('shows the sign-at-accept payout states after acceptance', () => {
    expect(fundingState(task({ status: 'verified', payment_due: true }))?.label).toBe('Payment due');
    expect(fundingState(task({ status: 'verified', payment_status: 'authorized' }))?.label).toBe('Settling');
    expect(fundingState(task({ status: 'verified', payment_status: 'settling' }))?.label).toBe('Settling');
    expect(fundingState(task({ status: 'verified', payment_status: 'failed', payment_due: true }))?.label).toBe('Payment due');
    expect(fundingState(task({ status: 'verified', payment_status: 'failed' }))?.label).toBe('Settlement failed');
    expect(fundingState(task({ status: 'verified', payment_status: 'expired' }))?.label).toBe('Authorization expired');
  });

  it('voids a declared bounty when the task ends unpaid, whatever the payment column says', () => {
    expect(fundingState(task({ status: 'cancelled' }))?.label).toBe('Bounty voided');
    expect(fundingState(task({ status: 'expired', payment_status: 'expired' }))?.label).toBe('Bounty voided');
    expect(fundingState(task({ status: 'closed', payment_status: 'none' }))?.label).toBe('Bounty voided');
  });
});
