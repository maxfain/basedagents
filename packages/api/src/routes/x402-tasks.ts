/**
 * Wallet-only task posting over x402 — the third creator family (migration 0051).
 *
 * A buyer with a USDC wallet and nothing else hires an agent here. The x402
 * payment IS the authentication: no AgentSig, no keypair, no account. The
 * first call answers 402 with the price; the buyer signs an EIP-3009 transfer
 * of the bounty to the registry's escrow wallet and retries with the
 * PAYMENT-SIGNATURE header; the task is created, funded and open. The poster
 * is the wallet the facilitator verified as the payer (`creator_wallet`),
 * never a field of the request.
 *
 *   GET  /v1/x402/tasks                  the price list (no auth)
 *   POST /v1/x402/tasks                  {title, description, bounty_usdc, …}: buyer-chosen bounty, at least the minimum
 *   POST /v1/x402/tasks/usd-1            {title, description, …}: a fixed 1 USDC bounty
 *   POST /v1/x402/tasks/usd-5            fixed 5 USDC
 *   POST /v1/x402/tasks/usd-20           fixed 20 USDC
 *   GET  /v1/x402/tasks/:id              the poster's view: status, delivery, payment
 *   GET  /v1/x402/tasks/:id/submission   the delivered work
 *   POST /v1/x402/tasks/:id/accept       {note?, rating?}: releases the deposit to the deliverer
 *   POST /v1/x402/tasks/:id/revision     {note}
 *   POST /v1/x402/tasks/:id/dispute      {reason}
 *   POST /v1/x402/tasks/:id/cancel       {reason?}: refunds the deposit to the wallet that paid
 *
 * Managing a task takes one of two proofs:
 *   * the manage token returned once by the paid POST, as `Authorization: Bearer bat_…`
 *     (only its sha256 is stored); or
 *   * a signature by the paying wallet over a one-time action message
 *     (wallets/action.ts), sent as `X-Wallet-Message` (the message, 0x hex) and
 *     `X-Wallet-Signature`. Any unauthenticated call answers 401 with the exact
 *     message to sign (`sign_this`), so a lost token is never a lost task.
 *
 * Escrow is the only money model here: the deposit is the authentication, so a
 * wallet poster never signs again to pay. Binding the same wallet as an agent's
 * payout wallet later moves these tasks to that agent (routes/agents.ts); the
 * wallet keeps its access through these routes.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types/index.js';
import { CreateTaskSchema, BOUNTY_NETWORKS, BOUNTY_NETWORK_NAMES, MAINNET_BOUNTY_NETWORKS, fundableBountyNetworks, describeBountyNetworks, RatingFields, withRatingRule, ratingInputOf, isRatingIssue, RATING_RULE_MESSAGE } from '../types/index.js';
import type { DBAdapter } from '../db/adapter.js';
import { sha256, bytesToHex } from '../crypto/index.js';
import { generatePublicId } from '../lib/ids.js';
import { captureServerEvent } from '../lib/posthog.js';
import { base64urlEncode, timingSafeEqual } from '../mcp/websec.js';
import { paymentProviderFor } from '../payments/index.js';
import { atomicToDisplay, usdcToAtomic } from '../payments/x402.js';
import { fundEscrowTask, acceptEscrowTask, startEscrowLeg } from '../payments/escrow.js';
import { escrowDisabledReason, houseWalletFor } from '../payments/house-wallet.js';
import { PAYMENT_HEADER } from '../payments/accept.js';
import { resolveOpenExpiry, DEFAULT_OPEN_TTL_DAYS, MAX_OPEN_TTL_DAYS } from '../tasks/expiry.js';
import { bountyMinimumRefusal, minBountyAtomic } from '../tasks/bounty-minimum.js';
import { slashBondForDisputedClaim } from '../tasks/governance.js';
import {
  type Actor, type TaskRow, loadTask, logPaymentEvent, recordFunnel, publicTaskShape, paymentView,
  creatorSqlParts, recomputeReputation, escrowView, revisionGate, disputeGate, cancelGate, cancelRefusal, MAX_REVISIONS,
  settleRatingAfterAccept,
} from '../tasks/service.js';
import { recordEvent } from '../events/service.js';
import { verifyActionProof, freshActionMessage, type TaskAction } from '../wallets/action.js';

const app = new Hono<AppEnv>();
type Ctx = Context<AppEnv>;

/** Public base of this route family, for the 402 `resource` and the links a paid POST returns. */
export const X402_TASKS_BASE = 'https://api.basedagents.ai/v1/x402/tasks';

/** Fixed-price hire endpoints: path segment → bounty in atomic USDC. */
export const X402_TIERS: Readonly<Record<string, string>> = { 'usd-1': '1000000', 'usd-5': '5000000', 'usd-20': '20000000' };

/** Atomic USDC → the 6-decimal string OpenAPI `x-payment-info` prices use ("2000000" → "2.000000"). */
function sixDecimals(atomic: string): string {
  const n = BigInt(atomic);
  return `${n / 1_000_000n}.${(n % 1_000_000n).toString().padStart(6, '0')}`;
}

/** The parts of openapi.json that openApiForEnv adjusts. */
type ServedSpec = {
  info?: { 'x-guidance'?: string };
  paths: Record<string, Record<string, { description?: string; responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, { example?: unknown }> } }> }> }>>;
  components?: { schemas?: Record<string, { properties?: Record<string, { enum?: string[] }> }> };
};

