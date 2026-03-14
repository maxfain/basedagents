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
    }
  | {
      type: 'message.received';
      agent_id: string;
      from: { agent_id: string; name: string };
      message: { id: string; type: string; subject: string; body: string; sent_at: string };
      reply_url: string;
    }
  | {
      type: 'message.reply';
      agent_id: string;
      from: { agent_id: string; name: string };
      message: { id: string; type: string; subject: string; body: string; sent_at: string };
      reply_to_message_id: string;
      reply_url: string;
    }
  | {
      type: 'task.available';
      agent_id: string;
      task: { task_id: string; title: string; description: string; category: string | null; required_capabilities: string[] | null; output_format: string };
    }
  | {
      type: 'task.claimed';
      agent_id: string;
      task_id: string;
      claimed_by: { agent_id: string; name: string };
    }
  | {
      type: 'task.submitted';
      agent_id: string;
      task_id: string;
      submitted_by: { agent_id: string; name: string };
      summary: string;
    }
  | {
      type: 'task.verified';
      agent_id: string;
      task_id: string;
    }
  | {
      type: 'task.cancelled';
      agent_id: string;
      task_id: string;
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
