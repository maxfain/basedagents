/**
 * Billing for the Keyring control plane (coder brief Task 1 — decisions locked).
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * North star: **local is free, hosted is paid.** The agent is the unit of
 * scale — Free = 1 owner / 3 delegated agents / 30-day retention; Pro
 * ($10/mo, $96/yr) = unlimited agents / 1-year retention / anomaly flags.
 *
 * Non-negotiable rules implemented here and at the enforcement points:
 *   1. Security actions are NEVER paywalled and never degrade — revoke, kill
 *      switch, daemon pull/confirm, and recent-timeline reads work on
 *      past_due and canceled accounts. Plan state is consulted at exactly two
 *      places: delegation creation (the 4th agent on Free) and grant
 *      approval. Never at lease time; never on daemon endpoints.
 *   2. {@link getEntitlements} is the single source of truth. No inline plan
 *      checks anywhere else.
 *   3. Downgrades apply at period end (Stripe default). Over-limit after a
 *      downgrade: existing agents keep working; no new delegations or grant
 *      approvals until under limit or re-upgraded.
 *   4. Retention is enforced at query time (no purge cron).
 *
 * Stripe wiring: Checkout for upgrades, the Customer Portal for everything
 * else (card, cancel, invoices — no custom UI), webhooks as the only writer
 * of plan state (the success redirect is untrusted). Webhook processing is
 * idempotent by event id via an atomic INSERT claim.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import Stripe from 'stripe';
import { z } from 'zod';
import type { AppEnv } from '../types/index.js';
import { ControlStore } from './store.js';
import type { OwnerRow } from './store.js';
import { ownerSession } from './routes.js';
import { consoleOrigin } from './email.js';

// ─── entitlements (THE single source of truth) ───

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
 * withheld (rule 1); 'team' is a reserved enum value and behaves as Pro.
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

// ─── config / small helpers ───

interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  priceMonthly: string;
  priceYearly: string;
}

/** Env is an opaque map (same pattern as config.ts) — no shared-Bindings widening. */
function stripeConfig(env: unknown): StripeConfig | null {
  const e = (env ?? {}) as Record<string, string | undefined>;
  if (!e.STRIPE_SECRET_KEY) return null;
  return {
    secretKey: e.STRIPE_SECRET_KEY,
    webhookSecret: e.STRIPE_WEBHOOK_SECRET ?? '',
    priceMonthly: e.STRIPE_PRICE_PRO_MONTHLY ?? '',
    priceYearly: e.STRIPE_PRICE_PRO_YEARLY ?? '',
  };
}

/** Workers-compatible client (fetch transport, WebCrypto signature checks). */
function stripeClient(cfg: StripeConfig): Stripe {
  return new Stripe(cfg.secretKey, { httpClient: Stripe.createFetchHttpClient() });
}

const cryptoProvider = Stripe.createSubtleCryptoProvider();

function getStore(c: Context<AppEnv>): ControlStore {
  return new ControlStore(c.get('db'));
}

function getOwnerId(c: Context<AppEnv>): string {
  return (c.get as (k: string) => string)('ownerId');
}

function err(
  c: Context<AppEnv>,
  status: 400 | 401 | 402 | 404 | 409 | 503,
  error: string,
  message: string,
) {
  return c.json({ error, message }, status);
}

function unixToIso(seconds: number | null | undefined): string | null {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : null;
}

// ─── owner-facing routes (mounted at /v1/owner) ───

const CheckoutSchema = z.object({ interval: z.enum(['monthly', 'yearly']) });

export const billingRoutes = new Hono<AppEnv>();

/** Plan + entitlements + usage for the console's /settings/billing page. */
billingRoutes.get('/billing', ownerSession, async (c) => {
  const store = getStore(c);
  const owner = await store.getOwner(getOwnerId(c));
  if (!owner) return err(c, 404, 'not_found', 'owner not found');
  const entitlements = getEntitlements(owner);
  const activeAgents = await store.countActiveDelegations(owner.id);
  return c.json({
    plan: owner.plan,
    plan_status: owner.plan_status,
    current_period_end: owner.current_period_end,
    entitlements: {
      max_agents: Number.isFinite(entitlements.maxAgents) ? entitlements.maxAgents : null, // null = unlimited
      retention_days: entitlements.retentionDays,
      anomaly_flags: entitlements.anomalyFlags,
    },
    active_agents: activeAgents,
    billing_configured: stripeConfig(c.env) !== null,
  });
});

