/**
 * basedagents validate
 *
 * Reads a basedagents.json manifest, validates it against the JSON Schema,
 * and reports errors + actionable recommendations before registration.
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ─── Inline schema (works offline, no network dep) ───
const SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://basedagents.ai/schema/manifest/0.1.json',
  title: 'BasedAgents Manifest',
  type: 'object',
  required: ['manifest_version', 'identity', 'capabilities', 'protocols'],
  additionalProperties: false,
  properties: {
    $schema: { type: 'string' },
    manifest_version: { type: 'string', const: '0.1' },
    identity: {
      type: 'object',
      required: ['name', 'version', 'description'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 100 },
        version: { type: 'string', maxLength: 50 },
        description: { type: 'string', minLength: 1, maxLength: 500 },
        homepage: { type: 'string', format: 'uri' },
        logo_url: { type: 'string', format: 'uri' },
        contact_endpoint: { type: 'string', format: 'uri' },
        contact_email: { type: 'string', format: 'email' },
        organization: { type: 'string', maxLength: 100 },
        organization_url: { type: 'string', format: 'uri' },
        tags: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 50 } },
      },
    },
    runtime: {
      type: 'object',
      additionalProperties: false,
      properties: {
        framework: { type: 'string' },
        model: { type: 'string' },
        model_provider: { type: 'string' },
        language: { type: 'string' },
      },
    },
    capabilities: {
      type: 'array', minItems: 1, maxItems: 50,
      items: { type: 'string', minLength: 1, maxLength: 100 },
    },
    protocols: {
      type: 'array', minItems: 1,
      items: { type: 'string', enum: ['https', 'mcp', 'a2a', 'websocket', 'grpc', 'openapi'] },
    },
    tools: {
      type: 'array', maxItems: 50,
      items: {
        type: 'object', required: ['name'], additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1 },
          registry: { type: 'string', enum: ['npm', 'pypi', 'cargo', 'clawhub'] },
          version: { type: 'string' },
          purpose: { type: 'string', maxLength: 200 },
          private: { type: 'boolean' },
        },
      },
    },
    permissions: {
      type: 'object', additionalProperties: false,
      properties: {
        network: {
          type: 'object', additionalProperties: false,
          properties: {
            outbound: { type: 'array', items: { type: 'string' } },
            inbound: { type: 'boolean' },
          },
        },
        data: {
          type: 'object', additionalProperties: false,
          properties: {
            reads: { type: 'array', items: { type: 'string' } },
            writes: { type: 'array', items: { type: 'string' } },
            stores: { type: 'boolean' },
            retains_pii: { type: 'boolean' },
          },
        },
        compute: {
          type: 'object', additionalProperties: false,
          properties: {
            max_tokens_per_request: { type: 'integer', minimum: 1 },
            max_concurrent_requests: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    safety: {
      type: 'object', additionalProperties: false,
      properties: {
        content_policy: { type: 'string', enum: ['openai', 'anthropic', 'google', 'custom', 'none'] },
        refuses: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'harmful_code_generation', 'secrets_exfiltration', 'prompt_injection',
              'pii_collection', 'unauthorized_tool_calls', 'data_exfiltration',
              'social_engineering', 'self_replication',
            ],
          },
        },
        scope_bound: { type: 'boolean' },
        human_in_loop: { type: 'boolean' },
        human_in_loop_for: { type: 'array', items: { type: 'string' } },
        sandboxed: { type: 'boolean' },
      },
    },
    verification: {
      type: 'object', additionalProperties: false,
      properties: {
        endpoint: { type: 'string', format: 'uri' },
        protocol: { type: 'string', enum: ['https', 'mcp', 'a2a', 'websocket'] },
        probe_instructions: { type: 'string', maxLength: 500 },
        expected_response_ms: { type: 'integer', minimum: 100, maximum: 60000 },
      },
    },
    registry: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string', pattern: '^ag_[1-9A-HJ-NP-Za-km-z]+$' },
        url: { type: 'string', format: 'uri' },
      },
    },
  },
} as const;

// ─── ANSI colors (no external dep) ───
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  green:  '\x1b[32m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
};
const bold   = (s: string) => `${c.bold}${s}${c.reset}`;
const red    = (s: string) => `${c.red}${s}${c.reset}`;
const yellow = (s: string) => `${c.yellow}${s}${c.reset}`;
const green  = (s: string) => `${c.green}${s}${c.reset}`;
const dim    = (s: string) => `${c.dim}${s}${c.reset}`;
const cyan   = (s: string) => `${c.cyan}${s}${c.reset}`;

// ─── Friendly error messages ───
function friendlyError(instancePath: string, message: string | undefined, params: Record<string, unknown>): string {
  if (!message) return 'Invalid value';

  // "must have required property 'X'"
  if (params.missingProperty) return `Required field ${bold(String(params.missingProperty))} is missing`;

  // "must be equal to constant"
  if (params.allowedValue !== undefined) return `Must be ${bold(JSON.stringify(params.allowedValue))}`;

  // "must be equal to one of the allowed values"
  if (Array.isArray(params.allowedValues)) return `Must be one of: ${(params.allowedValues as string[]).map(v => bold(String(v))).join(', ')}`;

  // "must NOT have fewer than N items"
  if (params.limit !== undefined && message.includes('fewer')) return `Must contain at least ${bold(String(params.limit))} item${Number(params.limit) > 1 ? 's' : ''}`;

  // "must NOT have more than N items"
  if (params.limit !== undefined && message.includes('more')) return `Cannot exceed ${bold(String(params.limit))} items`;

  // "must match format"
  if (params.format === 'uri') return `Must be a valid URL (e.g. ${bold('https://example.com')})`;
  if (params.format === 'email') return `Must be a valid email address`;

  // "must NOT have additional properties"
  if (params.additionalProperty) return `Unknown field ${bold(String(params.additionalProperty))} — check spelling`;

  return message;
}

// ─── Recommendations (things that aren't errors but matter for reputation) ───
interface Recommendation {
  field: string;
  message: string;
  impact: string;
}

function getRecommendations(manifest: Record<string, unknown>): Recommendation[] {
  const recs: Recommendation[] = [];
  const identity = (manifest.identity ?? {}) as Record<string, unknown>;

  if (!manifest.tools || (manifest.tools as unknown[]).length === 0) {
    recs.push({
      field: 'tools',
      message: 'No skills/tools declared',
      impact: 'Skill Trust component scores 0 (−15% of max reputation)',
    });
  }

  if (!identity.contact_endpoint) {
    recs.push({
      field: 'identity.contact_endpoint',
      message: 'No probe endpoint',
      impact: 'Agent cannot reach active status without a verifiable endpoint',
    });
  }

  if (!manifest.verification) {
    recs.push({
      field: 'verification',
      message: 'No verification config',
      impact: 'Verifiers won\'t know how to probe your agent',
    });
  }

  if (!manifest.safety) {
    recs.push({
      field: 'safety',
      message: 'No safety declarations',
      impact: 'Agents without declared safety constraints are harder to trust',
    });
  }

  if (!manifest.runtime) {
    recs.push({
      field: 'runtime',
      message: 'No runtime info',
      impact: 'Won\'t appear in framework/model-filtered searches',
    });
  }

  if (!identity.organization) {
    recs.push({
      field: 'identity.organization',
      message: 'No organization set',
      impact: 'Lower discoverability for enterprise search',
    });
  }

  const data = ((manifest.permissions as Record<string, unknown>)?.data ?? {}) as Record<string, unknown>;
  if (data.retains_pii === true && !identity.contact_email) {
    recs.push({
      field: 'identity.contact_email',
      message: 'PII retention declared but no contact email',
      impact: 'Required for compliance — GDPR/CCPA surface area',
    });
  }

  return recs;
}

// ─── Main validate function ───
export interface ValidateResult {
  valid: boolean;
  errorCount: number;
  warningCount: number;
}

export function validate(filePath: string): ValidateResult {
  const absPath = resolve(filePath);
  console.log('');

  // 1. File exists?
  if (!existsSync(absPath)) {
    console.log(red(`✗ File not found: ${filePath}`));
    console.log(dim(`  Create a basedagents.json in this directory to get started.`));
    console.log(dim(`  See: https://basedagents.ai/docs/manifest\n`));
    return { valid: false, errorCount: 1, warningCount: 0 };
  }
  console.log(green(`✓`) + ` ${bold(filePath)}`);

  // 2. Valid JSON?
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(absPath, 'utf-8'));
  } catch (e: unknown) {
    const msg = e instanceof SyntaxError ? e.message : String(e);
    console.log(red(`✗ Invalid JSON: ${msg}\n`));
    return { valid: false, errorCount: 1, warningCount: 0 };
  }
  console.log(green(`✓`) + ` Valid JSON`);

  // 3. Schema validation
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv as Parameters<typeof addFormats>[0]);
  const valid = ajv.validate(SCHEMA, manifest);
  const errors = ajv.errors ?? [];

  console.log('');
  console.log(bold(`Validating against manifest schema v0.1...`));
  console.log('');

  if (errors.length > 0) {
    console.log(bold(red(`✗ ${errors.length} error${errors.length > 1 ? 's' : ''}`)));
    for (const err of errors) {
      const path = err.instancePath
        ? err.instancePath.replace(/\//g, '.').replace(/^\./, '')
        : (err.params as Record<string, unknown>).missingProperty
          ? String((err.params as Record<string, unknown>).missingProperty)
          : '(root)';
      const msg = friendlyError(err.instancePath, err.message, err.params as Record<string, unknown>);
      const label = path ? cyan(path.padEnd(30)) : cyan('(root)'.padEnd(30));
      console.log(`  ${red('✗')} ${label} ${msg}`);
    }
    console.log('');
  } else {
    console.log(green(`✓ Schema valid`));
    console.log('');
  }

  // 4. Recommendations
  const recs = getRecommendations(manifest);
  if (recs.length > 0) {
    console.log(bold(yellow(`⚠  ${recs.length} recommendation${recs.length > 1 ? 's' : ''}`)));
    for (const rec of recs) {
      console.log(`  ${yellow('⚠')}  ${cyan(rec.field.padEnd(30))} ${rec.message}`);
      console.log(`     ${''.padEnd(30)} ${dim(rec.impact)}`);
    }
    console.log('');
  }

  // 5. Summary of what's present
  const identity = (manifest.identity ?? {}) as Record<string, unknown>;
  const tools = (manifest.tools ?? []) as unknown[];
  const capabilities = (manifest.capabilities ?? []) as string[];

  console.log(bold('Summary'));
  const rows = [
    ['name',         String(identity.name ?? dim('—'))],
    ['version',      String(identity.version ?? dim('—'))],
    ['capabilities', capabilities.length > 0 ? capabilities.slice(0, 5).join(', ') + (capabilities.length > 5 ? ` +${capabilities.length - 5} more` : '') : dim('—')],
    ['protocols',    ((manifest.protocols ?? []) as string[]).join(', ') || dim('—')],
    ['tools',        tools.length > 0 ? `${tools.length} declared` : dim('none')],
    ['safety',       manifest.safety ? green('declared') : dim('not set')],
    ['verification', (manifest.verification as Record<string, unknown>)?.endpoint ? green(String((manifest.verification as Record<string, unknown>).endpoint)) : dim('not set')],
  ];
  for (const [key, val] of rows) {
    console.log(`  ${dim(key.padEnd(14))} ${val}`);
  }
  console.log('');

  // 6. Final verdict
  if (errors.length === 0) {
    if (recs.length === 0) {
      console.log(green(bold('✓ Ready to register')) + `  Run: ${cyan('basedagents register')}\n`);
    } else {
      console.log(yellow(bold('⚠  Valid but incomplete')) + `  Fix recommendations to maximize reputation.\n`);
      console.log(`  Run: ${cyan('basedagents register')} to register anyway.\n`);
    }
  } else {
    console.log(red(bold('✗ Not ready')) + `  Fix the errors above before registering.\n`);
  }

  return { valid: errors.length === 0, errorCount: errors.length, warningCount: recs.length };
}
