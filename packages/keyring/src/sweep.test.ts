/**
 * Custody Fix 2 — ambient sweep detector. Deterministic because home / cwd / env
 * are injected. Asserts each detection class fires, that a clean environment is
 * clean, and (the invariant) that no secret value ever appears in a finding.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runSweep, summarizeResiduals } from './sweep.js';

const tempDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  tempDirs.push(d);
  return d;
}
afterEach(() => { for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function write(dir: string, rel: string, contents: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

// Built at runtime so no secret-shaped literal sits in the source (push
// protection flags `sk_live_…` strings). Matches the sweep's Stripe regex.
const STRIPE = ['sk', 'live', 'FAKEexampleonly' + 'x'.repeat(16)].join('_');

describe('runSweep', () => {
  it('is clean when nothing ambient exists', () => {
    const res = runSweep({ cwd: tmp(), home: tmp(), env: {} });
    expect(res.findings).toHaveLength(0);
    expect(summarizeResiduals(res.findings)).toMatch(/No ambient access/);
  });

  it('flags .env live values by name, never by value', () => {
    const cwd = tmp();
    write(cwd, '.env', `# comment\nSTRIPE_KEY=${STRIPE}\nPLACEHOLDER=changeme\nPUBLIC_URL=https://x.dev\n`);
    const res = runSweep({ cwd, home: tmp(), env: {} });
    const env = res.findings.find(f => f.kind === 'env_file');
    expect(env).toBeTruthy();
    expect(env!.detail).toContain('STRIPE_KEY');
    expect(env!.detail).not.toContain('changeme'); // placeholder ignored
    // The value itself must never appear anywhere in the finding.
    expect(JSON.stringify(res.findings)).not.toContain(STRIPE);
  });

  it('detects a logged-in provider CLI by its auth file', () => {
    const home = tmp();
    write(home, '.vercel/auth.json', '{"token":"xxx"}');
    const res = runSweep({ cwd: tmp(), home, env: {} });
    const cli = res.findings.find(f => f.kind === 'cli_login');
    expect(cli?.provider).toBe('vercel');
    expect(cli?.remedy).toContain('vercel logout');
  });

  it('flags token-shaped env vars by name and by value pattern', () => {
    const byName = runSweep({ cwd: tmp(), home: tmp(), env: { STRIPE_SECRET_KEY: STRIPE } });
    expect(byName.findings.some(f => f.kind === 'env_var')).toBe(true);
    const byValue = runSweep({ cwd: tmp(), home: tmp(), env: { RANDOM: 'ghp_' + 'a'.repeat(30) } });
    expect(byValue.findings.some(f => f.kind === 'env_var')).toBe(true);
    // Public / URL vars are not flagged even if long.
    const clean = runSweep({ cwd: tmp(), home: tmp(), env: { NEXT_PUBLIC_URL: 'https://example.com/very/long/path' } });
    expect(clean.findings).toHaveLength(0);
    // Pointer vars (*_FILE / *_PATH) name a location, not the secret itself.
    const pointer = runSweep({ cwd: tmp(), home: tmp(), env: { SESSION_TOKEN_FILE: '/run/secrets/token' } });
    expect(pointer.findings).toHaveLength(0);
  });

  it('detects ~/.netrc credentials', () => {
    const home = tmp();
    write(home, '.netrc', 'machine api.example.com login me password s3cret\n');
    const res = runSweep({ cwd: tmp(), home, env: {} });
    expect(res.findings.some(f => f.kind === 'netrc')).toBe(true);
  });

  it('summarizeResiduals lists each finding with its remedy', () => {
    const home = tmp();
    write(home, '.vercel/auth.json', '{}');
    const res = runSweep({ cwd: tmp(), home, env: {} });
    const summary = summarizeResiduals(res.findings);
    expect(summary).toContain('Vercel CLI login');
    expect(summary).toContain('vercel logout');
  });
});
