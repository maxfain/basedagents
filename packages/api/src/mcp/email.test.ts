/**
 * sendMcpMagicLink unit tests (SPEC §3 step 2): the emitted link points at the
 * MCP HOST (not the console) and carries the token + authreq id as QUERY params
 * (`?lt=&req=`, never a `#fragment`), and the injected sender is called exactly
 * once — proving the outbox is fully capturable through dependency injection.
 */
import { describe, it, expect } from 'vitest';
import type { EmailMessage, EmailSender } from '../control/email.js';
import { sendMcpMagicLink } from './email.js';

/** Recording sender — captures every message so tests can assert the outbox. */
class RecordingSender implements EmailSender {
  outbox: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.outbox.push(message);
  }
}

const RESOURCE_HOST = 'https://mcp.basedagents.ai';

describe('sendMcpMagicLink', () => {
  it('sends once to the recipient with a subject and body', async () => {
    const sender = new RecordingSender();
    await sendMcpMagicLink(sender, {
      email: 'owner@example.com',
      token: 'tok-abc',
      authreqId: 'authreq-1',
      resourceHost: RESOURCE_HOST,
    });
    expect(sender.outbox).toHaveLength(1);
    expect(sender.outbox[0].to).toBe('owner@example.com');
    expect(sender.outbox[0].subject).toBeTruthy();
    expect(sender.outbox[0].text).toContain('/oauth/continue');
  });

  it('builds the link to the MCP host with lt+req query params (not a fragment)', async () => {
    const sender = new RecordingSender();
    await sendMcpMagicLink(sender, {
      email: 'owner@example.com',
      token: 'tok-xyz',
      authreqId: 'req-42',
      resourceHost: RESOURCE_HOST,
    });
    // Pull the link out of the body and parse it as a real URL.
    const match = sender.outbox[0].text.match(/https:\/\/\S+/);
    expect(match).not.toBeNull();
    const url = new URL(match![0]);

    // Points at the MCP host — never the console.
    expect(url.origin).toBe('https://mcp.basedagents.ai');
    expect(url.pathname).toBe('/oauth/continue');

    // Token + authreq id are QUERY params so a fragment-stripping webview still
    // delivers them to the server on the GET.
    expect(url.searchParams.get('lt')).toBe('tok-xyz');
    expect(url.searchParams.get('req')).toBe('req-42');
    expect(url.hash).toBe(''); // NOT a #fragment
  });

  it('percent-encodes token/authreq id and never double-slashes the path', async () => {
    const sender = new RecordingSender();
    await sendMcpMagicLink(sender, {
      email: 'owner@example.com',
      token: 'a b+c/d=', // needs encoding
      authreqId: 'r&q',
      resourceHost: `${RESOURCE_HOST}/`, // trailing slash must be trimmed
    });
    const url = new URL(sender.outbox[0].text.match(/https:\/\/\S+/)![0]);
    expect(url.pathname).toBe('/oauth/continue'); // no //oauth/continue
    // URLSearchParams round-trips the raw values back out.
    expect(url.searchParams.get('lt')).toBe('a b+c/d=');
    expect(url.searchParams.get('req')).toBe('r&q');
  });

  it('does not send when the sender rejects (error propagates, no swallow)', async () => {
    const boom: EmailSender = {
      async send() {
        throw new Error('provider down');
      },
    };
    await expect(
      sendMcpMagicLink(boom, {
        email: 'owner@example.com',
        token: 't',
        authreqId: 'r',
        resourceHost: RESOURCE_HOST,
      }),
    ).rejects.toThrow('provider down');
  });
});
