/**
 * Plan entitlements — THE single source of truth (coder brief Task 1).
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * Kept free of route imports so both the route modules and billing.ts can
 * consume it without an import cycle. No inline plan checks exist anywhere
 * else in the codebase — grep for getEntitlements/checkAgentLimit to find
 * every consumer.
 */
import { ControlStore } from './store.js';
import type { OwnerRow } from './store.js';

export interface Entitlements {
  /** Active delegations allowed. Free tier: 3. Pro: unlimited. */
  maxAgents: number;
  /** Timeline window, enforced at query time. */
  retentionDays: number;
  anomalyFlags: boolean;
}

const FREE: Entitlements = { maxAgents: 3, retentionDays: 30, anomalyFlags: false };
const PRO: Entitlements = { maxAgents: Infinity, retentionDays: 365, anomalyFlags: true };

/**
 * Plan → entitlements. `past_due` and `canceled` fall back to Free LIMITS for
 * the two creation gates — nothing existing breaks and nothing protective is
 * withheld; 'team' is a reserved enum value and behaves as Pro.
 */
export function getEntitlements(owner: Pick<OwnerRow, 'plan' | 'plan_status'>): Entitlements {
  const paidPlan = owner.plan === 'pro' || owner.plan === 'team';
  return paidPlan && owner.plan_status === 'active' ? PRO : FREE;
}

/**
 * The delegation-creation / grant-approval gate. Deliberately the ONLY
 * enforcement predicate: over-limit means "no NEW agents or grants", it never
 * touches existing grants, leases, revocation, or daemon traffic.
 */
export async function checkAgentLimit(
  store: ControlStore,
  owner: OwnerRow,
): Promise<{ allowed: boolean; activeAgents: number; maxAgents: number }> {
  const entitlements = getEntitlements(owner);
  const activeAgents = await store.countActiveDelegations(owner.id);
  return {
    allowed: activeAgents < entitlements.maxAgents,
    activeAgents,
    maxAgents: entitlements.maxAgents,
  };
}
