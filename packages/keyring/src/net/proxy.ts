/**
 * Route global fetch through the environment's egress proxy, when one exists.
 *
 * Cloud sandboxes (Codex-style) and locked-down CI implement "allowed
 * domains" with an HTTP(S) proxy announced via HTTPS_PROXY/HTTP_PROXY env
 * vars. npm and curl honor those; Node's built-in fetch does NOT — so every
 * keyring network call tried a direct connection and died even for allowed
 * hosts. Field-hit in a Codex task: npm installed fine, both domains
 * allowed, and `keyring init` still reported api.basedagents.ai unreachable.
 *
 * Best-effort by design: no proxy vars → no-op; undici missing or too old →
 * no-op (direct fetch, the previous behavior). NO_PROXY is honored by
 * EnvHttpProxyAgent, so local dev against localhost keeps working. TLS
 * verification is never touched.
 */

let installed = false;

export async function installEnvProxy(): Promise<void> {
  if (installed) return;
  installed = true;
  const env = process.env;
  if (!(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy)) return;
  try {
    const undici = await import('undici');
    const { EnvHttpProxyAgent, setGlobalDispatcher } = undici as unknown as {
      EnvHttpProxyAgent?: new () => unknown;
      setGlobalDispatcher?: (d: unknown) => void;
    };
    if (!EnvHttpProxyAgent || !setGlobalDispatcher) return;
    setGlobalDispatcher(new EnvHttpProxyAgent());
  } catch {
    /* keep direct fetch — same behavior as before this existed */
  }
}