/** The hire request bodies, whose `network` lists what a buyer may pin the payment to. */
const HIRE_REQUEST_SCHEMAS = ['X402TierHireRequest', 'X402HireRequest'];

/**
 * How the spec's prose names the mainnet networks, as [the file's wording, this deployment's]:
 * "Base, Polygon or Arc", "Base eip155:8453, Polygon eip155:137 or Arc eip155:5042" and
 * "Base, then Polygon, then Arc", with only the networks offered here.
 */
function networkWording(offered: readonly string[]): Array<[string, string]> {
  const name = (n: string) => BOUNTY_NETWORK_NAMES[n] ?? n;
  const or = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}` : xs[0] ?? '');
  const forms = [
    (ns: readonly string[]) => or(ns.map(name)),
    (ns: readonly string[]) => or(ns.map((n) => `${name(n)} ${n}`)),
    (ns: readonly string[]) => ns.map(name).join(', then '),
  ];
  return forms.map((form): [string, string] => [form(MAINNET_BOUNTY_NETWORKS), form(offered)]);
}

/**
 * openapi.json as served (GET /openapi.json), describing what this deployment takes now:
 * - its `x-payment-info` follows the live minimum bounty: the custom endpoint's `min` is
 *   the deployment's minimum, and a tier priced under it is left out, as the routes refuse it;
 * - the hire endpoints name only the networks a deposit can be paid on here
 *   (fundableBountyNetworks): no Arc until Circle's facilitator is configured, and no
 *   testnet in production. Agents and directories read the spec, so it never offers a
 *   network the 402 doesn't.
 * When nothing differs, the file is served as is.
 */
export function openApiForEnv<T extends { paths: Record<string, unknown> }>(spec: T, env: unknown): T {
  const min = String(minBountyAtomic(env, 'a2a'));
  type Paid = { post?: { 'x-payment-info'?: { price: Record<string, string> } } };
  const custom = (spec.paths['/v1/x402/tasks'] as Paid | undefined)?.post?.['x-payment-info'];
  const unavailable = Object.entries(X402_TIERS).filter(([, amount]) => bountyMinimumRefusal(env, 'a2a', amount)).map(([tier]) => `/v1/x402/tasks/${tier}`);
  const networks = fundableBountyNetworks(env as Parameters<typeof fundableBountyNetworks>[0]);
  const offered = MAINNET_BOUNTY_NETWORKS.filter((n) => networks.includes(n));
  const schemas = (spec as unknown as ServedSpec).components?.schemas;
  const sameNetworks = offered.length === MAINNET_BOUNTY_NETWORKS.length
    && HIRE_REQUEST_SCHEMAS.every((name) => {
      const listed = schemas?.[name]?.properties?.network?.enum;
      return !listed || (listed.length === networks.length && listed.every((n, i) => n === networks[i]));
    });
  if ((!custom || custom.price.min === sixDecimals(min)) && unavailable.length === 0 && sameNetworks) return spec;
  const out = structuredClone(spec);
  const outCustom = (out.paths['/v1/x402/tasks'] as Paid | undefined)?.post?.['x-payment-info'];
  if (outCustom) outCustom.price.min = sixDecimals(min);
  for (const path of unavailable) delete out.paths[path];
  if (!sameNetworks) {
    const served = out as unknown as ServedSpec;
    for (const name of HIRE_REQUEST_SCHEMAS) {
      const network = served.components?.schemas?.[name]?.properties?.network;
      if (network?.enum) network.enum = [...networks];
    }
    const listed = served.paths['/v1/x402/tasks']?.get?.responses?.['200']?.content?.['application/json']?.schema?.properties?.networks;
    if (listed && 'example' in listed) listed.example = [...networks];
    const reword = (text: string) => networkWording(offered).reduce((t, [all, here]) => t.replaceAll(all, here), text);
    if (served.info?.['x-guidance']) served.info['x-guidance'] = reword(served.info['x-guidance']);
    for (const [path, item] of Object.entries(served.paths)) {
      if (path !== '/v1/x402/tasks' && !path.startsWith('/v1/x402/tasks/')) continue;
      for (const op of Object.values(item)) if (op.description) op.description = reword(op.description);
    }
  }
  return out;
}

const MANAGE_TOKEN_PREFIX = 'bat_';
const WALLET_MESSAGE_HEADER = 'X-Wallet-Message';
const WALLET_SIGNATURE_HEADER = 'X-Wallet-Signature';
const LEGACY_PAYMENT_HEADER = 'X-PAYMENT-SIGNATURE';
/** How long a spent action nonce is kept: far past ACTION_MAX_AGE_MS, so a pruned nonce's message is long expired. */
const NONCE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** What the buyer describes; the money comes from the endpoint (tiers) or `bounty_usdc` (custom). */
const TaskFields = CreateTaskSchema.pick({
  title: true, description: true, category: true, required_capabilities: true, expected_output: true, output_format: true,
}).extend({
  /** Days the task stays open unclaimed: 1–MAX_OPEN_TTL_DAYS (default 60). */
  expires_in_days: z.number().int().min(1).max(MAX_OPEN_TTL_DAYS).optional(),
  /** Pay on this network only. Omitted, the 402 offers every network this registry accepts (Base first). */
  network: z.enum(BOUNTY_NETWORKS).optional(),
});
const TierBodySchema = TaskFields.strict();
const CustomBodySchema = TaskFields.extend({
  /** The bounty in USDC, e.g. "2.50": at least the minimum, at most 1000, up to 6 decimals. */
  bounty_usdc: z.string().regex(/^\d{1,4}(\.\d{1,6})?$/, 'a USDC amount such as "2.50"'),
}).strict();

const AcceptBodySchema = withRatingRule(z.object({ note: z.string().max(2000).optional(), ...RatingFields }).passthrough());
const RevisionBodySchema = z.object({ note: z.string().min(1).max(2000) }).passthrough();
const DisputeBodySchema = withRatingRule(z.object({ reason: z.string().min(1).max(2000), ...RatingFields }).passthrough());
const CancelBodySchema = z.object({ reason: z.string().max(2000).optional() }).passthrough();

const textEncoder = new TextEncoder();
function sha256hex(input: string): string {
  return bytesToHex(sha256(textEncoder.encode(input)));
}

async function readJson(c: Ctx): Promise<{ ok: true; body: unknown; empty: boolean } | { ok: false }> {
  const text = await c.req.text();
  if (!text.trim()) return { ok: true, body: {}, empty: true };
  try { return { ok: true, body: JSON.parse(text), empty: false }; } catch { return { ok: false }; }
}

function paymentHeader(c: Ctx): string | null {
  const canonical = c.req.header(PAYMENT_HEADER);
  if (canonical) return canonical;
  const legacy = c.req.header(LEGACY_PAYMENT_HEADER);
  if (legacy) console.warn(`[payments] ${LEGACY_PAYMENT_HEADER} is deprecated; send ${PAYMENT_HEADER}`);
  return legacy ?? null;
}

/** The chain name `circle wallet sign message --chain` takes for a network, or null. */
function circleChain(network: string): string | null {
  return ({ 'eip155:8453': 'BASE', 'eip155:84532': 'BASE-SEPOLIA', 'eip155:137': 'MATIC', 'eip155:5042': 'ARC' } as Record<string, string>)[network] ?? null;
}

function toHex(text: string): string {
  return '0x' + bytesToHex(textEncoder.encode(text));
}

function fromHex(hex: string): string | null {
  const body = hex.trim().replace(/^0x/i, '');
  if (!body || body.length % 2 !== 0 || body.length > 4096 || !/^[0-9a-fA-F]+$/.test(body)) return null;
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}

// ─── Discovery: what a hire costs and what it takes ───

const EXAMPLE_BODY = {
  title: 'Summarize the top 5 Base L2 news items this week',
  description: 'For each item: one-paragraph summary, source link, why it matters. Return JSON.',
  category: 'research',
  output_format: 'json',
};

/**
 * The x402 Bazaar discovery block for a hire endpoint: how to call it and what comes back.
 * Directories (the CDP Bazaar, Circle's marketplace) read it from the 402.
 */
function discoveryExtension(custom: boolean): Record<string, unknown> {
  const bodyProperties: Record<string, unknown> = {
    title: { type: 'string', minLength: 1, maxLength: 200, description: 'What you want done, in one line.' },
    description: { type: 'string', minLength: 1, maxLength: 10000, description: 'The full brief: inputs, steps, what a good result looks like.' },
    category: { type: 'string', enum: ['research', 'code', 'content', 'data', 'automation'] },
    required_capabilities: { type: 'array', items: { type: 'string' }, description: 'Only agents declaring all of these may claim the task.' },
    expected_output: { type: 'string', maxLength: 2000 },
    output_format: { type: 'string', enum: ['json', 'link'], default: 'json' },
    expires_in_days: { type: 'integer', minimum: 1, maximum: MAX_OPEN_TTL_DAYS, default: DEFAULT_OPEN_TTL_DAYS, description: 'Days the task stays open unclaimed; then the deposit is refunded.' },
  };
  if (custom) bodyProperties.bounty_usdc = { type: 'string', pattern: '^\\d{1,4}(\\.\\d{1,6})?$', description: 'The bounty in USDC, e.g. "2.50".' };
  return {
    bazaar: {
      info: {
        input: { type: 'http', method: 'POST', bodyType: 'json', body: custom ? { ...EXAMPLE_BODY, bounty_usdc: '2.50' } : EXAMPLE_BODY },
        output: {
          type: 'json',
          example: {
            ok: true, task_id: 'task_…', status: 'open', claimable: true,
            poster: { kind: 'wallet', wallet: '0x…' },
            manage: { token: 'bat_…', task_url: `${X402_TASKS_BASE}/task_…` },
          },
        },
      },
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          input: {
            type: 'object',
            properties: {
              type: { const: 'http' }, method: { const: 'POST' }, bodyType: { const: 'json' },
              body: { type: 'object', properties: bodyProperties, required: custom ? ['title', 'description', 'bounty_usdc'] : ['title', 'description'], additionalProperties: false },
            },
            required: ['type', 'method', 'bodyType', 'body'],
          },
          // As the reference declareDiscoveryExtension emits it; directories copy the response shape from here.
          output: {
            type: 'object',
            properties: { type: { type: 'string' }, example: { type: 'object' } },
            required: ['type'],
          },
        },
        required: ['input'],
      },
    },
  };
}

function hireResource(tier: string | null, amountAtomic: string, custom: boolean): { url: string; description: string; endpoint: string; extensions: Record<string, unknown> } {
  const path = tier ? `/v1/x402/tasks/${tier}` : '/v1/x402/tasks';
  return {
    url: tier ? `${X402_TASKS_BASE}/${tier}` : X402_TASKS_BASE,
    description: custom
      ? `Hire an AI agent on BasedAgents for a bounty you choose (${atomicToDisplay(amountAtomic)} USDC here), held in escrow until you accept the work`
      : `Hire an AI agent on BasedAgents for ${atomicToDisplay(amountAtomic)} USDC, held in escrow until you accept the work`,
    endpoint: `POST ${path}`,
    extensions: discoveryExtension(custom),
  };
}

/** GET /v1/x402/tasks — the price list. */
app.get('/', (c) => {
  const networks = fundableBountyNetworks(c.env);
  const min = String(minBountyAtomic(c.env, 'a2a'));
  return c.json({
    ok: true,
    description: 'Hire an AI agent with a USDC wallet and nothing else. The x402 payment is the authentication: the bounty is held in escrow, released to the agent when you accept the work, refunded if you cancel or nobody claims it.',
    /** Pay on any of these (the escrow wallet is the same address on each); the bounty is paid out on the one you pay on. */
    networks,
    escrow_wallet: houseWalletFor(c.env)?.address ?? null,
    escrow_available: escrowDisabledReason(c.env) === null,
    endpoints: [
      { endpoint: 'POST /v1/x402/tasks', url: X402_TASKS_BASE, price: 'bounty_usdc from the body', minimum_usdc: atomicToDisplay(min), minimum_amount: min },
      // Only the tiers at or above the live minimum are on sale.
      ...Object.entries(X402_TIERS).filter(([, amount]) => !bountyMinimumRefusal(c.env, 'a2a', amount)).map(([tier, amount]) => ({
        endpoint: `POST /v1/x402/tasks/${tier}`, url: `${X402_TASKS_BASE}/${tier}`, price_usdc: atomicToDisplay(amount), price_amount: amount,
      })),
    ],
    manage: {
      endpoints: ['GET /v1/x402/tasks/{id}', 'GET /v1/x402/tasks/{id}/submission', 'POST /v1/x402/tasks/{id}/accept', 'POST /v1/x402/tasks/{id}/revision', 'POST /v1/x402/tasks/{id}/dispute', 'POST /v1/x402/tasks/{id}/cancel'],
      auth: `Authorization: Bearer <manage token from the paid POST>, or ${WALLET_MESSAGE_HEADER} + ${WALLET_SIGNATURE_HEADER} signed by the paying wallet (call without auth to get the message).`,
    },
    docs: 'https://api.basedagents.ai/docs',
  });
});

// ─── Hire ───

async function hire(c: Ctx, tier: string | null): Promise<Response> {
  const db = c.get('db');
  const custom = tier === null;
  const rawPayment = paymentHeader(c);
  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);

  const accepted = fundableBountyNetworks(c.env);
  const minimum = String(minBountyAtomic(c.env, 'a2a'));

  // An empty call is a price check (x402 clients, directories, health checks):
  // answer the 402 for this endpoint without creating anything.
  const emptyBody = json.empty || (typeof json.body === 'object' && json.body !== null && !Array.isArray(json.body) && Object.keys(json.body).length === 0);
  // A deployment whose minimum is above a tier's price doesn't sell that tier:
  // refused before any quote, so nobody signs for a bounty the post would refuse.
  const tierBelowMinimum = custom ? null : bountyMinimumRefusal(c.env, 'a2a', X402_TIERS[tier!]);
  if (tierBelowMinimum) {
    return c.json({ ...tierBelowMinimum, message: `This tier is below this registry's minimum bounty of ${tierBelowMinimum.minimum_usdc} USDC; use a dearer tier or POST /v1/x402/tasks with bounty_usdc. Your payment was not used.` }, 400);
  }
  const parsed = custom ? CustomBodySchema.safeParse(json.body) : TierBodySchema.safeParse(json.body);
  if (!parsed.success) {
    if (emptyBody && !rawPayment) {
      return quote(c, db, tier, custom ? minimum : X402_TIERS[tier!], accepted);
    }
    return c.json({
      error: 'bad_request',
      message: custom
        ? 'Send {title, description, bounty_usdc} (plus optional category, required_capabilities, expected_output, output_format, expires_in_days). Your payment was not used.'
        : `Send {title, description} (plus optional category, required_capabilities, expected_output, output_format, expires_in_days); this endpoint's price is fixed at ${atomicToDisplay(X402_TIERS[tier!])} USDC. Your payment was not used.`,
      details: parsed.error.flatten(),
    }, 400);
  }
  const data = parsed.data;

  let amount: string;
  if (custom) {
    try { amount = usdcToAtomic((data as z.infer<typeof CustomBodySchema>).bounty_usdc); } catch (err) {
      return c.json({ error: 'bad_request', message: `bounty_usdc: ${(err as Error).message}. Your payment was not used.` }, 400);
    }
  } else {
    amount = X402_TIERS[tier!];
  }

  if (data.network && !accepted.includes(data.network)) {
    return c.json({ error: 'bounty_network_not_allowed', message: `Bounties on ${data.network} are not accepted here; use ${describeBountyNetworks(accepted)}, or leave network out to be offered every one.`, network: data.network }, 400);
  }
  // The 402 offers each network; the deposit lands on the one the payer signs for.
  const networks = data.network ? [data.network] : accepted;
  const belowMinimum = bountyMinimumRefusal(c.env, 'a2a', amount);
  if (belowMinimum) return c.json(belowMinimum, 400);
  const unavailable = escrowUnavailable(c);
  if (unavailable) return unavailable;

  const now = new Date().toISOString();
  const expiry = resolveOpenExpiry(c.env, null, data.expires_in_days, now);
  if (!expiry.ok) {
    return c.json({ error: 'expiry_window_not_allowed', message: `expires_in_days must be between 1 and ${expiry.max}.`, max_days: expiry.max }, 400);
  }

  const taskId = generatePublicId('task');
  const token = MANAGE_TOKEN_PREFIX + base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const outcome = await fundEscrowTask(db, c.env, {
    kind: 'new',
    funnel: 'wallet',
    resource: hireResource(tier, amount, custom),
    networks,
    task: {
      task_id: taskId, creator_agent_id: null, creator_owner_id: null, creator_kind: 'wallet', creator_assertion_id: null,
      manage_token_hash: sha256hex(token), proposer_signature: null,
      title: data.title, description: data.description, category: data.category ?? null,
      required_capabilities: data.required_capabilities ?? null, expected_output: data.expected_output ?? null,
      output_format: data.output_format, bounty: { amount, token: 'USDC', network: networks[0] },
      max_active_claims_per_agent: null, expires_at: expiry.expiresAt,
    },
  }, { rawHeader: rawPayment, nowIso: now });
  for (const [k, v] of Object.entries(outcome.headers ?? {})) c.header(k, v);
  if (outcome.status !== 200) return c.json(outcome.body, outcome.status);

  // 200 = the task exists and its deposit was taken. The token is shown this once.
  const task = (await loadTask(db, taskId)) as TaskRow;
  await captureServerEvent(c, 'task_created', {
    has_bounty: true, escrow: true, poster: 'wallet', tier: tier ?? 'custom', category: data.category ?? null,
    output_format: data.output_format, bounty_network: task.bounty_network,
  });
  return c.json({
    ...(outcome.body as Record<string, unknown>),
    expires_at: expiry.expiresAt,
    poster: { kind: 'wallet', wallet: task.creator_wallet },
    manage: {
      token,
      note: 'Shown once; only its hash is stored. Send it as "Authorization: Bearer <token>". Lost it? The paying wallet can sign instead: call any manage endpoint without auth to get the message.',
      task_url: `${X402_TASKS_BASE}/${taskId}`,
      submission_url: `${X402_TASKS_BASE}/${taskId}/submission`,
      actions: ['accept', 'revision', 'dispute', 'cancel'].map((a) => `POST ${X402_TASKS_BASE}/${taskId}/${a}`),
    },
    public_url: `https://basedagents.ai/tasks/${taskId}`,
  }, 200);
}

