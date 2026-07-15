import { describe, it, expect, vi, afterEach } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { generateKeypair } from '../crypto.js';
import { base58Encode, base64ToBytes } from '../util.js';
import { ControlClient, ControlClientError } from './control-client.js';

const API = 'https://api.test';

/** Recompute the AgentSig message daemonAuth verifies and check the signature. */
async function assertValidAgentSig(
  req: { method: string; path: string; headers: Record<string, string>; body: string },
  ownerPub: Uint8Array,
): Promise<void> {
  const auth = req.headers['Authorization'] ?? req.headers['authorization'];
  expect(auth).toMatch(/^AgentSig /);
  const [b58pub, b64sig] = auth.slice('AgentSig '.length).split(':');
  expect(b58pub).toBe(base58Encode(ownerPub));

  const ts = req.headers['X-Timestamp'];
  const nonce = req.headers['X-Nonce'];
  expect(ts).toBeTruthy();
  expect(nonce).toBeTruthy();

  const bodyHash = bytesToHex(sha256(new TextEncoder().encode(req.body)));
  const message = `${req.method}:${req.path}:${ts}:${bodyHash}:${nonce}`;
  const ok = await ed.verifyAsync(base64ToBytes(b64sig), new TextEncoder().encode(message), ownerPub);
  expect(ok).toBe(true); // exactly what the control plane's daemonAuth checks
}

function mockFetch(handler: (req: { method: string; path: string; headers: Record<string, string>; body: string }) => { status?: number; json: unknown }) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const headers = init.headers as Record<string, string>;
    const body = (init.body as string | undefined) ?? '';
    const { status = 200, json } = handler({ method: init.method ?? 'GET', path, headers, body });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'x',
      json: async () => json,
    } as Response;
  });
}

describe('ControlClient — AgentSig signing the daemon uses', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('signs GET /daemon/approvals with a signature daemonAuth accepts, and returns the approvals', async () => {
    const owner = await generateKeypair();
    let captured: Parameters<Parameters<typeof mockFetch>[0]>[0] | null = null;
    const fetchMock = mockFetch((req) => {
      captured = req;
      return { json: { approvals: [{ id: 'gap_1', nonce: 'n', credential_id: 'cred_1', agent_id: 'ag_x', agent_pubkey: 'P', action_hash: 'h', constraints: {}, assertion: { credentialId: 'c', authenticatorData: 'a', clientDataJSON: 'cd', signature: 's' } }] } };
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new ControlClient(owner, API);
    const approvals = await client.getApprovals();

    expect(approvals).toHaveLength(1);
    expect(approvals[0].id).toBe('gap_1');
    expect(captured!.method).toBe('GET');
    expect(captured!.path).toBe('/v1/owner/daemon/approvals');
    expect(captured!.body).toBe(''); // GET signs sha256('')
    await assertValidAgentSig(captured!, owner.publicKey);
  });

  it('signs POST confirm over the exact JSON body', async () => {
    const owner = await generateKeypair();
    let captured: Parameters<Parameters<typeof mockFetch>[0]>[0] | null = null;
    const fetchMock = mockFetch((req) => { captured = req; return { json: { status: 'confirmed' } }; });
    vi.stubGlobal('fetch', fetchMock);

    const client = new ControlClient(owner, API);
    await client.confirmApproval('gap_9', { daemonGrantId: 'grant_abc' });

    expect(captured!.method).toBe('POST');
    expect(captured!.path).toBe('/v1/owner/daemon/approvals/gap_9/confirm');
    expect(JSON.parse(captured!.body)).toEqual({ daemon_grant_id: 'grant_abc' });
    await assertValidAgentSig(captured!, owner.publicKey);
  });

  it('reports a failure body when confirming a rejection', async () => {
    const owner = await generateKeypair();
    let captured: Parameters<Parameters<typeof mockFetch>[0]>[0] | null = null;
    vi.stubGlobal('fetch', mockFetch((req) => { captured = req; return { json: { status: 'failed' } }; }));
    await new ControlClient(owner, API).confirmApproval('gap_9', { error: 'not anchored' });
    expect(JSON.parse(captured!.body)).toEqual({ error: 'not anchored' });
  });

  it('surfaces control-plane errors with status + message', async () => {
    const owner = await generateKeypair();
    vi.stubGlobal('fetch', mockFetch(() => ({ status: 401, json: { message: 'invalid signature' } })));
    await expect(new ControlClient(owner, API).getApprovals())
      .rejects.toMatchObject({ name: 'ControlClientError', status: 401 });
    await expect(new ControlClient(owner, API).getApprovals()).rejects.toThrowError(ControlClientError);
  });

  it('getPasskeys returns the rp config + passkeys', async () => {
    const owner = await generateKeypair();
    vi.stubGlobal('fetch', mockFetch(() => ({ json: { rp_id: 'basedagents.ai', origins: ['https://app.basedagents.ai'], passkeys: [{ credential_id: 'c1', public_key_hex: '04ab', nickname: 'laptop', created_at: '2026-07-15' }] } })));
    const r = await new ControlClient(owner, API).getPasskeys();
    expect(r.rp_id).toBe('basedagents.ai');
    expect(r.passkeys[0].credential_id).toBe('c1');
  });
});
