/**
 * Outbound email for the Keyring control plane (recovery magic links).
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * Provider-pluggable so nothing blocks on an email vendor decision:
 *   - RESEND_API_KEY set   → Resend HTTP API (Workers-compatible, plain fetch).
 *   - otherwise            → log-only sender (dev/local: prints the link).
 * Tests inject a recording sender through the Hono context (c.set('emailSender')),
 * which always wins over the env-derived one.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

const DEFAULT_FROM = 'BasedAgents <no-reply@basedagents.ai>';

class LogEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    // Dev/local only — a deployment without an email provider cannot deliver
    // recovery links, and this makes that unmissable in the logs.
    console.log(`[email:log-only] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`);
  }
}

class ResendEmailSender implements EmailSender {
  constructor(
    private apiKey: string,
    private from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`email send failed (${res.status}): ${body.slice(0, 200)}`);
    }
  }
}

/** Resolve the sender from the Worker env (opaque map — same pattern as config.ts). */
export function emailSenderFromEnv(env: unknown): EmailSender {
  const e = (env ?? {}) as Record<string, string | undefined>;
  if (e.RESEND_API_KEY) {
    return new ResendEmailSender(e.RESEND_API_KEY, e.EMAIL_FROM || DEFAULT_FROM);
  }
  return new LogEmailSender();
}

/** The console origin recovery links point at. */
export function consoleOrigin(env: unknown): string {
  const e = (env ?? {}) as Record<string, string | undefined>;
  return e.KEYRING_CONSOLE_ORIGIN || 'https://app.basedagents.ai';
}
