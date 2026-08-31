/**
 * Outbound email for the MCP OAuth AS magic-link login (SPEC §3, step 2).
 *
 * PROPRIETARY control-plane code — see ../control/LICENSE and LICENSING.md.
 *
 * The AS runs its OWN magic link and MUST NOT reuse the console's
 * `/login/email` (which hard-codes `consoleOrigin()/login#t=` and would land
 * the user on the console, minting a `ba_owner_session`). This link points at
 * the MCP HOST instead, and carries the token + authreq id as QUERY params
 * (`?lt=&req=`, NOT a `#fragment`) so the server actually receives them on the
 * `GET /oauth/continue` even inside stripped email webviews that drop fragments.
 *
 * Dependency-injected: the caller hands us the resolved `EmailSender` (env-derived
 * via `emailSenderFromEnv`, or a recording sender injected through the Hono
 * context in tests) — this module never touches the env or picks a provider, so
 * a test can capture the exact outbox with one line.
 */

import type { EmailSender } from '../control/email.js';

export interface McpMagicLinkParams {
  /** Recipient owner email (already normalized by the caller). */
  email: string;
  /** The PLAINTEXT single-use login token — only its sha256hex is persisted. */
  token: string;
  /** The authorization-request id this login is bound to (login-fixation defense). */
  authreqId: string;
  /**
   * Origin of the MCP host, e.g. `https://mcp.basedagents.ai` (MCP_ISSUER). The
   * link is built against THIS host, never the console — that separation is the
   * whole point of the AS-owned magic link.
   */
  resourceHost: string;
}

/**
 * Build the `GET /oauth/continue` link to the MCP host and send it via the
 * injected sender. Returns nothing — the outbox is the observable effect.
 *
 * `URLSearchParams` gives us correct percent-encoding of the base64url token and
 * authreq id, and guarantees they land as `?lt=&req=` query params (not a
 * fragment) so `/oauth/continue` receives them server-side.
 */
export async function sendMcpMagicLink(
  sender: EmailSender,
  { email, token, authreqId, resourceHost }: McpMagicLinkParams,
): Promise<void> {
  // Trim a trailing slash so we never emit `//oauth/continue`.
  const host = resourceHost.replace(/\/+$/, '');
  const qs = new URLSearchParams({ lt: token, req: authreqId });
  const link = `${host}/oauth/continue?${qs.toString()}`;

  await sender.send({
    to: email,
    subject: 'Authorize your BasedAgents connector',
    text:
      `Click within 15 minutes to authorize the connection to your BasedAgents ` +
      `owner account:\n\n` +
      `${link}\n\n` +
      `If you didn't request this, ignore this email.`,
  });
}