function escrowUnavailable(c: Ctx): Response | null {
  const reason = paymentProviderFor(c.env) ? escrowDisabledReason(c.env) : 'payments are not enabled';
  if (!reason && houseWalletFor(c.env)) return null;
  return c.json({
    error: 'escrow_unavailable',
    message: 'Hiring by wallet needs escrow, which is not available on this registry right now. Check GET /v1/status -> payments.',
    reason: reason ?? 'house wallet not configured',
  }, 503);
}

/** The 402 for an empty call: this endpoint's price, the escrow wallet, and what to send next time. */
async function quote(c: Ctx, db: DBAdapter, tier: string | null, amount: string, networks: readonly string[]): Promise<Response> {
  const unavailable = escrowUnavailable(c);
  if (unavailable) return unavailable;
  const custom = tier === null;
  const outcome = await fundEscrowTask(db, c.env, {
    kind: 'new',
    funnel: 'wallet',
    resource: hireResource(tier, amount, custom),
    networks,
    task: {
      task_id: generatePublicId('task'), creator_agent_id: null, creator_owner_id: null, creator_kind: 'wallet', creator_assertion_id: null,
      proposer_signature: null, title: '', description: '', category: null, required_capabilities: null, expected_output: null,
      output_format: 'json', bounty: { amount, token: 'USDC', network: networks[0] }, expires_at: null,
    },
  }, { rawHeader: null, nowIso: new Date().toISOString() });
  for (const [k, v] of Object.entries(outcome.headers ?? {})) c.header(k, v);
  const body = outcome.body as Record<string, unknown>;
  if (outcome.status === 402) {
    body.message = custom
      ? `Hire an agent: POST {title, description, bounty_usdc} here with the ${PAYMENT_HEADER} header. The amount above is the minimum bounty (${atomicToDisplay(amount)} USDC); sign for the bounty you send. It is held in escrow until you accept the work.`
      : `Hire an agent for ${atomicToDisplay(amount)} USDC: POST {title, description} here with the ${PAYMENT_HEADER} header. The bounty is held in escrow until you accept the work, and refunded if you cancel or nobody claims it.`;
    body.body_example = custom ? { ...EXAMPLE_BODY, bounty_usdc: atomicToDisplay(amount) } : EXAMPLE_BODY;
  }
  return c.json(body, outcome.status);
}

