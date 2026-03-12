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
});
