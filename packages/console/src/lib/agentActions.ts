/**
 * Shared data + actions for the base-case agent surfaces (/home and
 * /agents/:agentId). One hook owns the fetch/poll lifecycle and the four
 * verbs a human exercises over an agent — allow, don't allow, rotate,
 * remove — plus the kill switch, so the overview and the detail page can
 * never drift apart in behavior.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs):
 * the window.confirm strings here render to humans.
 */
import { useCallback, useEffect, useState } from 'react';
import { control, ControlApiError } from '../api/control.js';
import { useOwner } from '../state/session.js';
import { approveRequest } from './approve.js';
import { runAction } from './ceremony.js';
import { ensurePasskey } from './firstApproval.js';
import type { ConnectionInfo, CredentialFact, Delegation, KeyringRequest } from '../api/types.js';

export function errText(err: unknown): string {
  if (err instanceof ControlApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Over the plan's agent limit — a distinct, base-case-worded state (never the
 *  raw 402 message, which contains power-user vocabulary). */
export function isPlanLimit(err: unknown): boolean {
  return err instanceof ControlApiError && err.status === 402;
}

export function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id;
}

export function agentDisplayName(d: Delegation): string {
  return d.label ?? shortId(d.agent_id);
}

/** Counts-only report the machine sent after executing a kill locally. */
export function killReport(d: Delegation): { residuals: number; note?: string } | null {
  if (!d.daemon_kill_report) return null;
  try {
    const j = JSON.parse(d.daemon_kill_report) as { residuals?: number; note?: string };
    return { residuals: j.residuals ?? 0, note: j.note };
  } catch {
    return null;
  }
}

export const SHOW_CONFIRMED_KILL_DAYS = 7;

/** Kill-switch cards worth showing: every unconfirmed cutoff, plus confirmed ones for a week. */
export function recentlyKilled(delegations: Delegation[]): Delegation[] {
  return delegations.filter((d) => {
    if (d.status !== 'revoked') return false;
    if (!d.daemon_confirmed_at) return true; // the machine still owes the local half
    return Date.now() - Date.parse(d.daemon_confirmed_at) < SHOW_CONFIRMED_KILL_DAYS * 86_400_000;
  });
}

/** One thing an agent can use, with enough metadata for per-key rotate/remove. */
export interface Holding {
  key: string;
  label: string;
  provider: string;
  localId: string | null;
}

/**
 * Everything one agent can use. Stored rows carry the machine-local id they
 * created; approved asks carry theirs. Rotate/remove rows are operations on
 * an existing key, never holdings themselves.
 */
export function holdingsFor(
  agentId: string,
  connections: ConnectionInfo[],
  requests: KeyringRequest[],
): Holding[] {
  return [
    ...connections
      .filter((c) => c.agent_id === agentId && c.status === 'stored' && c.kind !== 'rotate' && c.kind !== 'remove')
      .map((c) => ({
        key: `conn-${c.id}`,
        label: c.label ?? c.provider,
        provider: c.provider,
        localId: c.daemon_credential_id ?? null,
      })),
    ...requests
      .filter((r) => r.agent_id === agentId && r.status === 'approved')
      .map((r) => ({
        key: `req-${r.id}`,
        label: r.credential_label ?? r.credential_id,
        provider: r.provider ?? '',
        localId: r.credential_id ?? null,
      })),
  ];
}

/** The newest rotate/remove operation targeting one machine-local key. */
export function latestOpFor(
  kind: 'rotate' | 'remove',
  agentId: string,
  localId: string | null,
  connections: ConnectionInfo[],
): ConnectionInfo | undefined {
  if (localId === null) return undefined;
  return connections
    .filter((c) => c.agent_id === agentId && c.kind === kind && c.daemon_credential_id === localId)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
}

/**
 * The machine's own report decides: an affirmative rotatable:false hides the
 * option (pasted/imported keys would only ever fail after the click). No fact
 * at all — an old daemon — keeps the optimistic option.
 */
export function rotatableFor(h: Holding, facts: CredentialFact[]): boolean {
  if (h.localId === null) return false;
  if (h.provider !== 'vercel' && h.provider !== 'supabase') return false;
  const fact = facts.find((f) => f.credential_id === h.localId);
  return fact?.rotatable !== false;
}

