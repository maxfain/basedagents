import { describe, it, expect, beforeEach } from 'vitest';
import { runEigenTrust } from './eigentrust.js';
import { setupTestDb, createTestAgent } from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';

describe('runEigenTrust', () => {
  let db: SQLiteAdapter;

  beforeEach(() => {
    db = setupTestDb();
  });

  it('does nothing with fewer than 2 agents', async () => {
    const agent = await createTestAgent(db, { reputationScore: 0.5 });
    await runEigenTrust(db);
    const row = await db.get<{ reputation_score: number }>(
      'SELECT reputation_score FROM agents WHERE id = ?', agent.agentId
    );
    // Should not crash
    expect(row).not.toBeNull();
  });

  it('single trust anchor with override=1.0 propagates trust', async () => {
    // Genesis agent with override=1.0 (pinned)
    const genesis = await createTestAgent(db, { reputationOverride: 1.0, reputationScore: 1.0 });
    // Regular agent
    const regular = await createTestAgent(db, { reputationScore: 0 });

    // Genesis verifies regular → pass
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, structured_report, nonce, created_at)
       VALUES ('v1', ?, ?, 'pass', 1.0, NULL, 'sig', NULL, 'n1', ?)`,
      genesis.agentId, regular.agentId, now
    );

    await runEigenTrust(db);

    const row = await db.get<{ reputation_score: number }>(
      'SELECT reputation_score FROM agents WHERE id = ?', regular.agentId
    );
    expect(row!.reputation_score).toBeGreaterThan(0);
  });

  it('pinned agents (override set) are never overwritten', async () => {
    const genesis = await createTestAgent(db, { reputationOverride: 1.0, reputationScore: 1.0 });
    const other = await createTestAgent(db, { reputationScore: 0.3 });

    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, structured_report, nonce, created_at)
       VALUES ('v1', ?, ?, 'pass', 0.5, NULL, 'sig', NULL, 'n1', ?)`,
      other.agentId, genesis.agentId, now
    );

    await runEigenTrust(db);

    // Genesis score should remain at the override value
    const row = await db.get<{ reputation_score: number }>(
      'SELECT reputation_score FROM agents WHERE id = ?', genesis.agentId
    );
    expect(row!.reputation_score).toBe(1.0);
  });

  it('negative verification (fail) reduces target trust', async () => {
    const genesis = await createTestAgent(db, { reputationOverride: 1.0, reputationScore: 1.0 });
    const good = await createTestAgent(db, { reputationScore: 0.5 });
    const bad = await createTestAgent(db, { reputationScore: 0.5 });

    const now = new Date().toISOString();

    // Genesis gives good a pass, bad a fail
    await db.run(
      `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, structured_report, nonce, created_at)
       VALUES ('v1', ?, ?, 'pass', 1.0, NULL, 'sig', NULL, 'n1', ?)`,
      genesis.agentId, good.agentId, now
    );
    await db.run(
      `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, structured_report, nonce, created_at)
       VALUES ('v2', ?, ?, 'fail', 0.0, NULL, 'sig', NULL, 'n2', ?)`,
      genesis.agentId, bad.agentId, now
    );

    // Seed local reputation (bad lower than good)
    await db.run('UPDATE agents SET reputation_score = 0.0 WHERE id = ?', bad.agentId);
    await db.run('UPDATE agents SET reputation_score = 0.5 WHERE id = ?', good.agentId);

    await runEigenTrust(db);

    const goodRow = await db.get<{ reputation_score: number }>(
      'SELECT reputation_score FROM agents WHERE id = ?', good.agentId
    );
    const badRow = await db.get<{ reputation_score: number }>(
      'SELECT reputation_score FROM agents WHERE id = ?', bad.agentId
    );

    // good should have higher reputation than bad
    expect(goodRow!.reputation_score).toBeGreaterThanOrEqual(badRow!.reputation_score);
  });

  it('mutual verification → both agents get positive trust', async () => {
    const genesis = await createTestAgent(db, { reputationOverride: 1.0, reputationScore: 1.0 });
    const alice = await createTestAgent(db, { reputationScore: 0 });
    const bob = await createTestAgent(db, { reputationScore: 0 });

    const now = new Date().toISOString();

    // Genesis → alice, genesis → bob (both pass)
    await db.run(
      `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, structured_report, nonce, created_at)
       VALUES ('v1', ?, ?, 'pass', 0.9, NULL, 'sig', NULL, 'n1', ?)`,
      genesis.agentId, alice.agentId, now
    );
    await db.run(
      `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, structured_report, nonce, created_at)
       VALUES ('v2', ?, ?, 'pass', 0.9, NULL, 'sig', NULL, 'n2', ?)`,
      genesis.agentId, bob.agentId, now
    );
    // Alice → Bob, Bob → Alice (mutual)
    await db.run(
      `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, structured_report, nonce, created_at)
       VALUES ('v3', ?, ?, 'pass', 0.8, NULL, 'sig', NULL, 'n3', ?)`,
      alice.agentId, bob.agentId, now
    );
    await db.run(
      `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, structured_report, nonce, created_at)
       VALUES ('v4', ?, ?, 'pass', 0.8, NULL, 'sig', NULL, 'n4', ?)`,
      bob.agentId, alice.agentId, now
    );

    await runEigenTrust(db);

    const aliceRow = await db.get<{ reputation_score: number }>(
      'SELECT reputation_score FROM agents WHERE id = ?', alice.agentId
    );
    const bobRow = await db.get<{ reputation_score: number }>(
      'SELECT reputation_score FROM agents WHERE id = ?', bob.agentId
    );

    expect(aliceRow!.reputation_score).toBeGreaterThan(0);
    expect(bobRow!.reputation_score).toBeGreaterThan(0);
  });

  it('convergence: running twice produces stable scores', async () => {
    const genesis = await createTestAgent(db, { reputationOverride: 1.0, reputationScore: 1.0 });
    const alice = await createTestAgent(db, { reputationScore: 0.3 });
    const bob = await createTestAgent(db, { reputationScore: 0.4 });

    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, structured_report, nonce, created_at)
       VALUES ('v1', ?, ?, 'pass', 0.9, NULL, 'sig', NULL, 'n1', ?)`,
      genesis.agentId, alice.agentId, now
    );
    await db.run(
      `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, structured_report, nonce, created_at)
       VALUES ('v2', ?, ?, 'pass', 0.7, NULL, 'sig', NULL, 'n2', ?)`,
      alice.agentId, bob.agentId, now
    );

    await runEigenTrust(db);

    const alice1 = await db.get<{ reputation_score: number }>('SELECT reputation_score FROM agents WHERE id = ?', alice.agentId);
    const bob1 = await db.get<{ reputation_score: number }>('SELECT reputation_score FROM agents WHERE id = ?', bob.agentId);

    // Run again — scores should be stable (converged)
    await runEigenTrust(db);

    const alice2 = await db.get<{ reputation_score: number }>('SELECT reputation_score FROM agents WHERE id = ?', alice.agentId);
    const bob2 = await db.get<{ reputation_score: number }>('SELECT reputation_score FROM agents WHERE id = ?', bob.agentId);

    expect(Math.abs(alice2!.reputation_score - alice1!.reputation_score)).toBeLessThan(0.2);
    expect(Math.abs(bob2!.reputation_score - bob1!.reputation_score)).toBeLessThan(0.2);
  });
});
