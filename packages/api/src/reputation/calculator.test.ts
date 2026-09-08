import { describe, it, expect, beforeEach } from 'vitest';
import { computeReputation } from './calculator.js';
import { setupTestDb, createTestAgent } from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';

describe('computeReputation', () => {
  let db: SQLiteAdapter;

  beforeEach(() => {
    db = setupTestDb();
  });

  it('agent with no verifications → final_score ≈ 0', async () => {
    const agent = await createTestAgent(db, { reputationScore: 0 });
    const rep = await computeReputation(agent.agentId, db);
    expect(rep.final_score).toBe(0);
    expect(rep.verifications_received).toBe(0);
    expect(rep.confidence).toBe(0);
  });

  it('agent with 1 pass verification → positive score', async () => {
    const target = await createTestAgent(db, { reputationScore: 0 });
    const verifier = await createTestAgent(db, { reputationScore: 0.8 });
    const now = new Date().toISOString();

    await db.run(
      `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, structured_report, nonce, created_at)
       VALUES (?, ?, ?, 'pass', 0.8, NULL, 'sig', NULL, ?, ?)`,
      'v1', verifier.agentId, target.agentId, 'nonce-1', now
    );

    const rep = await computeReputation(target.agentId, db);
    expect(rep.final_score).toBeGreaterThan(0);
    expect(rep.components.pass_rate).toBe(1);
    expect(rep.verifications_received).toBe(1);
  });

  it('agent with all fail verifications → low score', async () => {
    const target = await createTestAgent(db, { reputationScore: 0 });
    const verifier = await createTestAgent(db, { reputationScore: 0.8 });

    for (let i = 0; i < 5; i++) {
      const now = new Date().toISOString();
      await db.run(
        `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, structured_report, nonce, created_at)
         VALUES (?, ?, ?, 'fail', 0.0, NULL, 'sig', NULL, ?, ?)`,
        `v${i}`, verifier.agentId, target.agentId, `nonce-${i}`, now
      );
    }

    const rep = await computeReputation(target.agentId, db);
    expect(rep.final_score).toBeLessThan(0.2);
    expect(rep.components.pass_rate).toBe(0);
  });

  it('agent with mixed results → intermediate score', async () => {
    const target = await createTestAgent(db, { reputationScore: 0 });
    const verifier = await createTestAgent(db, { reputationScore: 0.8 });
    const now = new Date().toISOString();

    await db.run(
      `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, structured_report, nonce, created_at)
       VALUES (?, ?, ?, 'pass', 0.8, NULL, 'sig', NULL, 'n1', ?)`,
      'v1', verifier.agentId, target.agentId, now
    );
    await db.run(
      `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, structured_report, nonce, created_at)
       VALUES (?, ?, ?, 'fail', 0.0, NULL, 'sig', NULL, 'n2', ?)`,
      'v2', verifier.agentId, target.agentId, now
    );

    const rep = await computeReputation(target.agentId, db);
    expect(rep.components.pass_rate).toBeCloseTo(0.5, 1);
  });

  it('safety flags increase penalty', async () => {
    const target = await createTestAgent(db, { reputationScore: 0 });
    const verifier = await createTestAgent(db, { reputationScore: 0.8 });
    const now = new Date().toISOString();

    // Add safety-flagged verification
    const structuredReport = JSON.stringify({ safety_issues: true });
    await db.run(
      `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, structured_report, nonce, created_at)
       VALUES (?, ?, ?, 'fail', 0.0, NULL, 'sig', ?, 'n1', ?)`,
      'v1', verifier.agentId, target.agentId, structuredReport, now
    );

    const rep = await computeReputation(target.agentId, db);
    expect(rep.penalty).toBeGreaterThan(0);
  });

  it('confidence increases with more verifications', async () => {
    const target = await createTestAgent(db, { reputationScore: 0 });
    const verifier = await createTestAgent(db, { reputationScore: 0.8 });

    const rep0 = await computeReputation(target.agentId, db);
    expect(rep0.confidence).toBe(0);

    // Add 1 verification
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, structured_report, nonce, created_at)
       VALUES ('v1', ?, ?, 'pass', 0.9, NULL, 'sig', NULL, 'n1', ?)`,
      verifier.agentId, target.agentId, now
    );
    const rep1 = await computeReputation(target.agentId, db);
    expect(rep1.confidence).toBeGreaterThan(0);
    expect(rep1.confidence).toBeLessThan(1);

    // Add more verifications
    for (let i = 2; i <= 10; i++) {
      await db.run(
        `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, structured_report, nonce, created_at)
         VALUES (?, ?, ?, 'pass', 0.9, NULL, 'sig', NULL, ?, ?)`,
        `v${i}`, verifier.agentId, target.agentId, `n${i}`, now
      );
    }
    const rep10 = await computeReputation(target.agentId, db);
    expect(rep10.confidence).toBeGreaterThan(rep1.confidence);
  });

  it('reputation_override short-circuits to the overridden value', async () => {
    const agent = await createTestAgent(db, { reputationOverride: 0.999 });
    // Even with no verifications, it returns the override
    const rep = await computeReputation(agent.agentId, db);
    expect(rep.final_score).toBe(0.999);
    expect(rep.confidence).toBe(1.0);
  });

  it('timeout verifications reduce uptime', async () => {
    const target = await createTestAgent(db, { reputationScore: 0 });
    const verifier = await createTestAgent(db, { reputationScore: 0.8 });
    const now = new Date().toISOString();

    await db.run(
      `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, structured_report, nonce, created_at)
       VALUES ('v1', ?, ?, 'timeout', NULL, NULL, 'sig', NULL, 'n1', ?)`,
      verifier.agentId, target.agentId, now
    );

    const rep = await computeReputation(target.agentId, db);
    expect(rep.components.uptime).toBe(0);
  });

  describe('task completion term (additive)', () => {
    async function seedDelivered(agentId: string, creatorId: string, patch: Record<string, unknown>): Promise<void> {
      const id = `task_${Math.random().toString(36).slice(2, 12)}`;
      const now = new Date().toISOString();
      const row: Record<string, unknown> = {
        task_id: id, creator_agent_id: creatorId, claimed_by_agent_id: agentId, title: 'T', description: 'D',
        status: 'verified', created_at: now, ...patch,
      };
      const cols = Object.keys(row);
      await db.run(`INSERT INTO tasks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((k) => row[k]));
    }

    it('accepted deliveries alone lift an unverified agent above zero', async () => {
      const agent = await createTestAgent(db, { reputationScore: 0 });
      const buyer = await createTestAgent(db, { reputationScore: 0 });
      const now = new Date().toISOString();
      await seedDelivered(agent.agentId, buyer.agentId, { accepted_by: 'creator', verified_at: now });
      const rep = await computeReputation(agent.agentId, db);
      expect(rep.verifications_received).toBe(0);
      expect(rep.components.task_completion).toBeGreaterThan(0);
      expect(rep.tasks_accepted).toBeCloseTo(1, 2);
      expect(rep.tasks_failed).toBe(0);
      // rate 1 × conf ln(2)/ln(11) ≈ 0.289 → × 0.15
      expect(rep.final_score).toBeCloseTo(0.15 * (Math.log(2) / Math.log(11)), 2);
    });

    it('an auto-accepted delivery counts half of a buyer acceptance', async () => {
      const agent = await createTestAgent(db, { reputationScore: 0 });
      const buyer = await createTestAgent(db, { reputationScore: 0 });
      const now = new Date().toISOString();
      await seedDelivered(agent.agentId, buyer.agentId, { accepted_by: 'auto', verified_at: now });
      const rep = await computeReputation(agent.agentId, db);
      expect(rep.tasks_accepted).toBeCloseTo(0.5, 2);
    });

    it('a disputed-then-cancelled delivery counts against the deliverer', async () => {
      const agent = await createTestAgent(db, { reputationScore: 0 });
      const buyer = await createTestAgent(db, { reputationScore: 0 });
      const now = new Date().toISOString();
      await seedDelivered(agent.agentId, buyer.agentId, { accepted_by: 'creator', verified_at: now });
      await seedDelivered(agent.agentId, buyer.agentId, { status: 'cancelled', disputed_at: now, cancelled_at: now });
      const rep = await computeReputation(agent.agentId, db);
      expect(rep.tasks_failed).toBeCloseTo(1, 2);
      expect(rep.components.task_completion).toBeCloseTo(0.5 * (Math.log(3) / Math.log(11)), 3);
      const onlyFailed = await createTestAgent(db, { reputationScore: 0 });
      await seedDelivered(onlyFailed.agentId, buyer.agentId, { status: 'cancelled', disputed_at: now, cancelled_at: now });
      expect((await computeReputation(onlyFailed.agentId, db)).final_score).toBe(0);
    });

    it('adds on top of peer verification without changing the verification weights', async () => {
      const target = await createTestAgent(db, { reputationScore: 0 });
      const verifier = await createTestAgent(db, { reputationScore: 0.8 });
      const now = new Date().toISOString();
      await db.run(
        `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, structured_report, nonce, created_at)
         VALUES (?, ?, ?, 'pass', 0.8, NULL, 'sig', NULL, ?, ?)`,
        'v1', verifier.agentId, target.agentId, 'nonce-1', now,
      );
      const before = await computeReputation(target.agentId, db);
      await seedDelivered(target.agentId, verifier.agentId, { accepted_by: 'creator', verified_at: now });
      const after = await computeReputation(target.agentId, db);
      expect(after.raw_score).toBe(before.raw_score);
      expect(after.components.pass_rate).toBe(before.components.pass_rate);
      expect(after.final_score).toBeGreaterThan(before.final_score);
      expect(after.weights.task_completion).toBe(0.15);
    });
  });
});