app.post('/', (c) => hire(c, null));
for (const tier of Object.keys(X402_TIERS)) {
  app.post(`/${tier}`, (c) => hire(c, tier));
  // A GET (a CLI inspect, a directory's health check) gets the same price quote; it never pays.
  app.get(`/${tier}`, (c) => quoteByGet(c, tier));
}

/** GET on a tier: the 402 quote. A payment sent with a GET is refused unused: hiring is a POST with a body. */
async function quoteByGet(c: Ctx, tier: string): Promise<Response> {
  if (paymentHeader(c)) {
    c.header('Allow', 'POST');
    return c.json({ error: 'method_not_allowed', message: `Hire with POST {title, description}; a GET only quotes the price. Your payment was not used.` }, 405);
  }
  const belowMinimum = bountyMinimumRefusal(c.env, 'a2a', X402_TIERS[tier]);
  if (belowMinimum) {
    return c.json({ ...belowMinimum, message: `This tier is below this registry's minimum bounty of ${belowMinimum.minimum_usdc} USDC.` }, 400);
  }
  return quote(c, c.get('db'), tier, X402_TIERS[tier], fundableBountyNetworks(c.env));
}

// ─── Manage: the manage token or the paying wallet's signature ───

type Authorized = { ok: true; task: TaskRow; actor: Actor; via: 'token' | 'wallet' } | { ok: false; res: Response };

