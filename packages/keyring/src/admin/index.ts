/**
 * Local admin control plane (KEYRING_SPEC §5) — `based admin`.
 *
 * A tiny node:http server bound to 127.0.0.1 that serves one self-contained
 * HTML page plus a token-guarded JSON API over the Keyring core. The vault
 * never leaves the machine; the page makes no external requests.
 *
 * Auth model: a random per-session token is generated at startup and embedded
 * in the printed URL (?token=...). GET / serves the static page without auth —
 * it contains no data. Every /api call must carry the token in X-Admin-Token;
 * comparison is constant-time. Secrets are never exposed: the views strip
 * sealed material, and no endpoint decrypts anything.
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';
import { KeyringError, type Keyring } from '../keyring.js';
import type { AccessEventType, GrantConstraints, TimelineFilter } from '../types.js';
import { ADMIN_PAGE_HTML } from './page.js';

const DEFAULT_PORT = 4571;
const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_TIMELINE_LIMIT = 200;
const MAX_TIMELINE_LIMIT = 10_000;

const ACCESS_EVENT_TYPES: readonly AccessEventType[] = [
  'vault_created', 'identity_added', 'identity_removed',
  'credential_added', 'credential_updated', 'credential_removed',
  'grant_created', 'grant_revoked', 'kill_switch',
  'lease', 'lease_denied', 'run', 'render',
  'request_created', 'request_approved', 'request_denied',
];

export interface AdminServerOptions {
  keyring: Keyring;
  /** Explicit port — fails loudly if busy. Defaults to 4571, falling back to an OS-assigned port. */
  port?: number;
  /** Bind host. Defaults to 127.0.0.1 — never a public interface unless explicitly asked. */
  host?: string;
}

export interface AdminServerHandle {
  /** Ready-to-open URL including the one-time access token. */
  url: string;
  port: number;
  close: () => void;
}

/** Error with an HTTP status — thrown by handlers, mapped to a JSON response. */
class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function sendPage(res: http.ServerResponse, isHead: boolean): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // The page is fully inline and talks only to this server.
    'Content-Security-Policy':
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
      "connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(isHead ? undefined : ADMIN_PAGE_HTML);
}

/** Constant-time token check (timingSafeEqual requires equal lengths; unequal lengths reject). */
function tokenMatches(expected: Buffer, header: string | string[] | undefined): boolean {
  if (typeof header !== 'string') return false;
  const provided = Buffer.from(header, 'utf8');
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

/** Read and parse a JSON object body, capped at 64KB. */
function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (overflow) {
        // Keep draining so the 413 response can be delivered — but not forever.
        if (size > 16 * MAX_BODY_BYTES) req.destroy();
        return;
      }
      if (size > MAX_BODY_BYTES) {
        overflow = true;
        chunks.length = 0;
        reject(new HttpError(413, 'Request body too large (64KB max)'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflow) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        reject(new HttpError(400, 'Request body must be a JSON object'));
        return;
      }
      resolve(parsed as Record<string, unknown>);
    });
    req.on('error', err => reject(err));
  });
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `Missing required field: ${field}`);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `Field ${field} must be a string`);
  return value;
}

function parseConstraints(raw: unknown): GrantConstraints {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'constraints must be an object');
  }
  const c = raw as Record<string, unknown>;
  const out: GrantConstraints = {};
  if (c.expires_at !== undefined && c.expires_at !== null && c.expires_at !== '') {
    if (typeof c.expires_at !== 'string') throw new HttpError(400, 'constraints.expires_at must be an ISO timestamp string');
    out.expires_at = c.expires_at;
  }
  if (c.max_lease_ttl_seconds !== undefined && c.max_lease_ttl_seconds !== null && c.max_lease_ttl_seconds !== '') {
    const n = Number(c.max_lease_ttl_seconds);
    if (!Number.isFinite(n)) throw new HttpError(400, 'constraints.max_lease_ttl_seconds must be a number');
    out.max_lease_ttl_seconds = n;
  }
  if (c.max_uses !== undefined && c.max_uses !== null && c.max_uses !== '') {
    const n = Number(c.max_uses);
    if (!Number.isFinite(n)) throw new HttpError(400, 'constraints.max_uses must be a number');
    out.max_uses = n;
  }
  if (c.project !== undefined && c.project !== null && c.project !== '') {
    if (typeof c.project !== 'string') throw new HttpError(400, 'constraints.project must be a string');
    out.project = c.project;
  }
  return out;
}

/** Filter query params the timeline endpoint understands — anything else is rejected. */
const TIMELINE_PARAMS = new Set(['agent', 'credential_id', 'event_type', 'project', 'since', 'until', 'limit']);

function parseIsoParam(params: URLSearchParams, name: string): string | undefined {
  const raw = params.get(name);
  if (!raw) return undefined;
  if (Number.isNaN(Date.parse(raw))) throw new HttpError(400, `${name} must be an ISO-8601 timestamp`);
  return raw;
}

function parseTimelineFilter(params: URLSearchParams): TimelineFilter {
  for (const key of params.keys()) {
    if (!TIMELINE_PARAMS.has(key)) throw new HttpError(400, `Unknown timeline filter: ${key}`);
  }
  const filter: TimelineFilter = {};
  const agent = params.get('agent');
  if (agent) filter.agent = agent;
  const credentialId = params.get('credential_id');
  if (credentialId) filter.credential_id = credentialId;
  const eventType = params.get('event_type');
  if (eventType) {
    if (!(ACCESS_EVENT_TYPES as readonly string[]).includes(eventType)) {
      throw new HttpError(400, `Unknown event_type: ${eventType}`);
    }
    filter.event_type = eventType as AccessEventType;
  }
  const project = params.get('project');
  if (project) filter.project = project;
  const since = parseIsoParam(params, 'since');
  if (since) filter.since = since;
  const until = parseIsoParam(params, 'until');
  if (until) filter.until = until;
  const limitRaw = params.get('limit');
  let limit = DEFAULT_TIMELINE_LIMIT;
  if (limitRaw) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'limit must be a positive integer');
    limit = Math.min(n, MAX_TIMELINE_LIMIT);
  }
  filter.limit = limit;
  return filter;
}

