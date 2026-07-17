import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateProviderToken, presetEnvVar, PROVIDER_PRESETS } from './providers.js';

describe('provider presets (connect-card validation)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shape-checks before any network call', async () => {
    expect((await validateProviderToken('supabase', 'not-a-supabase-token')).ok).toBe(false);
    expect((await validateProviderToken('vercel', 'short')).ok).toBe(false);
    expect((await validateProviderToken('vercel', '')).ok).toBe(false);
  });

  it('validates live against the provider API and reports what the token can do', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ user: { username: 'max' } }),
    })) as unknown as typeof fetch);
    const res = await validateProviderToken('vercel', 'v'.repeat(24));
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('max');
  });

  it('rejects an account-wide Supabase token and demands a project-scoped key (Fix 3)', async () => {
    const called = vi.fn();
    vi.stubGlobal('fetch', called as unknown as typeof fetch);
    const res = await validateProviderToken('supabase', 'sbp_' + 'x'.repeat(24));
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/account-wide|service_role|project/i);
    // The rejection happens before any network call.
    expect(called).not.toHaveBeenCalled();
  });

  it('accepts a project service_role key (JWT) for Supabase', async () => {
    const jwt = 'eyJ' + 'a'.repeat(48);
    const res = await validateProviderToken('supabase', jwt);
    expect(res.ok).toBe(true);
  });

  it('fails OPEN when the provider API is unreachable (store rather than strand)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch);
    const res = await validateProviderToken('vercel', 'v'.repeat(24));
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('skipped');
  });

  it('unknown providers store non-empty tokens as-is', async () => {
    expect((await validateProviderToken('neon', 'anything-goes')).ok).toBe(true);
    expect((await validateProviderToken('neon', '  ')).ok).toBe(false);
  });

  it('presets carry sensible env vars; unknowns derive one', () => {
    expect(presetEnvVar('vercel')).toBe('VERCEL_TOKEN');
    expect(presetEnvVar('supabase')).toBe('SUPABASE_SERVICE_ROLE_KEY');
    expect(presetEnvVar('some-new-thing')).toBe('SOME_NEW_THING_TOKEN');
    expect(Object.keys(PROVIDER_PRESETS)).toContain('vercel');
  });
});