export interface AgentData {
  requests: KeyringRequest[];
  connections: ConnectionInfo[];
  facts: CredentialFact[];
  /** 'create' key of the in-flight action, or null. */
  busy: string | null;
  error: string | null;
  atLimit: boolean;
  load: () => Promise<void>;
  allow: (req: KeyringRequest) => Promise<void>;
  dontAllow: (req: KeyringRequest) => Promise<void>;
  rotate: (d: Delegation, h: Holding) => Promise<void>;
  remove: (d: Delegation, h: Holding) => Promise<void>;
  kill: (d: Delegation) => Promise<void>;
}

export function useAgentData(): AgentData {
  const { owner, refresh } = useOwner();
  const [requests, setRequests] = useState<KeyringRequest[]>([]);
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [facts, setFacts] = useState<CredentialFact[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [atLimit, setAtLimit] = useState(false);

  const load = useCallback(async () => {
    try {
      const [reqs, conns, cf] = await Promise.all([
        control.listRequests(),
        control.listConnections(),
        control.listCredentialFacts(),
      ]);
      setRequests(reqs.requests);
      setConnections(conns.connections);
      setFacts(cf.facts);
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While a rotation/removal is in flight on the user's machine, watch for the
  // flip to done/failed — the whole operation is usually a few seconds of API calls.
  useEffect(() => {
    const inFlight = connections.some(
      (c) => (c.kind === 'rotate' || c.kind === 'remove') && (c.status === 'pending' || c.status === 'processing'),
    );
    if (!inFlight) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [connections, load]);

  // Right after a kill, watch for the machine's confirmation (it lands on the
  // daemon's next sync round). Bounded to 10 minutes — after that the card's
  // "run the sync there" instruction is the path, not more polling.
  useEffect(() => {
    const waiting = (owner?.delegations ?? []).some(
      (d) => d.status === 'revoked' && !d.daemon_confirmed_at &&
        d.revoked_at != null && Date.now() - Date.parse(d.revoked_at) < 10 * 60 * 1000,
    );
    if (!waiting) return;
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [owner, refresh]);

  async function allow(req: KeyringRequest): Promise<void> {
    if (!owner) return;
    setBusy(req.id);
    setError(null);
    setAtLimit(false);
    try {
      // refresh runs the instant a passkey is minted (see lib/approve.ts).
      await approveRequest(owner, req.id, refresh);
      await load();
    } catch (err) {
      if (isPlanLimit(err)) setAtLimit(true); // never render the raw 402 copy
      else setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  async function dontAllow(req: KeyringRequest): Promise<void> {
    setBusy(req.id);
    setError(null);
    try {
      await control.deny(req.id);
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  async function rotate(d: Delegation, h: Holding): Promise<void> {
    if (!h.localId) return;
    const name = agentDisplayName(d);
    if (!window.confirm(
      `Rotate the ${h.label} key? Your machine mints a fresh key and destroys the old one at ${h.provider}. ${name} switches to the new key automatically.`,
    )) return;
    setBusy(`rotate-${h.localId}`);
    setError(null);
    try {
      await control.createConnection({
        agent_id: d.agent_id,
        provider: h.provider,
        label: h.label,
        kind: 'rotate',
        rotate_credential_id: h.localId,
      });
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove(d: Delegation, h: Holding): Promise<void> {
    if (!h.localId) return;
    const name = agentDisplayName(d);
    if (!window.confirm(
      `Remove ${h.label} from ${name}? Your machine cuts off this one key — it stops working for ${name}, and if nothing else uses it, it's destroyed at ${h.provider || 'the provider'}. Everything else stays.`,
    )) return;
    setBusy(`remove-${h.localId}`);
    setError(null);
    try {
      await control.createConnection({
        agent_id: d.agent_id,
        provider: h.provider,
        label: h.label,
        kind: 'remove',
        rotate_credential_id: h.localId,
      });
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  async function kill(d: Delegation): Promise<void> {
    if (!owner) return;
    const name = agentDisplayName(d);
    if (!window.confirm(`Cut off ${name}? It immediately loses the ability to ask for anything, and your machine drops its access on the next sync.`)) {
      return;
    }
    setBusy(d.id);
    setError(null);
    try {
      await ensurePasskey(owner);
      const { nonce, assertion } = await runAction(owner.owner_id, 'revoke_delegation', {
        delegation_id: d.id,
      });
      await control.revokeDelegation(d.id, nonce, assertion);
      await refresh();
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  return { requests, connections, facts, busy, error, atLimit, load, allow, dontAllow, rotate, remove, kill };
}