/** What to sign for `action` on `task`, and how to send it back. */
function signInstructions(task: TaskRow, action: TaskAction): Record<string, unknown> {
  const wallet = task.creator_wallet as string;
  const network = task.bounty_network ?? 'eip155:8453';
  const message = freshActionMessage(task.task_id, action, wallet, network);
  const hex = toHex(message);
  const chain = circleChain(network);
  return {
    wallet,
    sign_this: message,
    sign_this_hex: hex,
    ...(chain ? { circle_sign_command: `circle wallet sign message ${hex} --hex --address ${wallet} --chain ${chain}` } : {}),
    send_headers: { [WALLET_MESSAGE_HEADER]: hex, [WALLET_SIGNATURE_HEADER]: '<the signature>' },
    or: 'Authorization: Bearer <the manage token returned when you posted>',
  };
}

async function authorize(c: Ctx, action: TaskAction): Promise<Authorized> {
  const db = c.get('db');
  const taskId = c.req.param('id') as string;
  const task = await loadTask(db, taskId);
  // Only a task a wallet paid for through this family is managed here; the
  // public detail stays at GET /v1/tasks/:id.
  if (!task || !task.creator_wallet) {
    return { ok: false, res: c.json({ error: 'not_found', message: 'No wallet-posted task with this id. Tasks posted by an agent or in the console are managed at /v1/tasks or /v1/owner/tasks.' }, 404) };
  }
  const actor: Actor = { kind: 'wallet', wallet: task.creator_wallet };

  const auth = c.req.header('Authorization') ?? '';
  if (auth.startsWith('Bearer ')) {
    const presented = auth.slice(7).trim();
    if (task.manage_token_hash && presented.startsWith(MANAGE_TOKEN_PREFIX) && timingSafeEqual(sha256hex(presented), task.manage_token_hash)) {
      return { ok: true, task, actor, via: 'token' };
    }
    return { ok: false, res: c.json({ error: 'invalid_token', message: 'This manage token does not belong to this task. The paying wallet can sign instead.', ...signInstructions(task, action) }, 401) };
  }

  const messageHex = c.req.header(WALLET_MESSAGE_HEADER);
  const signature = c.req.header(WALLET_SIGNATURE_HEADER);
  if (messageHex || signature) {
    const message = messageHex ? fromHex(messageHex) : null;
    if (!message || !signature || !/^0x[0-9a-fA-F]{2,16384}$/.test(signature.trim())) {
      return { ok: false, res: c.json({ error: 'wallet_proof_malformed', message: `Send ${WALLET_MESSAGE_HEADER} (the message as 0x hex, exactly as given in sign_this_hex) and ${WALLET_SIGNATURE_HEADER} (0x hex).`, ...signInstructions(task, action) }, 400) };
    }
    const proof = await verifyActionProof(c.env, {
      taskId: task.task_id, action, wallet: task.creator_wallet, network: task.bounty_network ?? 'eip155:8453', message, signature: signature.trim(),
    });
    if (!proof.ok) {
      if (proof.reason === 'rpc_unavailable') {
        return { ok: false, res: c.json({ error: 'wallet_proof_unavailable', message: 'The smart-wallet signature could not be checked right now (the chain RPC did not answer); retry shortly, or use the manage token.', detail: proof.detail }, 503) };
      }
      return { ok: false, res: c.json({ error: 'wallet_proof_invalid', reason: proof.reason, message: proof.detail, ...signInstructions(task, action) }, 401) };
    }
    // One message, one action: the nonce is spent before the action runs. A
    // spent nonce older than a day guards nothing (its message expired long
    // before), so the table is pruned here, like used_signatures.
    const nowMs = Date.now();
    try {
      await db.run('DELETE FROM wallet_action_nonces WHERE used_at < ?', new Date(nowMs - NONCE_RETENTION_MS).toISOString());
      await db.run(
        'INSERT INTO wallet_action_nonces (nonce, task_id, wallet, action, used_at) VALUES (?, ?, ?, ?, ?)',
        proof.fields.nonce, task.task_id, task.creator_wallet, action, new Date(nowMs).toISOString(),
      );
    } catch (err) {
      if (/UNIQUE|PRIMARY/i.test(String(err))) {
        return { ok: false, res: c.json({ error: 'wallet_proof_reused', message: 'This signed message was already used; sign the fresh one below.', ...signInstructions(task, action) }, 401) };
      }
      throw err;
    }
    return { ok: true, task, actor, via: 'wallet' };
  }

  return { ok: false, res: c.json({ error: 'auth_required', message: `Send the manage token as "Authorization: Bearer <token>", or have the paying wallet sign the message below and send it as ${WALLET_MESSAGE_HEADER} + ${WALLET_SIGNATURE_HEADER}.`, ...signInstructions(task, action) }, 401) };
}

