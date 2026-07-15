import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  validateRecipeManifest,
  mintedKeyName,
  domainAllows,
  REQUIRED_VERBS,
} from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const exampleManifest = JSON.parse(
  readFileSync(join(here, '..', 'recipes', 'example-dashboard', '1.0.0.json'), 'utf-8')
);

describe('mintedKeyName', () => {
  it('follows the ba/{agent}/{grant-id} convention', () => {
    expect(mintedKeyName('ci-bot', 'grant_abc')).toBe('ba/ci-bot/grant_abc');
  });
});

describe('domainAllows', () => {
  it('matches exact hosts', () => {
    expect(domainAllows('app.example.com', 'app.example.com')).toBe(true);
    expect(domainAllows('app.example.com', 'evil.com')).toBe(false);
  });
  it('supports a leftmost wildcard but not the bare apex', () => {
    expect(domainAllows('*.example.com', 'api.example.com')).toBe(true);
    expect(domainAllows('*.example.com', 'a.b.example.com')).toBe(true);
    expect(domainAllows('*.example.com', 'example.com')).toBe(false);
    expect(domainAllows('*.example.com', 'notexample.com')).toBe(false);
  });
});

describe('validateRecipeManifest', () => {
  it('accepts the bundled example recipe', () => {
    const result = validateRecipeManifest(exampleManifest);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(validateRecipeManifest(null).valid).toBe(false);
    expect(validateRecipeManifest('nope').valid).toBe(false);
  });

  it('requires mint and burn procedures', () => {
    const noBurn = { ...exampleManifest, procedures: { mint: exampleManifest.procedures.mint } };
    const result = validateRecipeManifest(noBurn);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('procedures.burn'))).toBe(true);
  });

  it('enforces write-only vault access in the sandbox', () => {
    const bad = { ...exampleManifest, sandbox: { ...exampleManifest.sandbox, vault_access: 'read-write' } };
    expect(validateRecipeManifest(bad).valid).toBe(false);
  });

  it('rejects an unknown verb', () => {
    const bad = {
      ...exampleManifest,
      procedures: { ...exampleManifest.procedures, exfiltrate: { transport: 'browser', steps: [{ action: 'read_value' }] } },
    };
    const result = validateRecipeManifest(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('unknown verb'))).toBe(true);
  });

  it('rejects a bad version and provider slug', () => {
    const bad = { ...exampleManifest, version: 'v1', provider: 'Not A Slug' };
    const result = validateRecipeManifest(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('version'))).toBe(true);
    expect(result.errors.some(e => e.includes('provider'))).toBe(true);
  });

  it('the example implements every required verb', () => {
    for (const verb of REQUIRED_VERBS) {
      expect(exampleManifest.procedures[verb]).toBeTruthy();
    }
  });
});
