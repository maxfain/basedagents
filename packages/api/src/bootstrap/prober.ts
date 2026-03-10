/**
 * Bootstrap Prober
 *
 * When the registry has fewer than BOOTSTRAP_THRESHOLD active agents,
 * the registry itself probes each pending agent's contact_endpoint
 * to verify reachability and activate them — no peer verification needed.
 *
 * Rules:
 * - Probe pending agents that have a contact_endpoint set
 * - HTTP GET to contact_endpoint with a 10s timeout
 * - 2xx response → mark agent as active
 * - Non-2xx or network error → increment probe_attempts
 * - probe_attempts >= 3 → suspend agent (unreachable)
 * - Skip agents probed within the last 5 minutes
 */

import type { DBAdapter } from '../db/adapter.js';

const MAX_PROBE_ATTEMPTS = 3;
const PROBE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const PROBE_TIMEOUT_MS = 10_000; // 10 seconds

interface PendingAgent {
  id: string;
  name: string;
  contact_endpoint: string;
  probe_attempts: number;
  last_probe_at: string | null;
}

/**
 * Probe a single agent endpoint.
 * Returns true if reachable (2xx), false otherwise.
 */
async function probeEndpoint(url: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'BasedAgents-Bootstrap-Prober/1.0' },
    });
    clearTimeout(timeout);
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

/**
 * Run one round of bootstrap probing.
 * Returns a summary of what happened.
 */
export async function runBootstrapProber(
  db: DBAdapter,
  bootstrapThreshold: number
): Promise<{ activated: string[]; suspended: string[]; skipped: number; probed: number }> {
  const result = { activated: [] as string[], suspended: [] as string[], skipped: 0, probed: 0 };

  // Only run in bootstrap mode (< threshold active agents)
  const activeCount = await db.get<{ count: number }>(
    "SELECT COUNT(*) as count FROM agents WHERE status = 'active'"
  );
  if ((activeCount?.count ?? 0) >= bootstrapThreshold) {
    return result; // Not in bootstrap mode
  }

  // Get pending agents with a contact_endpoint, not recently probed
  const now = new Date();
  const cooldownCutoff = new Date(now.getTime() - PROBE_COOLDOWN_MS).toISOString();

  const pendingAgents = await db.all<PendingAgent>(
    `SELECT id, name, contact_endpoint, probe_attempts, last_probe_at
     FROM agents
     WHERE status = 'pending'
       AND contact_endpoint IS NOT NULL
       AND (last_probe_at IS NULL OR last_probe_at < ?)
       AND probe_attempts < ?
     ORDER BY registered_at ASC
     LIMIT 20`,
    cooldownCutoff,
    MAX_PROBE_ATTEMPTS
  );

  if (!pendingAgents.length) {
    return result;
  }

  for (const agent of pendingAgents) {
    result.probed++;
    console.log(`[bootstrap-prober] Probing ${agent.name} (${agent.id}) at ${agent.contact_endpoint}`);

    const probe = await probeEndpoint(agent.contact_endpoint);
    const probeResult = probe.ok
      ? `ok:${probe.status}`
      : probe.error
        ? `error:${probe.error}`
        : `fail:${probe.status}`;

    if (probe.ok) {
      // Activate the agent
      await db.run(
        `UPDATE agents
         SET status = 'active', probe_attempts = probe_attempts + 1, last_probe_at = ?, last_probe_result = ?
         WHERE id = ?`,
        now.toISOString(),
        probeResult,
        agent.id
      );
      result.activated.push(agent.id);
      console.log(`[bootstrap-prober] ✅ Activated ${agent.name} (${agent.id})`);
    } else {
      const newAttempts = agent.probe_attempts + 1;
      if (newAttempts >= MAX_PROBE_ATTEMPTS) {
        // Suspend after max attempts
        await db.run(
          `UPDATE agents
           SET status = 'suspended', probe_attempts = ?, last_probe_at = ?, last_probe_result = ?
           WHERE id = ?`,
          newAttempts,
          now.toISOString(),
          probeResult,
          agent.id
        );
        result.suspended.push(agent.id);
        console.log(`[bootstrap-prober] ❌ Suspended ${agent.name} (${agent.id}) after ${newAttempts} failed probes`);
      } else {
        // Increment probe attempts
        await db.run(
          `UPDATE agents
           SET probe_attempts = ?, last_probe_at = ?, last_probe_result = ?
           WHERE id = ?`,
          newAttempts,
          now.toISOString(),
          probeResult,
          agent.id
        );
        console.log(`[bootstrap-prober] ⚠️ Probe failed for ${agent.name} (attempt ${newAttempts}/${MAX_PROBE_ATTEMPTS}): ${probeResult}`);
      }
    }
  }

  return result;
}
