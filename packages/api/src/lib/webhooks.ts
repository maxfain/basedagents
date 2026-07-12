/**
 * Fire-and-forget webhook delivery module.
 * Never throws — errors are swallowed after logging to console.error.
 *
 * MED-6: All webhook deliveries include an HMAC-SHA256 signature header:
 *   X-BasedAgents-Signature: sha256=<hex_hmac>
 * Recipients should verify this header using their webhook_secret to ensure
 * the payload was sent by BasedAgents and has not been tampered with.
 * The HMAC is computed over the raw JSON body using the agent's webhook_secret.
 */
import { isSafeUrl } from './url-validator.js';

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
      task: {
        task_id: string;
        title: string;
        description: string;
        category: string | null;
        required_capabilities: string[] | null;
        output_format: string;
        bounty: { amount: string; token: string; network: string } | null;
      };
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
      type: 'task.delivered';
      agent_id: string;
      task_id: string;
      delivered_by: { agent_id: string; name: string };
      summary: string;
      receipt_id: string;
    }
  | {
      type: 'task.verified';
      agent_id: string;
      task_id: string;
      chain_sequence: number;
      chain_entry_hash: string;
      payment_settled: boolean;
      payment_tx_hash: string | null;
    }
  | {
      type: 'task.disputed';
      agent_id: string;
      task_id: string;
      reason: string | null;
    }
  | {
      type: 'task.cancelled';
      agent_id: string;
      task_id: string;
    };

/**
 * Compute HMAC-SHA256 hex digest using Web Crypto API.
 */
async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * POST a webhook event to the given URL.
 * Fire-and-forget: always resolves without throwing.
 * 5-second timeout via AbortController.
 *
 * If a webhookSecret is provided, the request includes:
 *   X-BasedAgents-Signature: sha256=<hmac_hex>
 */
export async function fireWebhook(url: string, event: WebhookEvent, webhookSecret?: string | null): Promise<void> {
  // Defense in depth: webhook URLs are validated at registration/update time,
  // but re-validate at delivery time so rows stored before validation existed
  // (or mutated out of band) can't turn webhook delivery into blind SSRF.
  if (!isSafeUrl(url)) {
    console.error(`[webhook] blocked delivery to unsafe URL (event: ${event.type})`);
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const body = JSON.stringify(event);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-BasedAgents-Event': event.type,
      'User-Agent': 'BasedAgents-Webhook/1.0',
    };

    if (webhookSecret) {
      const hmac = await hmacSha256Hex(webhookSecret, body);
      headers['X-BasedAgents-Signature'] = `sha256=${hmac}`;
    }

    await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    console.error(`[webhook] delivery failed to ${url} (event: ${event.type}):`, err);
  } finally {
    clearTimeout(timeout);
  }
}
