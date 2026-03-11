/**
 * Skill Resolver
 *
 * Resolves agent-declared skills against known registries (npm, ClaWHub, PyPI).
 * Caches results in skill_cache table.
 * Computes a trust_score for each skill based on downloads/stars.
 *
 * Trust score logic:
 *   - Not found in any registry:  0.0  (unverified)
 *   - Found, < 100 downloads:     0.3  (low traction)
 *   - Found, 100–1K downloads:    0.5  (emerging)
 *   - Found, 1K–10K downloads:    0.7  (established)
 *   - Found, 10K+ downloads:      0.9  (trusted)
 *   - Stars add up to +0.1 bonus
 *   - Private skill (self-declared): 0.5 (acknowledged, unverifiable)
 */

import type { DBAdapter } from '../db/adapter.js';

export interface DeclaredSkill {
  name: string;
  registry?: string; // "npm" | "clawhub" | "pypi" — defaults to "npm"
  version?: string;
  private?: boolean; // internal skill, not in any public registry
}

export interface ResolvedSkill {
  name: string;
  registry: string;
  version?: string;
  private: boolean;
  verified: boolean;
  description?: string | null;
  downloads_last_month?: number | null;
  stars?: number | null;
  trust_score: number;
  last_checked_at: string;
}

interface SkillCacheRow {
  id: string;
  registry: string;
  name: string;
  version: string | null;
  description: string | null;
  downloads_last_month: number | null;
  stars: number | null;
  verified: number;
  trust_score: number;
  last_checked_at: string;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Trust Score Calculation ───

function computeTrustScore(downloads: number | null, stars: number | null): number {
  if (downloads === null && stars === null) return 0.0;
  let score = 0.0;
  const d = downloads ?? 0;
  if (d >= 10_000) score = 0.9;
  else if (d >= 1_000) score = 0.7;
  else if (d >= 100) score = 0.5;
  else if (d > 0) score = 0.3;
  // Stars bonus (up to +0.1)
  const s = stars ?? 0;
  if (s >= 100) score = Math.min(1.0, score + 0.1);
  else if (s >= 10) score = Math.min(1.0, score + 0.05);
  return Math.round(score * 100) / 100;
}

// ─── Registry Fetchers ───

async function fetchNpm(name: string): Promise<Partial<ResolvedSkill> | null> {
  try {
    const [meta, downloads] = await Promise.all([
      fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`),
      fetch(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(name)}`),
    ]);
    if (!meta.ok) return null;
    const metaJson = await meta.json() as Record<string, unknown>;
    const dlJson = downloads.ok ? await downloads.json() as Record<string, unknown> : null;
    return {
      verified: true,
      description: (metaJson.description as string) ?? null,
      downloads_last_month: dlJson ? (dlJson.downloads as number) : null,
      stars: null, // npm doesn't expose stars
    };
  } catch {
    return null;
  }
}