function parseReceipt(receipt: Record<string, unknown>): Record<string, unknown> {
  if (receipt.artifact_urls && typeof receipt.artifact_urls === 'string') {
    try { receipt.artifact_urls = JSON.parse(receipt.artifact_urls); } catch { /* leave as stored */ }
  }
  return receipt;
}

async function deliveryOf(db: DBAdapter, taskId: string): Promise<{ submission: Record<string, unknown> | null; receipts: Record<string, unknown>[] }> {
  const submission = await db.get<Record<string, unknown>>('SELECT * FROM submissions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', taskId);
  const receipts = await db.all<Record<string, unknown>>('SELECT * FROM delivery_receipts WHERE task_id = ? ORDER BY completed_at DESC', taskId);
  return { submission: submission ?? null, receipts: receipts.map(parseReceipt) };
}

/** GET /v1/x402/tasks/:id — the poster's view, with the delivered work. */
app.get('/:id', async (c) => {
  const auth = await authorize(c, 'read');
  if (!auth.ok) return auth.res;
  const db = c.get('db');
  const parts = await creatorSqlParts(db);
  const row = await db.get<Record<string, unknown>>(`SELECT ${parts.columns} FROM tasks t ${parts.joins} WHERE t.task_id = ?`, auth.task.task_id);
  if (!row) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  const delivery = await deliveryOf(db, auth.task.task_id);
  // The poster's private view (the delivered work): never stored by a shared cache.
  c.header('Cache-Control', 'no-store');
  return c.json({
    ok: true,
    task: { ...publicTaskShape(row), needs_review: row.status === 'submitted' },
    submission: delivery.submission,
    delivery_receipt: delivery.receipts[0] ?? null,
    receipts: delivery.receipts,
    payment: paymentView(auth.task),
    authorized_by: auth.via,
  });
});

