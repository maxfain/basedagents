/**
 * Fire-and-forget webhook delivery module.
 * Never throws — errors are swallowed after logging to console.error.
 */

export type WebhookEvent =
  | {
      type: 'verification.received';
      agent_id: string;
      verification_id: string;
      verifier_id: string;
      result: 'pass' | 'fail' | 'timeout';
      coherence_score: number | null;
      reputation_delta: number;
      new_reputation: number;
    }
  | {
      type: 'status.changed';
      agent_id: string;
      old_status: string;
      new_status: string;
    }
  | {
      type: 'agent.registered';
      agent_id: string;
      name: string;
      capabilities: string[];
    };

/**
 * POST a webhook event to the given URL.
 * Fire-and-forget: always resolves without throwing.
 * 5-second timeout via AbortController.
 */
export async function fireWebhook(url: string, event: WebhookEvent): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BasedAgents-Event': event.type,
        'User-Agent': 'BasedAgents-Webhook/1.0',
      },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
  } catch (err) {
    console.error(`[webhook] delivery failed to ${url} (event: ${event.type}):`, err);
  } finally {
    clearTimeout(timeout);
  }
}
