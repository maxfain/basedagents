/**
 * Regression (review fix, board spec §4): the confusable-skeleton gate must
 * cover the PATCH rename path, not just register/complete. Without it, a rename
 * is the bypass — register an innocuous name that clears the skeleton check,
 * then PATCH to a homoglyph of a target.
 */
import { describe, it, expect } from 'vitest';
import { setupTestDb, createTestApp, createTestAgent, signRequest } from '../test-helpers.js';
import { nameSkeleton } from '../lib/skeleton.js';

async function patchName(app: ReturnType<typeof createTestApp>, agent: Awaited<ReturnType<typeof createTestAgent>>, name: string) {
  const bodyStr = JSON.stringify({ name });
  const path = `/v1/agents/${agent.agentId}/profile`;
  const headers = await signRequest(agent, 'PATCH', path, bodyStr);
  const res = await app.request(path, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: bodyStr,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('PATCH rename honors the confusable-skeleton gate', () => {
  it('rejects renaming to a Cyrillic homoglyph of an existing agent (409), row untouched', async () => {
    const db = setupTestDb();
    const app = createTestApp(db);

    const victim = await createTestAgent(db, { name: 'Claude Helper' });
    await db.run('UPDATE agents SET name_skeleton = ? WHERE id = ?', nameSkeleton('Claude Helper'), victim.agentId);
    const attacker = await createTestAgent(db, { name: 'InnocuousBot' });
    await db.run('UPDATE agents SET name_skeleton = ? WHERE id = ?', nameSkeleton('InnocuousBot'), attacker.agentId);

    // 'Сlaude Helper' — Cyrillic Es (U+0421) for the Latin C: raw strings
    // differ, skeletons collide.
    const impersonating = 'Сlaude Helper';
    expect(impersonating).not.toBe('Claude Helper');
    expect(nameSkeleton(impersonating)).toBe(nameSkeleton('Claude Helper'));

    const { status, json } = await patchName(app, attacker, impersonating);
    expect(status).toBe(409);
    expect(String(json.message)).toContain('confusable');

    // Nothing moved: name and skeleton still describe the innocuous original.
    const row = await db.get<{ name: string; name_skeleton: string }>(
      'SELECT name, name_skeleton FROM agents WHERE id = ?', attacker.agentId
    );
    expect(row!.name).toBe('InnocuousBot');
    expect(row!.name_skeleton).toBe(nameSkeleton('InnocuousBot'));
  });

  it('allows a genuinely distinct rename and re-stores its skeleton', async () => {
    const db = setupTestDb();
    const app = createTestApp(db);
    const agent = await createTestAgent(db, { name: 'InnocuousBot' });
    await db.run('UPDATE agents SET name_skeleton = ? WHERE id = ?', nameSkeleton('InnocuousBot'), agent.agentId);

    const { status } = await patchName(app, agent, 'Distinct New Name');
    expect(status).toBe(200);
    const row = await db.get<{ name: string; name_skeleton: string }>(
      'SELECT name, name_skeleton FROM agents WHERE id = ?', agent.agentId
    );
    expect(row!.name).toBe('Distinct New Name');
    // Skeleton updated to the new name — stays truthful for the next writer's check.
    expect(row!.name_skeleton).toBe(nameSkeleton('Distinct New Name'));
  });
});
