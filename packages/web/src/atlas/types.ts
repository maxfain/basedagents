/**
 * Agent Atlas content types — the import shape of the content package in
 * ./content (data/entities.json and content/*.json). The JSON is the source of
 * truth; these types describe it, they do not reshape it.
 */

export type ProfileDepth = 'directory_entry' | 'expanded_profile' | 'protocol_profile';

export interface AtlasSource {
  url: string;
  observed_at: string;
  evidence_status: string;
}

export interface AtlasEvidence {
  evidence_id: string;
  url: string;
  source_kind: string;
  retrieved_on: string;
  published_on: string | null;
  summary: string;
}

/**
 * A sourced detail. Older (enriched) facts cite `evidence_ids` from the same
 * entity's `evidence` array; newer facts cite `source_urls` directly. Both
 * forms are supported everywhere a fact is rendered.
 */
export interface AtlasFact {
  path: string;
  value: unknown;
  status: string;
  evidence_ids?: string[];
  source_urls?: string[];
  note?: string | null;
  scope?: { description?: string; [k: string]: unknown };
}

export interface PricingSummary {
  summary: string;
  source_url: string;
  observed_at: string;
  status: string;
  currency: string;
  not_cost_per_task: boolean;
}

export type AtlasPricing = PricingSummary | { facts: AtlasFact[] } | null;

export interface EditorialItem {
  label: string;
  text: string;
  evidence_ids?: string[];
}

export interface AtlasPerson {
  name: string;
  role: string;
}

export interface AtlasEntity {
  id: string;
  name: string;
  slug: string;
  route: string;
  entity_type: string;
  website_url: string | null;
  discovery_url: string | null;
  repository_url: string | null;
  source_category: string;
  category_id: string;
  description: string;
  description_status: string;
  sources: AtlasSource[];
  /** Internal research identifier — never rendered as an external registry id. */
  source_candidate_id: string | null;
  identity_status: string;
  evidence_note: string | null;
  version_note: string | null;
  facts: AtlasFact[];
  evidence: AtlasEvidence[];
  people: AtlasPerson[] | null;
  funding: { value: Record<string, unknown>; note: string | null; evidence_ids: string[] } | null;
  pricing: AtlasPricing;
  stated_goal: string | null;
  runtime_tested: boolean;
  security_audited: boolean;
  payment_tested: boolean;
  profile_depth: ProfileDepth;
  publication_state: string;
  indexable: boolean;
  editorial_inference: EditorialItem[] | null;
  reviewed_at: string;
  unknown_fields: string[];
  related_ids: string[];
  seo: { title: string; description: string; canonical: string; robots: string };
  product_ids?: string[];
  operator_id?: string;
}

export interface AtlasCategory {
  id: string;
  route: string;
  title: string;
  intro: string;
  buyer_guidance: string;
  content_status: string;
  entity_ids: string[];
  seo_title: string;
  meta_description: string;
  indexable: boolean;
  publication_state: string;
}

export interface AtlasProtocol {
  entity_id: string;
  route: string;
  title: string;
  layer: string;
  answer: string;
  limitations: string;
  implementation_checklist: string[];
  version_note: string | null;
  sources: AtlasSource[];
  editorial_status: string;
  related_ids: string[];
}

export interface AtlasGuide {
  id: string;
  route: string;
  title: string;
  category_id: string;
  content_status: string;
  intro: string;
  inputs: string;
  deliverable: string;
  steps: string[];
  approval_boundary: string;
  acceptance_criteria: string;
  failure_modes: string;
  candidate_ids: string[];
  candidate_relationship: string;
  sources: string[];
  publication_state: string;
  indexable: boolean;
}

export interface AtlasComparison {
  id: string;
  route: string;
  title: string;
  answer: string;
  entity_ids: string[];
  decision_questions: string[];
  conclusion: string;
  status: string;
  indexable: boolean;
  sources: string[];
}

export interface AtlasGlossaryTerm {
  id: string;
  term: string;
  definition: string;
  status: string;
}

export interface AtlasFaq {
  id: string;
  question: string;
  answer: string;
  status: string;
  source_urls: string[];
}

export interface AtlasStaticPage {
  route: string;
  title: string;
  body: string[];
  form_fields?: string[];
  success_copy?: string;
  implementation_note?: string;
}

export interface AtlasRelationship {
  from: string;
  to: string;
  type: string;
  status: string;
  sources?: string[];
}

export interface AtlasBacklogItem {
  entity_id: string;
  priority: string;
  required_checks: string[];
  sources_to_start_with: string[];
}

export interface AtlasSiteCopy {
  brand: string;
  product_name: string;
  base_url: string;
  content_as_of: string;
  content_notice: string;
  navigation: { label: string; href: string }[];
  homepage: {
    route: string;
    title: string;
    subtitle: string;
    search_placeholder: string;
    primary_cta: { label: string; href: string };
    secondary_cta: { label: string; href: string };
    sections: { heading: string; body: string }[];
  };
  ui: {
    empty_search: string;
    missing_value: string;
    vendor_documented: string;
    source_summary: string;
    not_tested: string;
    draft: string;
    related_heading: string;
    related_note: string;
    pricing_note: string;
    external_link: string;
    submit_cta: string;
    correction_cta: string;
  };
  filters: string[];
  disabled_filters_until_supported: string[];
  footer: string;
}

export interface AtlasLaunchManifest {
  default_mode: string;
  default_robots: string;
  approved_indexable_routes: string[];
  recommended_review_order: string[];
  never_auto_index: string;
  note: string;
}

export interface AtlasRouteEntry {
  route: string;
  type: 'static' | 'project' | 'category' | 'guide' | 'comparison';
}
