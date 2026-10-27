import type { ApiTask } from '../api/types';

/**
 * Where the money behind a bounty is right now.
 *
 * Every surface that shows a bounty used to draw the same green chip, so a
 * bounty that was only DECLARED (posted with `escrow: false`: nothing
 * deposited, paid wallet-to-wallet if the buyer ever accepts) looked the same
 * as USDC sitting in the registry's escrow wallet. `fundingState` keeps the two
 * apart: "Funded" means the deposit has landed in escrow and the agent is paid
 * from it on acceptance; "Pay at accept" means the bounty is a promise.
 *
 * The wording mirrors the Payment panel on the task page (TaskDetail's
 * escrowWording / paymentWording) so the chip and the panel never disagree.
 */
export type FundingTone = 'held' | 'paid' | 'pending' | 'failed' | 'void' | 'declared';

export type FundingKey =
  | 'funded' | 'paid' | 'funding' | 'releasing' | 'deposit_failed' | 'refunded'
  | 'settling' | 'payment_due' | 'settlement_failed' | 'voided' | 'authorization_expired'
  | 'declared' | 'legacy';

export interface FundingState {
  key: FundingKey;
  /** Chip text. */
  label: string;
  /** One sentence for the tooltip. */
  title: string;
  tone: FundingTone;
}

/** The slice of a task the funding state is read from (list rows carry all of it). */
export type FundingTask = Pick<ApiTask, 'status' | 'escrow' | 'payment_status' | 'payment_due' | 'bounty' | 'bounty_amount'>;

export function hasBounty(task: FundingTask): boolean {
  return !!(task.bounty?.amount_display || task.bounty_amount);
}

const PAYMENT_DUE: FundingState = {
  key: 'payment_due', label: 'Payment due', tone: 'pending',
  title: 'Accepted, but the buyer has not signed the USDC transfer yet. Nothing moves until they do.',
};
const VOIDED: FundingState = {
  key: 'voided', label: 'Bounty voided', tone: 'void',
  title: 'The task ended before the bounty was paid.',
};

export function fundingState(task: FundingTask): FundingState | null {
  if (!hasBounty(task)) return null;
  const escrow = task.escrow ?? null;
  const status = task.payment_status ?? null;

  if (status === 'settled' || escrow?.status === 'released') {
    return {
      key: 'paid', label: 'Paid', tone: 'paid',
      title: escrow ? 'The escrowed USDC was released to the agent on-chain.' : 'USDC transferred from the buyer to the agent on-chain.',
    };
  }

  if (escrow) {
    switch (escrow.status) {
      case 'funded':
        return {
          key: 'funded', label: 'Funded', tone: 'held',
          title: "The bounty is deposited in the registry's escrow wallet and released to the agent when the delivery is accepted.",
        };
      case 'funding':
        return {
          key: 'funding', label: 'Funding escrow', tone: 'pending',
          title: "The buyer's deposit is settling into escrow; the task is claimable once it lands.",
        };
      case 'releasing':
        return {
          key: 'releasing', label: 'Releasing', tone: 'pending',
          title: 'Accepted: the escrowed USDC is being transferred to the agent.',
        };
      case 'unfunded':
        return {
          key: 'deposit_failed', label: 'Deposit failed', tone: 'failed',
          title: 'The escrow deposit did not settle; the buyer can deposit again or cancel the task.',
        };
      case 'refunding':
      case 'refunded':
        return {
          key: 'refunded', label: 'Refunded', tone: 'void',
          title: "The deposit was returned to the buyer's wallet.",
        };
      default:
        return { key: 'legacy', label: String(escrow.status), tone: 'void', title: 'Escrow state.' };
    }
  }

  // Sign-at-accept: the bounty is declared at posting and only authorized when
  // the buyer accepts. Nothing is held at any point.
  const ended = task.status === 'cancelled' || task.status === 'expired' || task.status === 'closed';
  const due = task.payment_due ?? false;
  switch (status) {
    case 'authorized':
    case 'settling':
      return {
        key: 'settling', label: 'Settling', tone: 'pending',
        title: 'The buyer signed the transfer; settlement is in flight.',
      };
    case 'failed':
      return due ? PAYMENT_DUE : {
        key: 'settlement_failed', label: 'Settlement failed', tone: 'failed',
        title: 'The last settlement attempt failed; it is retried, or the buyer signs a fresh authorization.',
      };
    case 'expired':
      if (ended) return VOIDED;
      return {
        key: 'authorization_expired', label: 'Authorization expired', tone: 'failed',
        title: 'The signed transfer expired before it settled; the buyer must sign again.',
      };
    case 'disputed':
    case 'refunded':
      return { key: 'legacy', label: status, tone: 'void', title: 'Legacy payment state.' };
    default: // null, 'none', 'pending'
      if (ended) return VOIDED;
      if (due) return PAYMENT_DUE;
      return {
        key: 'declared', label: 'Pay at accept', tone: 'declared',
        title: 'Bounty declared, not deposited: paid wallet-to-wallet if the buyer accepts the delivery. Nothing is held.',
      };
  }
}
