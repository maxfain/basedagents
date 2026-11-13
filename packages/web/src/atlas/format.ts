/**
 * Presentation helpers for atlas values. These only relabel and format what
 * the content package says — they never derive prices, totals or rankings.
 */

const ACRONYMS: Record<string, string> = {
  mcp: 'MCP', sdk: 'SDK', api: 'API', url: 'URL', usd: 'USD', gb: 'GB', cli: 'CLI', ide: 'IDE',
  erc: 'ERC', a2a: 'A2A', ai: 'AI', x402: 'x402', llm: 'LLM', id: 'ID', ibm: 'IBM', sms: 'SMS',
};

/** "first_party_page_observed" → "First-party page observed". */
export function humanize(raw: string): string {
  const s = raw
    .replace(/first_party/g, 'first-party')
    .replace(/third_party/g, 'third-party')
    .replace(/read_only/g, 'read-only')
    .replace(/[_.]+/g, ' ')
    .trim();
  const words = s.split(/\s+/).map((w) => ACRONYMS[w.toLowerCase()] ?? w);
  const out = words.join(' ');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

const ENTITY_TYPE_LABELS: Record<string, string> = {
  organization: 'Organization',
  mcp_server: 'MCP server',
  protocol: 'Protocol',
  skill: 'Skill',
  skill_pack: 'Skill pack',
  agent_infrastructure: 'Agent infrastructure',
  marketplace: 'Marketplace',
  product: 'Product',
  agent_product: 'Agent product',
  directory: 'Directory',
  project: 'Project',
  agent_framework: 'Agent framework',
  registry: 'Registry',
  platform: 'Platform',
  nonprofit: 'Nonprofit',
  agent_platform: 'Agent platform',
  schema: 'Schema',
  sdk: 'SDK',
  tool: 'Tool',
  explorer: 'Explorer',
};

/** The supplied entity type, made readable — never re-typed as "company" or "agent". */
export const entityTypeLabel = (t: string): string => ENTITY_TYPE_LABELS[t] ?? humanize(t);

export const DEPTH_LABELS: Record<string, string> = {
  expanded_profile: 'Expanded profile',
  protocol_profile: 'Protocol profile',
  directory_entry: 'Directory entry',
};
export const depthLabel = (d: string): string => DEPTH_LABELS[d] ?? humanize(d);

const FACT_STATUS: Record<string, string> = {
  vendor_documented: 'Vendor-documented',
  third_party_documented: 'Third-party documented',
  unknown: 'Unknown',
};
export const factStatusLabel = (s: string): string => FACT_STATUS[s] ?? humanize(s);

const IDENTITY_STATUS: Record<string, string> = {
  candidate_not_fully_resolved: 'Candidate record; identity not fully resolved',
  upstream_unresolved: 'Registry listing only; upstream project not resolved',
  official_sources_inspected: 'Official sources inspected',
};
export const identityStatusLabel = (s: string): string => IDENTITY_STATUS[s] ?? humanize(s);

const CONTENT_STATUS: Record<string, string> = {
  editorial_test_design_not_executed: 'Test design — not executed',
  editorial_draft_not_tested: 'Editorial draft — not tested',
  editorial_guidance: 'Editorial guidance',
  source_based_explanation_with_editorial_checklist: 'Source-based explanation with an editorial checklist',
  editorial_working_definition: 'Editorial working definition',
  editorial_policy_or_source_based_summary: 'Editorial policy or source-based summary',
  editorial_topic_relevance_not_verified_task_support: 'Editorial topic relevance — task support not verified',
  source_summary_not_runtime_tested: 'Source summary — not runtime-tested',
};
export const contentStatusLabel = (s: string): string => CONTENT_STATUS[s] ?? humanize(s);

const FACT_PATH_LABELS: Record<string, string> = {
  description: 'Description',
  capabilities: 'Capabilities',
  'capabilities.summary': 'Capabilities',
  deployment: 'Deployment',
  'software.license': 'License',
  operator: 'Operator',
  'autonomy.trigger': 'Triggers',
  'autonomy.merge_approval_policy': 'Merge approval policy',
  people: 'People',
  'organization.founding_year': 'Founding year',
  'funding.round': 'Announced funding round',
  'funding.operator_round': "Operator's announced funding round",
  stated_goal: 'Stated goal',
  evaluations: 'Independent evaluations',
  'interfaces.mcp': 'MCP interface',
  'interfaces.mcp.key_scope': 'MCP key scope',
  'interfaces.docs_mcp': 'Documentation MCP',
  'interfaces.execution_mcp': 'Execution integrations',
  'payments.x402_support': 'x402 support',
  'protocols.x402_support': 'x402 support',
  'pricing.plans': 'Plans',
  'pricing.browser': 'Browser time',
  'pricing.traffic': 'Traffic',
  'pricing.extra_costs': 'Extra costs',
  'pricing.free': 'Free plan',
  'pricing.developer': 'Developer plan',
  'pricing.startup': 'Startup plan',
  'pricing.enterprise': 'Enterprise plan',
};
export const factLabel = (path: string): string =>
  FACT_PATH_LABELS[path] ?? humanize(path.split('.').slice(-1)[0] ?? path);

const ROLE_LABELS: Record<string, string> = {
  documentation_read_only: 'Documentation only (read-only)',
};
export const roleLabel = (r: string): string => ROLE_LABELS[r] ?? humanize(r);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-11-13" → "November 13, 2026". Parsed by hand so the server and browser agree in every timezone. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** A documented amount in its own currency. Zero stays "$0" — a documented free price, never "unknown". */
export function formatMoney(amount: number, currency = 'USD'): string {
  const fraction = Number.isInteger(amount) ? 0 : 2;
  const n = amount.toLocaleString('en-US', { minimumFractionDigits: fraction, maximumFractionDigits: fraction });
  return currency === 'USD' ? `$${n}` : `${n} ${currency}`;
}

/** Host + path for a source link, without the scheme or a trailing slash. */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    const s = `${u.host.replace(/^www\./, '')}${path}`;
    return s.length > 64 ? `${s.slice(0, 61)}…` : s;
  } catch {
    return url;
  }
}

export function hostOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; }
}

/** Trim to a meta-description length on a word boundary. */
export function clip(s: string, max = 158): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:.\s]+$/, '')}…`;
}
