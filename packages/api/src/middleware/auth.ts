import type { Context, Next } from 'hono';

/**
 * AgentSig authentication middleware.
 *
 * Expects header: Authorization: AgentSig <public_key>:<signature>
 * Signature is over: <method>:<path>:<timestamp>:<body_hash>
 *
 * Sets c.set('agentId', ...) and c.set('publicKey', ...) on success.
 */
export async function agentAuth(c: Context, next: Next): Promise<Response | void> {
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('AgentSig ')) {
    return c.json({ error: 'unauthorized', message: 'Missing AgentSig authorization header' }, 401);
  }

  // TODO: Implement signature verification — backend agent
  // For now, return 501
  return c.json({ error: 'not_implemented', message: 'Auth verification not yet implemented' }, 501);

  // After implementation, call next():
  // await next();
}

/**
 * Optional auth — sets agent context if header present, continues regardless.
 */
export async function optionalAuth(c: Context, next: Next): Promise<void> {
  // TODO: Implement — backend agent
  await next();
}