async function fetchClawhub(name: string): Promise<Partial<ResolvedSkill> | null> {
  // ClaWHub doesn't have a public API yet — stub for when it does
  try {
    const res = await fetch(`https://clawhub.ai/api/v1/skills/${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    return {
      verified: true,
      description: (data.description as string) ?? null,
      downloads_last_month: (data.downloads as number) ?? null,
      stars: (data.stars as number) ?? null,
    };
  } catch {
    return null;
  }
}

async function fetchPypi(name: string): Promise<Partial<ResolvedSkill> | null> {
  try {
    const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    const info = data.info as Record<string, unknown>;
    return {
      verified: true,
      description: (info?.summary as string) ?? null,
      downloads_last_month: null, // PyPI requires separate bigquery for this
      stars: null,
    };
  } catch {
    return null;
  }
}

// ─── Main Resolver ───

export async function resolveSkill(
  skill: DeclaredSkill,
  db: DBAdapter
): Promise<ResolvedSkill> {
  const registry = skill.registry ?? 'npm';
  const cacheId = `${registry}:${skill.name}`;
  const now = new Date();

  // Private skill — no external lookup needed
  if (skill.private) {
    return {
      name: skill.name,
      registry,
      version: skill.version,
      private: true,
      verified: false,
      description: null,
      downloads_last_month: null,
      stars: null,
      trust_score: 0.5,
      last_checked_at: now.toISOString(),
    };
  }

  // Check cache
  const cached = await db.get<SkillCacheRow>(
    'SELECT * FROM skill_cache WHERE id = ?',
    cacheId
  );

  if (cached) {
    const age = now.getTime() - new Date(cached.last_checked_at).getTime();
    if (age < CACHE_TTL_MS) {
      return {
        name: cached.name,
        registry: cached.registry,
        version: cached.version ?? skill.version,
        private: false,
        verified: cached.verified === 1,
        description: cached.description,
        downloads_last_month: cached.downloads_last_month,
        stars: cached.stars,
        trust_score: cached.trust_score,
        last_checked_at: cached.last_checked_at,
      };
    }
  }

  // Fetch from registry
  let fetched: Partial<ResolvedSkill> | null = null;
  if (registry === 'npm') fetched = await fetchNpm(skill.name);
  else if (registry === 'clawhub') fetched = await fetchClawhub(skill.name);
  else if (registry === 'pypi') fetched = await fetchPypi(skill.name);

  const verified = fetched !== null;
  const downloads = fetched?.downloads_last_month ?? null;
  const stars = fetched?.stars ?? null;
  const trustScore = verified ? computeTrustScore(downloads, stars) : 0.0;
  const nowIso = now.toISOString();

  // Upsert cache
  await db.run(
    `INSERT INTO skill_cache (id, registry, name, version, description, downloads_last_month, stars, verified, trust_score, last_checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       version = excluded.version,
       description = excluded.description,
       downloads_last_month = excluded.downloads_last_month,
       stars = excluded.stars,
       verified = excluded.verified,
       trust_score = excluded.trust_score,
       last_checked_at = excluded.last_checked_at`,
    cacheId, registry, skill.name, skill.version ?? null,
    fetched?.description ?? null, downloads, stars,
    verified ? 1 : 0, trustScore, nowIso
  );

  return {
    name: skill.name,
    registry,
    version: skill.version,
    private: false,
    verified,
    description: fetched?.description ?? null,
    downloads_last_month: downloads,
    stars,
    trust_score: trustScore,
    last_checked_at: nowIso,
  };
}

/**
 * Resolve all skills for an agent and return aggregate skill trust score.
 * Aggregate = average of individual trust scores (or 0 if no skills).
 */
export async function resolveAgentSkills(
  skills: DeclaredSkill[],
  db: DBAdapter
): Promise<{ resolved: ResolvedSkill[]; aggregate_trust: number }> {
  if (!skills.length) return { resolved: [], aggregate_trust: 0 };

  const resolved = await Promise.all(skills.map(s => resolveSkill(s, db)));
  const aggregate_trust = resolved.reduce((sum, s) => sum + s.trust_score, 0) / resolved.length;

  return {
    resolved,
    aggregate_trust: Math.round(aggregate_trust * 100) / 100,
  };
}

/**
 * Run skill resolution for all active agents (for cron job).
 */
export async function resolveAllAgentSkills(db: DBAdapter): Promise<{ updated: number }> {
  const agents = await db.all<{ id: string; skills: string | null }>(
    `SELECT id, skills FROM agents WHERE skills IS NOT NULL AND status = 'active'`
  );

  let updated = 0;
  for (const agent of agents) {
    try {
      const skills: DeclaredSkill[] = JSON.parse(agent.skills!);
      if (!skills.length) continue;
      await resolveAgentSkills(skills, db);
      updated++;
    } catch {
      // skip malformed
    }
  }
  return { updated };
}
