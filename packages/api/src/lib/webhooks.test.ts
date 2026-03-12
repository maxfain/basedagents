import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireWebhook } from './webhooks.js';
import type { WebhookEvent } from './webhooks.js';

const sampleEvent: WebhookEvent = {
  type: 'verification.received',
  agent_id: 'ag_test123',
  verification_id: 'ver-uuid',
  verifier_id: 'ag_verifier',
  result: 'pass',
  coherence_score: 0.9,
  reputation_delta: 0.05,
  new_reputation: 0.55,
};

describe('fireWebhook', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls fetch with correct method (POST)', async () => {
    await fireWebhook('https://example.com/hook', sampleEvent);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect(opts.method).toBe('POST');
  });

  it('sends correct Content-Type header', async () => {
    await fireWebhook('https://example.com/hook', sampleEvent);
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('sends X-BasedAgents-Event header matching event.type', async () => {
    await fireWebhook('https://example.com/hook', sampleEvent);
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers['X-BasedAgents-Event']).toBe(sampleEvent.type);
  });

  it('sends event data as JSON body', async () => {
    await fireWebhook('https://example.com/hook', sampleEvent);
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.type).toBe(sampleEvent.type);
    expect(body.agent_id).toBe(sampleEvent.agent_id);
  });

  it('sends User-Agent header', async () => {
    await fireWebhook('https://example.com/hook', sampleEvent);
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers['User-Agent']).toContain('BasedAgents');
  });

  it('does not throw on network error (fire-and-forget)', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    await expect(fireWebhook('https://example.com/hook', sampleEvent)).resolves.toBeUndefined();
  });

  it('does not throw on HTTP error response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(fireWebhook('https://example.com/hook', sampleEvent)).resolves.toBeUndefined();
  });

  it('passes AbortSignal to fetch for timeout control', async () => {
    // Verify that fireWebhook passes an AbortSignal to fetch
    let capturedSignal: AbortSignal | undefined;

    mockFetch.mockImplementation((_url: string, opts: RequestInit) => {
      capturedSignal = opts.signal as AbortSignal;
      // Immediately resolve so we don't block the test
      return Promise.resolve({ ok: true, status: 200 });
    });

    await fireWebhook('https://example.com/hook', sampleEvent);

    // The signal should be defined and be an AbortSignal
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal instanceof AbortSignal).toBe(true);
    // It should not yet be aborted since we resolved quickly
    expect(capturedSignal!.aborted).toBe(false);
  });

  it('works with status.changed event type', async () => {
    const statusEvent: WebhookEvent = {
      type: 'status.changed',
      agent_id: 'ag_test',
      old_status: 'pending',
      new_status: 'active',
    };
    await fireWebhook('https://example.com/hook', statusEvent);
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers['X-BasedAgents-Event']).toBe('status.changed');
    const body = JSON.parse(opts.body);
    expect(body.new_status).toBe('active');
  });

  it('works with agent.registered event type', async () => {
    const regEvent: WebhookEvent = {
      type: 'agent.registered',
      agent_id: 'ag_new',
      name: 'NewAgent',
      capabilities: ['code-gen'],
    };
    await fireWebhook('https://example.com/hook', regEvent);
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers['X-BasedAgents-Event']).toBe('agent.registered');
  });
});
