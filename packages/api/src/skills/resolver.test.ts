import { describe, it, expect, beforeEach } from 'vitest';
import { computeSkillReputations, computeAdoptionScore } from './resolver.js';
import { setupTestDb, createTestAgent } from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';

// Re-export computeAdoptionScore for testing — it's not in the public interface,
// so we test it indirectly via skill_cache + computeSkillReputations.
// However, since we named it an export (not private), we can import it directly.

const SKILL_ID = 'npm:my-mcp-skill';

/**
 * Insert a minimal skill_cache row for the given skill.
 */
async function insertSkillCache(db: SQLiteAdapter, id = SKILL_ID): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO skill_cache
     (id, registry, name, verified, trust_score, adoption_score, last_checked_at)
     VALUES (?, 'npm', ?, 1, 0.0, 0.5, ?)`,
    id, id.split(':')[1], new Date().toISOString()
  );
}

/**
 * Helper: set an agent's skills field to include the skill under test.
 */
async function setAgentSkill(
  db: SQLiteAdapter,
  agentId: string,
  skillName = 'my-mcp-skill'
): Promise<void> {
  await db.run(
    `UPDATE agents SET skills = ? WHERE id = ?`,
    JSON.stringify([{ name: skillName, registry: 'npm' }]),
    agentId
  );
}

describe('computeSkillReputations — safety-aware inverted model', () => {
  let db: SQLiteAdapter;

  beforeEach(() => {
    db = setupTestDb();
  });

  it('skill used only by clean agents → trust_score > 0', async () => {
    const agent1 = await createTestAgent(db, { reputationScore: 0.9 });
    const agent2 = await createTestAgent(db, { reputationScore: 0.8 });

    await setAgentSkill(db, agent1.agentId);
    await setAgentSkill(db, agent2.agentId);
    await insertSkillCache(db);

    await computeSkillReputations(db);

    const row = await db.get<{ trust_score: number }>(
      'SELECT trust_score FROM skill_cache WHERE id = ?',
      SKILL_ID
    );
    expect(row).toBeDefined();
    expect(row!.trust_score).toBeGreaterThan(0);
  });

  it('skill used only by flagged agents → trust_score = 0', async () => {
    const agent = await createTestAgent(db, { reputationScore: 0.9 });
    // Mark agent as safety-flagged
    await db.run('UPDATE agents SET safety_flags = 2 WHERE id = ?', agent.agentId);

    await setAgentSkill(db, agent.agentId);
    await insertSkillCache(db);

    await computeSkillReputations(db);

    const row = await db.get<{ trust_score: number }>(
      'SELECT trust_score FROM skill_cache WHERE id = ?',
      SKILL_ID
    );
    expect(row).toBeDefined();
    // Flagged-only → negative weighted sum → floored at 0
    expect(row!.trust_score).toBe(0);
  });

  it('skill used by mix of clean and flagged agents → trust between 0 and 1', async () => {
    const cleanAgent = await createTestAgent(db, { reputationScore: 0.9 });
    const flaggedAgent = await createTestAgent(db, { reputationScore: 0.9 });
    await db.run('UPDATE agents SET safety_flags = 1 WHERE id = ?', flaggedAgent.agentId);

    await setAgentSkill(db, cleanAgent.agentId);
    await setAgentSkill(db, flaggedAgent.agentId);
    await insertSkillCache(db);

    await computeSkillReputations(db);

    const row = await db.get<{ trust_score: number }>(
      'SELECT trust_score FROM skill_cache WHERE id = ?',
      SKILL_ID
    );
    expect(row).toBeDefined();
    // Clean agent contributes +0.9, flagged contributes -0.9 → net 0 / 2 = 0 → floored 0
    // With equal rep+weight: expect 0 (cancel out)
    expect(row!.trust_score).toBeGreaterThanOrEqual(0);
    expect(row!.trust_score).toBeLessThanOrEqual(1);
  });

  it('more clean agents than flagged → trust > 0', async () => {
    const clean1 = await createTestAgent(db, { reputationScore: 0.8 });
    const clean2 = await createTestAgent(db, { reputationScore: 0.8 });
    const clean3 = await createTestAgent(db, { reputationScore: 0.8 });
    const flagged = await createTestAgent(db, { reputationScore: 0.8 });
    await db.run('UPDATE agents SET safety_flags = 1 WHERE id = ?', flagged.agentId);

    for (const agent of [clean1, clean2, clean3, flagged]) {
      await setAgentSkill(db, agent.agentId);
    }
    await insertSkillCache(db);

    await computeSkillReputations(db);

    const row = await db.get<{ trust_score: number }>(
      'SELECT trust_score FROM skill_cache WHERE id = ?',
      SKILL_ID
    );
    expect(row!.trust_score).toBeGreaterThan(0);
    // 3 clean (+0.8 each) vs 1 flagged (-0.8): net = 3*0.8 - 0.8 = 1.6, abs_weight = 4, score = 0.4
    expect(row!.trust_score).toBeCloseTo(0.4, 2);
  });

  it('no agents declare skill → trust_score stays at 0', async () => {
    await insertSkillCache(db);
    // No agents with skills set

    await computeSkillReputations(db);

    // No update happens (no agents), row stays at initial 0.0
    const row = await db.get<{ trust_score: number }>(
      'SELECT trust_score FROM skill_cache WHERE id = ?',
      SKILL_ID
    );
    // The row isn't touched because no agent maps to this skill
    expect(row!.trust_score).toBe(0);
  });

  it('private skills are excluded from skill reputation computation', async () => {
    const agent = await createTestAgent(db, { reputationScore: 0.9 });
    await db.run(
      'UPDATE agents SET skills = ? WHERE id = ?',
      JSON.stringify([{ name: 'my-mcp-skill', registry: 'npm', private: true }]),
      agent.agentId
    );
    await insertSkillCache(db);

    await computeSkillReputations(db);

    const row = await db.get<{ trust_score: number }>(
      'SELECT trust_score FROM skill_cache WHERE id = ?',
      SKILL_ID
    );
    // Private skills are skipped; score stays 0
    expect(row!.trust_score).toBe(0);
  });

  it('high-rep clean agent outweighs low-rep flagged agent', async () => {
    const cleanHighRep = await createTestAgent(db, { reputationScore: 1.0 });
    const flaggedLowRep = await createTestAgent(db, { reputationScore: 0.2 });
    await db.run('UPDATE agents SET safety_flags = 3 WHERE id = ?', flaggedLowRep.agentId);

    await setAgentSkill(db, cleanHighRep.agentId);
    await setAgentSkill(db, flaggedLowRep.agentId);
    await insertSkillCache(db);

    await computeSkillReputations(db);

    const row = await db.get<{ trust_score: number }>(
      'SELECT trust_score FROM skill_cache WHERE id = ?',
      SKILL_ID
    );
    // clean: +1.0, flagged: -0.2, total_abs_weight=2 → (1.0 - 0.2)/2 = 0.4
    expect(row!.trust_score).toBeGreaterThan(0);
    expect(row!.trust_score).toBeCloseTo(0.4, 2);
  });
});

describe('computeAdoptionScore', () => {
  it('no downloads → 0.0', () => {
    expect(computeAdoptionScore(null, null)).toBe(0);
    expect(computeAdoptionScore(0, null)).toBe(0);
  });

  it('1,000 downloads → ~0.5', () => {
    const score = computeAdoptionScore(1000, null);
    expect(score).toBeCloseTo(0.5, 1);
  });

  it('100,000 downloads → ~0.83', () => {
    const score = computeAdoptionScore(100000, null);
    expect(score).toBeCloseTo(0.83, 1);
  });

  it('1M downloads → capped at 0.9', () => {
    const score = computeAdoptionScore(1_000_000, null);
    expect(score).toBe(0.9);
  });

  it('stars bonus: ≥100 stars adds +0.10', () => {
    const withoutStars = computeAdoptionScore(1000, null);
    const withStars = computeAdoptionScore(1000, 200);
    expect(withStars - withoutStars).toBeCloseTo(0.1, 2);
  });

  it('stars bonus: ≥10 stars adds +0.05', () => {
    const withoutStars = computeAdoptionScore(1000, null);
    const withStars = computeAdoptionScore(1000, 50);
    expect(withStars - withoutStars).toBeCloseTo(0.05, 2);
  });

  it('total capped at 1.0 even with max downloads + stars', () => {
    const score = computeAdoptionScore(10_000_000, 500);
    expect(score).toBeLessThanOrEqual(1.0);
  });
});