billingRoutes.post('/billing/checkout', ownerSession, async (c) => {
  const cfg = stripeConfig(c.env);
  if (!cfg) return err(c, 503, 'billing_unavailable', 'billing is not configured');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = CheckoutSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'interval must be monthly or yearly');

  const store = getStore(c);
  const owner = await store.getOwner(getOwnerId(c));
  if (!owner) return err(c, 404, 'not_found', 'owner not found');

  const stripe = stripeClient(cfg);
  let customerId = owner.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: owner.email ?? undefined,
      metadata: { owner_id: owner.id },
    });
    customerId = customer.id;
    await store.setStripeCustomerId(owner.id, customerId);
  }

  const base = consoleOrigin(c.env);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: owner.id,
    line_items: [
      { price: parsed.data.interval === 'yearly' ? cfg.priceYearly : cfg.priceMonthly, quantity: 1 },
    ],
    success_url: `${base}/settings/billing?checkout=success`,
    cancel_url: `${base}/settings/billing?checkout=canceled`,
  });
  return c.json({ url: session.url });
});

billingRoutes.post('/billing/portal', ownerSession, async (c) => {
  const cfg = stripeConfig(c.env);
  if (!cfg) return err(c, 503, 'billing_unavailable', 'billing is not configured');
  const store = getStore(c);
  const owner = await store.getOwner(getOwnerId(c));
  if (!owner?.stripe_customer_id) {
    return err(c, 400, 'bad_request', 'no billing account yet — upgrade first');
  }
  const stripe = stripeClient(cfg);
  const session = await stripe.billingPortal.sessions.create({
    customer: owner.stripe_customer_id,
    return_url: `${consoleOrigin(c.env)}/settings/billing`,
  });
  return c.json({ url: session.url });
});

// ─── the webhook (mounted at /v1 — no session; Stripe signature IS the auth) ───

export const stripeWebhookRoutes = new Hono<AppEnv>();

stripeWebhookRoutes.post('/stripe/webhook', async (c) => {
  const cfg = stripeConfig(c.env);
  if (!cfg || !cfg.webhookSecret) return err(c, 503, 'billing_unavailable', 'billing is not configured');

  const signature = c.req.header('stripe-signature');
  if (!signature) return err(c, 400, 'bad_request', 'missing stripe-signature header');
  const payload = await c.req.text();

  const stripe = stripeClient(cfg);
  let event: Stripe.Event;
  try {
    // Async variant is REQUIRED on Workers (SubtleCrypto is async-only).
    event = await stripe.webhooks.constructEventAsync(
      payload,
      signature,
      cfg.webhookSecret,
      undefined,
      cryptoProvider,
    );
  } catch {
    return err(c, 400, 'bad_request', 'webhook signature verification failed');
  }

  const store = getStore(c);
  // Atomic idempotency claim: a replayed event id is acknowledged, not reprocessed.
  if (!(await store.claimStripeEvent(event.id, event.type))) {
    return c.json({ received: true, duplicate: true });
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const ownerId = session.client_reference_id;
      if (ownerId && (await store.getOwner(ownerId))) {
        const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
        if (customerId) await store.setStripeCustomerId(ownerId, customerId);
        await store.updateOwnerBilling({
          ownerId,
          plan: 'pro',
          planStatus: 'active',
          stripeSubscriptionId:
            typeof session.subscription === 'string' ? session.subscription : (session.subscription?.id ?? null),
          // Period end arrives with the customer.subscription.updated that follows.
          currentPeriodEnd: null,
        });
      }
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      const owner = await store.getOwnerByStripeCustomerId(customerId);
      if (owner) {
        // Newer API versions carry current_period_end on the item, older on the sub.
        const periodEnd =
          unixToIso((sub as unknown as { current_period_end?: number }).current_period_end) ??
          unixToIso(sub.items?.data?.[0]?.current_period_end);
        if (sub.status === 'active' || sub.status === 'trialing') {
          await store.updateOwnerBilling({
            ownerId: owner.id, plan: 'pro', planStatus: 'active',
            stripeSubscriptionId: sub.id, currentPeriodEnd: periodEnd,
          });
        } else if (sub.status === 'past_due') {
          // Rule 1: past_due degrades creation limits to Free via getEntitlements,
          // but plan stays 'pro' so a recovered payment restores state cleanly.
          await store.updateOwnerBilling({
            ownerId: owner.id, plan: 'pro', planStatus: 'past_due',
            stripeSubscriptionId: sub.id, currentPeriodEnd: periodEnd,
          });
        } else if (sub.status === 'canceled' || sub.status === 'unpaid' || sub.status === 'incomplete_expired') {
          await store.updateOwnerBilling({
            ownerId: owner.id, plan: 'free', planStatus: 'canceled',
            stripeSubscriptionId: null, currentPeriodEnd: null,
          });
        }
        // Other statuses (incomplete, paused) change nothing.
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      const owner = await store.getOwnerByStripeCustomerId(customerId);
      if (owner) {
        await store.updateOwnerBilling({
          ownerId: owner.id, plan: 'free', planStatus: 'canceled',
          stripeSubscriptionId: null, currentPeriodEnd: null,
        });
      }
      break;
    }

    default:
      break; // acknowledged, ignored
  }

  return c.json({ received: true });
});
