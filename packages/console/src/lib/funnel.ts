/**
 * Anonymous onboarding-funnel pings (onboarding redesign instrumentation):
 * copy_command → init_run → mcp_config_written → passkey_created →
 * provider_connected → first_lease. The console reports the two steps it can
 * see. Fire-and-forget by design — no identity, no cookies, and a failed ping
 * must never affect the flow it measures.
 */
import { API_BASE } from '../api/control.js';

export function funnelPing(
  event: 'passkey_created' | 'provider_connected' | 'email_door',
  provider?: string,
): void {
  try {
    void fetch(`${API_BASE}/v1/funnel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, ...(provider ? { provider } : {}) }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* telemetry must never break the product */
  }
}