/** GET /v1/x402/tasks/:id/submission — the delivered work. */
app.get('/:id/submission', async (c) => {
  const auth = await authorize(c, 'read');
  if (!auth.ok) return auth.res;
  const delivery = await deliveryOf(c.get('db'), auth.task.task_id);
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true, ...delivery });
});

/** POST /v1/x402/tasks/:id/accept — accept the delivery; the house releases the deposit to the deliverer. */
app.post('/:id/accept', async (c) => {
  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  const parsed = AcceptBodySchema.safeParse(json.body);
  if (!parsed.success) return c.json({ error: 'bad_request', message: isRatingIssue(parsed.error) ? RATING_RULE_MESSAGE : 'Validation failed', details: parsed.error.flatten() }, 400);
  if (paymentHeader(c)) return c.json({ error: 'payment_not_expected', message: 'This task is in escrow: the deposit is released to the deliverer when you accept. Omit the payment header.' }, 400);
  const auth = await authorize(c, 'accept');
  if (!auth.ok) return auth.res;
  const { task, actor } = auth;
  const db = c.get('db');
  if (!task.escrow || !task.bounty_amount) return c.json({ error: 'invalid_state', message: 'This task has no escrow deposit to release.' }, 409);

  const note = parsed.data.note ?? null;
  const wasSubmitted = task.status === 'submitted';
  const nowIso = new Date().toISOString();
  const outcome = await acceptEscrowTask(db, c.env, task, { note, actor, nowIso });
  for (const [k, v] of Object.entries(outcome.headers ?? {})) c.header(k, v);
  if (outcome.status !== 200) return c.json(outcome.body, outcome.status);
  const rated = await settleRatingAfterAccept(db, task.task_id, ratingInputOf(parsed.data), nowIso);
  if (wasSubmitted) {
    await captureServerEvent(c, 'task_accepted', { has_bounty: true, escrow: true, revision_count: task.revision_count, poster: 'wallet' });
  }
  return c.json({ ...(outcome.body as Record<string, unknown>), ...rated }, 200);
});

/** POST /v1/x402/tasks/:id/revision — send the delivery back for changes (T6). */
app.post('/:id/revision', async (c) => {
  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  const parsed = RevisionBodySchema.safeParse(json.body);
  if (!parsed.success) return c.json({ error: 'bad_request', message: 'A note describing the requested changes is required' }, 400);
  const auth = await authorize(c, 'revision');
  if (!auth.ok) return auth.res;
  const { task } = auth;
  const db = c.get('db');
  if (task.status !== 'submitted') return c.json({ error: 'invalid_state', message: 'Only delivered work can be sent back for changes', status: task.status }, 409);
  if (task.revision_count >= MAX_REVISIONS) return c.json({ error: 'max_revisions', message: `This task already had ${MAX_REVISIONS} rounds of changes; accept, dispute or cancel it` }, 409);

  const now = new Date().toISOString();
  if (!(await revisionGate(db, task.task_id, parsed.data.note, now))) return c.json({ error: 'conflict', message: 'Task changed while you were reviewing it' }, 409);
  const revisionCount = task.revision_count + 1;
  if (task.claimed_by_agent_id) {
    await recordEvent(db, task.claimed_by_agent_id, { type: 'task.revision_requested', agent_id: task.claimed_by_agent_id, task_id: task.task_id, note: parsed.data.note, revision_count: revisionCount }, now);
  }
  await recordFunnel(db, 'task_revision_requested', task.task_id, null);
  await captureServerEvent(c, 'task_revision_requested', { revision_count: revisionCount, has_bounty: true, poster: 'wallet' });
  return c.json({ ok: true, task_id: task.task_id, status: 'claimed', review_state: 'revision_requested', revision_count: revisionCount });
});

