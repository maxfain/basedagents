-- PROPOSED PostgreSQL schema. No production migration has been executed.
-- All UUIDs here are internal atlas IDs. External IDs are separately namespaced.
BEGIN;
CREATE SCHEMA IF NOT EXISTS atlas;
CREATE TABLE atlas.entity (
 id uuid PRIMARY KEY, entity_type text NOT NULL, name text NOT NULL,
 slug text NOT NULL UNIQUE, canonical_url text NOT NULL,
 lifecycle text NOT NULL DEFAULT 'unknown', publication_status text NOT NULL DEFAULT 'research_candidate',
 operator_id uuid REFERENCES atlas.entity(id), language text,
 first_seen_at timestamptz NOT NULL, last_checked_at timestamptz,
 CHECK(publication_status IN ('research_candidate','in_review','published','historical','withdrawn'))
);
CREATE TABLE atlas.external_identity (
 id uuid PRIMARY KEY, namespace text NOT NULL, external_id text NOT NULL, entity_id uuid NOT NULL REFERENCES atlas.entity(id),
 valid_from timestamptz NOT NULL, valid_to timestamptz, CHECK(valid_to IS NULL OR valid_to >= valid_from)
);
CREATE TABLE atlas.alias (
 entity_id uuid REFERENCES atlas.entity(id), alias text NOT NULL, kind text NOT NULL,
 valid_from timestamptz, valid_to timestamptz, PRIMARY KEY(entity_id,alias,kind)
);
CREATE TABLE atlas.source (
 id uuid PRIMARY KEY, url text NOT NULL UNIQUE, source_kind text NOT NULL,
 access_policy jsonb NOT NULL DEFAULT '{}', reuse_policy jsonb NOT NULL DEFAULT '{}',
 attribution_template text, last_policy_checked_at timestamptz
);
CREATE TABLE atlas.observation (
 id uuid PRIMARY KEY, source_id uuid NOT NULL REFERENCES atlas.source(id),
 retrieved_at timestamptz NOT NULL, source_published_at timestamptz, source_updated_at timestamptz,
 content_hash text, source_version text, http_status integer, locator text,
 evidence_summary text NOT NULL, permitted_snapshot_uri text,
 collector_version text NOT NULL, completeness text NOT NULL DEFAULT 'unknown'
);
CREATE TABLE atlas.assertion (
 id uuid PRIMARY KEY, entity_id uuid NOT NULL REFERENCES atlas.entity(id),
 field_path text NOT NULL, value jsonb NOT NULL, epistemic_status text NOT NULL,
 scope jsonb NOT NULL DEFAULT '{}', valid_from timestamptz, valid_to timestamptz,
 review_state text NOT NULL DEFAULT 'unreviewed', reviewer text, reviewed_at timestamptz,
 supersedes_id uuid REFERENCES atlas.assertion(id), conflict_group uuid,
 CHECK(epistemic_status IN ('vendor_documented','primary_metadata','third_party_documented','technically_inspected','tested','transaction_observed','accepted_task','unknown','not_disclosed','not_applicable','conflicting','historical','editorial_inference'))
);
CREATE TABLE atlas.assertion_evidence (
 assertion_id uuid REFERENCES atlas.assertion(id), observation_id uuid REFERENCES atlas.observation(id),
 PRIMARY KEY(assertion_id,observation_id)
);
CREATE TABLE atlas.relationship (
 id uuid PRIMARY KEY, subject_id uuid NOT NULL REFERENCES atlas.entity(id),
 predicate text NOT NULL, object_id uuid NOT NULL REFERENCES atlas.entity(id),
 assertion_id uuid NOT NULL REFERENCES atlas.assertion(id), valid_from timestamptz, valid_to timestamptz
);
CREATE TABLE atlas.person_role (
 id uuid PRIMARY KEY, person_id uuid NOT NULL REFERENCES atlas.entity(id),
 organization_id uuid NOT NULL REFERENCES atlas.entity(id), role text NOT NULL,
 start_date date, end_date date, assertion_id uuid NOT NULL REFERENCES atlas.assertion(id)
);
CREATE TABLE atlas.capability (
 id uuid PRIMARY KEY, entity_id uuid NOT NULL REFERENCES atlas.entity(id),
 action text NOT NULL, object text NOT NULL, domain text, input_spec jsonb, output_spec jsonb,
 prerequisites jsonb, permissions jsonb, side_effects jsonb, autonomy jsonb,
 assertion_id uuid NOT NULL REFERENCES atlas.assertion(id)
);
CREATE TABLE atlas.interface (
 id uuid PRIMARY KEY, entity_id uuid NOT NULL REFERENCES atlas.entity(id),
 role text NOT NULL, protocol_entity_id uuid REFERENCES atlas.entity(id), protocol_version text,
 endpoint text, package_coordinate text, transport text, authentication jsonb, scopes jsonb,
 operator_id uuid REFERENCES atlas.entity(id), publisher_relationship text,
 assertion_id uuid NOT NULL REFERENCES atlas.assertion(id)
);
CREATE TABLE atlas.price_component (
 id uuid PRIMARY KEY, entity_id uuid NOT NULL REFERENCES atlas.entity(id),
 offering text NOT NULL, currency text, amount numeric, amount_qualifier text,
 billing_unit text, billing_interval text, allowances jsonb, usage_conditions jsonb,
 valid_from timestamptz, valid_to timestamptz, assertion_id uuid NOT NULL REFERENCES atlas.assertion(id),
 CHECK(amount IS NULL OR amount >= 0)
);
CREATE TABLE atlas.funding_event (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES atlas.entity(id),
 announcement_date date, round_type text, currency text, amount numeric,
 amount_qualifier text, investors jsonb, valuation numeric, valuation_basis text,
 assertion_id uuid NOT NULL REFERENCES atlas.assertion(id), CHECK(amount IS NULL OR amount >= 0)
);
CREATE TABLE atlas.task_definition (
 id uuid PRIMARY KEY, name text NOT NULL, input_spec jsonb NOT NULL, output_spec jsonb NOT NULL,
 acceptance_criteria jsonb NOT NULL, permission_scope jsonb NOT NULL,
 fixture_hash text, public_fixture_uri text, version text NOT NULL
);
CREATE TABLE atlas.evaluation_run (
 id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES atlas.task_definition(id),
 subject_id uuid NOT NULL REFERENCES atlas.entity(id), started_at timestamptz NOT NULL,
 finished_at timestamptz, environment jsonb NOT NULL, versions jsonb NOT NULL,
 status text NOT NULL, success boolean, interventions integer, duration_seconds numeric,
 cost numeric, currency text, output_uri text, rubric_results jsonb,
 evaluator_relationship text, evidence_observation_id uuid REFERENCES atlas.observation(id),
 CHECK(interventions IS NULL OR interventions >= 0), CHECK(cost IS NULL OR cost >= 0)
);
CREATE TABLE atlas.payment_observation (
 id uuid PRIMARY KEY, task_id uuid REFERENCES atlas.task_definition(id),
 evaluation_run_id uuid REFERENCES atlas.evaluation_run(id), protocol_entity_id uuid REFERENCES atlas.entity(id),
 protocol_version text, scheme text, network text, asset text, amount numeric, quote_type text,
 quote_time timestamptz, custody_model text, settlement_state text, transaction_ref text,
 receipt_ref text, observation_id uuid NOT NULL REFERENCES atlas.observation(id)
);
CREATE TABLE atlas.collection_run (
 id uuid PRIMARY KEY, source_id uuid REFERENCES atlas.source(id), collector_version text NOT NULL,
 query jsonb, cursor jsonb, started_at timestamptz NOT NULL, finished_at timestamptz,
 requests integer, fetched_records integer, unique_qualified_records integer,
 incomplete_results boolean, error_summary jsonb, cost_amount numeric, cost_currency text
);
CREATE TABLE atlas.publication (
 entity_id uuid PRIMARY KEY REFERENCES atlas.entity(id), revision integer NOT NULL,
 body jsonb NOT NULL, approved_assertion_ids uuid[] NOT NULL, reviewer text NOT NULL,
 published_at timestamptz, material_updated_at timestamptz, indexable boolean NOT NULL DEFAULT false,
 quality_gate jsonb NOT NULL
);
CREATE UNIQUE INDEX external_identity_active ON atlas.external_identity(namespace,external_id) WHERE valid_to IS NULL;
CREATE INDEX assertion_entity_field ON atlas.assertion(entity_id,field_path);
CREATE INDEX observation_source_date ON atlas.observation(source_id,retrieved_at DESC);
CREATE INDEX relationship_subject ON atlas.relationship(subject_id,predicate);
CREATE INDEX relationship_object ON atlas.relationship(object_id,predicate);
COMMIT;
-- Application-level publication validation must verify every factual assertion has evidence,
-- every approved assertion belongs to the entity or a clearly linked object, and all reuse terms hold.
-- Use migrations, authorization, soft deletion and data-retention controls before production deployment.