async function handleApi(
  keyring: Keyring,
  url: URL,
  method: string,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const path = url.pathname;

  // ── Read endpoints ──

  if (path === '/api/overview' && method === 'GET') {
    const vault = keyring.vault();
    sendJson(res, 200, {
      ok: true,
      owner: vault.owner,
      dir: keyring.store.dir,
      agents: keyring.agentsView(),
      credentials: keyring.credentialsView(),
      requests: keyring.requestsView(),
      pending_requests: keyring.requestsView('pending').length,
    });
    return;
  }

  if (path === '/api/timeline' && method === 'GET') {
    const filter = parseTimelineFilter(url.searchParams);
    sendJson(res, 200, { ok: true, events: keyring.timeline(filter) });
    return;
  }

  if (path === '/api/verify' && method === 'GET') {
    // VerifyLogResult carries its own `ok` (log validity) — returned verbatim per contract.
    sendJson(res, 200, await keyring.verifyLog());
    return;
  }

  if (path === '/api/export' && method === 'GET') {
    const owner = keyring.ownerKeypair();
    const exported = await keyring.exportLog(owner);
    const filename = `keyring-log-${new Date().toISOString().slice(0, 10)}.json`;
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(exported, null, 2));
    return;
  }

  // ── Mutating endpoints (owner-signed via the core) ──

  if (path === '/api/grants/revoke' && method === 'POST') {
    const body = await readJsonBody(req);
    const grantId = requireString(body, 'grant_id');
    const reason = optionalString(body, 'reason');
    const owner = keyring.ownerKeypair();
    const grant = await keyring.revokeGrant(owner, grantId, reason);
    sendJson(res, 200, { ok: true, grant });
    return;
  }

  if (path === '/api/agents/kill' && method === 'POST') {
    const body = await readJsonBody(req);
    const agent = requireString(body, 'agent');
    const reason = optionalString(body, 'reason');
    const owner = keyring.ownerKeypair();
    const result = await keyring.killSwitch(owner, agent, reason);
    sendJson(res, 200, { ok: true, agent_id: result.agent_id, revoked_grant_ids: result.revoked_grant_ids });
    return;
  }

  if (path === '/api/requests/approve' && method === 'POST') {
    const body = await readJsonBody(req);
    const requestId = requireString(body, 'request_id');
    const credentialRef = requireString(body, 'credential_ref');
    const constraints = parseConstraints(body.constraints);
    const owner = keyring.ownerKeypair();
    const { request, grant } = await keyring.approveRequest(owner, requestId, credentialRef, constraints);
    sendJson(res, 200, { ok: true, request, grant });
    return;
  }

  if (path === '/api/requests/deny' && method === 'POST') {
    const body = await readJsonBody(req);
    const requestId = requireString(body, 'request_id');
    const reason = optionalString(body, 'reason');
    const owner = keyring.ownerKeypair();
    const request = await keyring.denyRequest(owner, requestId, reason);
    sendJson(res, 200, { ok: true, request });
    return;
  }

  const knownPaths = [
    '/api/overview', '/api/timeline', '/api/verify', '/api/export',
    '/api/grants/revoke', '/api/agents/kill', '/api/requests/approve', '/api/requests/deny',
  ];
  if (knownPaths.includes(path)) {
    sendJson(res, 405, { ok: false, error: `Method ${method} not allowed for ${path}` });
    return;
  }
  sendJson(res, 404, { ok: false, error: 'Not found' });
}

async function handleRequest(
  keyring: Keyring,
  tokenBuf: Buffer,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed' });
        return;
      }
      sendPage(res, method === 'HEAD');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (!tokenMatches(tokenBuf, req.headers['x-admin-token'])) {
        sendJson(res, 401, { ok: false, error: 'unauthorized: missing or invalid X-Admin-Token' });
        return;
      }
      await handleApi(keyring, url, method, req, res);
      return;
    }
    sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof HttpError) {
      sendJson(res, err.status, { ok: false, error: err.message });
      return;
    }
    if (err instanceof KeyringError) {
      sendJson(res, 400, { ok: false, error: err.message, code: err.code });
      return;
    }
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : 'Internal error' });
  }
}

/**
 * Start the local admin server. Resolves once listening; the returned URL
 * includes the per-session access token and is the only place it appears.
 */
export async function startAdminServer(
  options: AdminServerOptions
): Promise<AdminServerHandle> {
  const host = options.host ?? DEFAULT_HOST;
  const token = crypto.randomBytes(16).toString('hex');
  const tokenBuf = Buffer.from(token, 'utf8');

  const server = http.createServer((req, res) => {
    handleRequest(options.keyring, tokenBuf, req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Internal error' });
      else res.end();
    });
  });

  // Track sockets so close() tears down promptly (keep-alive connections otherwise linger).
  const sockets = new Set<Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const listenOn = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        resolve((server.address() as AddressInfo).port);
      });
    });

  let port: number;
  if (options.port !== undefined) {
    // Explicit port: fail loudly if it is busy.
    port = await listenOn(options.port);
  } else {
    try {
      port = await listenOn(DEFAULT_PORT);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        port = await listenOn(0); // OS-assigned fallback
      } else {
        throw err;
      }
    }
  }

  return {
    url: `http://${host}:${port}/?token=${token}`,
    port,
    close: () => {
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}