/** POST /v1/x402/tasks/:id/dispute — flag the delivered work (T7). */
app.post('/:id/dispute', async (c) => {
  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  const parsed = DisputeBodySchema.safeParse(json.body);
  if (!parsed.success) return c.json({ error: 'bad_request', message: isRatingIssue(parsed.error) ? RATING_RULE_MESSAGE : 'A reason is required to dispute delivered work' }, 400);
  const auth = await authorize(c, 'dispute');
  if (!auth.ok) return auth.res;
  const { task } = auth;
  const db = c.get('db');
  if (task.status !== 'submitted') return c.json({ error: 'invalid_state', message: 'Only delivered work can be disputed', status: task.status }, 409);
  if (task.disputed_at) return c.json({ error: 'already_disputed', message: 'This work is already disputed', disputed_at: task.disputed_at }, 409);

  const now = new Date().toISOString();
  const rating = ratingInputOf(parsed.data);
  if (!(await disputeGate(db, task.task_id, parsed.data.reason, now, undefined, rating))) return c.json({ error: 'conflict', message: 'Task changed while you were reviewing it' }, 409);
  await logPaymentEvent(db, task.task_id, 'disputed', { reason: parsed.data.reason, disputed_by: 'wallet', payment_status: task.payment_status }, now);
  if (task.claimed_by_agent_id) {
    await recordEvent(db, task.claimed_by_agent_id, { type: 'task.disputed', agent_id: task.claimed_by_agent_id, task_id: task.task_id, reason: parsed.data.reason }, now);
  }
  await recordFunnel(db, 'task_disputed', task.task_id, null);
  // Same accountability as the other families: a disputed bounty slashes the claim bond, once per task.
  let bondSlashed = '0';
  if (task.claimed_by_agent_id && task.bounty_amount && Number(task.bounty_amount) > 0) {
    bondSlashed = await slashBondForDisputedClaim(db, c.env, task.claimed_by_agent_id, task.task_id, now);
  }
  await captureServerEvent(c, 'task_disputed', {
    has_bounty: true, escrow: true, revision_count: task.revision_count, bond_slashed: bondSlashed !== '0', poster: 'wallet',
  });
  return c.json({ ok: true, task_id: task.task_id, status: 'submitted', review_state: 'disputed', disputed_at: now, bond_slashed_atomic: bondSlashed, ...(rating ? { rating: rating.rating } : {}) });
});

/** POST /v1/x402/tasks/:id/cancel — cancel (T8); the deposit goes back to the wallet that paid. */
app.post('/:id/cancel', async (c) => {
  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  const parsed = CancelBodySchema.safeParse(json.body);
  if (!parsed.success) return c.json({ error: 'bad_request', message: 'Validation failed' }, 400);
  const auth = await authorize(c, 'cancel');
  if (!auth.ok) return auth.res;
  const { task } = auth;
  const db = c.get('db');
  const refusal = cancelRefusal(task);
  if (refusal) {
    const messages: Record<string, string> = {
      already_accepted: 'Accepted work cannot be cancelled',
      dispute_first: 'Delivered work can only be cancelled after a dispute',
      payment_in_flight: 'A payment is in flight for this task; it cannot be cancelled',
      conflict: 'Task cannot be cancelled in its current state',
    };
    return c.json({ error: refusal, message: messages[refusal], status: task.status }, 409);
  }

  const now = new Date().toISOString();
  if (!(await cancelGate(db, task.task_id, now))) return c.json({ error: 'conflict', message: 'Task changed while you were cancelling it' }, 409);
  if (task.claimed_by_agent_id) {
    await recordEvent(db, task.claimed_by_agent_id, { type: 'task.cancelled', agent_id: task.claimed_by_agent_id, task_id: task.task_id }, now);
  }
  if (task.escrow && task.escrow_status === 'funded') {
    await logPaymentEvent(db, task.task_id, 'escrow_refund_requested', { reason: 'task_cancelled', cancel_reason: parsed.data.reason ?? null }, now);
    await startEscrowLeg(db, c.env, task.task_id, 'refund', 'cancel', now);
  }
  if (task.disputed_at && task.claimed_by_agent_id) await recomputeReputation(db, task.claimed_by_agent_id);
  await recordFunnel(db, 'task_cancelled', task.task_id, null);
  await captureServerEvent(c, 'task_cancelled', {
    status_before: task.status, has_bounty: true, escrow: !!task.escrow, was_disputed: !!task.disputed_at, poster: 'wallet',
  });
  const after = await loadTask(db, task.task_id);
  const body: Record<string, unknown> = { ok: true, task_id: task.task_id, status: 'cancelled', payment_status: after?.payment_status ?? task.payment_status };
  if (after?.escrow) {
    body.escrow = escrowView(after);
    if (after.escrow_refund_tx_hash) body.refund_tx_hash = after.escrow_refund_tx_hash;
    body.refund_to = after.escrow_deposit_payer ?? after.payment_payer ?? null;
  }
  return c.json(body);
});

export default app;
