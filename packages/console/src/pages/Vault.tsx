import { useState } from 'react';
import { control, ControlApiError } from '../api/control.js';
import { runAction } from '../lib/ceremony.js';
import { vaultKeyFromOwnerId } from '../lib/owner.js';
import { useOwner } from '../state/session.js';

function errText(err: unknown): string {
  if (err instanceof ControlApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function shortKey(k: string): string {
  return k.length > 20 ? `${k.slice(0, 12)}…${k.slice(-6)}` : k;
}

/**
 * Vault & devices — the owner binding (CONTROL_PLANE.md §1).
 *
 * The bind_vault_key ceremony is what lets the local daemon authenticate as
 * this owner (daemonAuth requires an active owner_vault_keys row), i.e. it is
 * the prerequisite for `based sync`. The key being bound is derived from the
 * signed-in owner id itself, so there is nothing to type and nothing to get
 * wrong — the passkey signs a statement about exactly this account's key.
 */
export default function Vault() {
  const { owner, refresh } = useOwner();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!owner) return null; // Protected route guarantees a session; satisfies TS.
  const vaultPub = vaultKeyFromOwnerId(owner.owner_id);
  const bound = owner.vault_key !== null;

  async function onBind(): Promise<void> {
    if (!owner) return;
    setBusy(true);
    setError(null);
    try {
      const { nonce, assertion } = await runAction(owner.owner_id, 'bind_vault_key', {
        vault_public_key: vaultPub,
      });
      await control.bindVaultKey(vaultPub, nonce, assertion);
      await refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Vault</h1>
      </div>
      <p className="page-lede">
        Your vault runs on your machine and holds every secret; the console only ever sees
        metadata. Binding your vault key here lets your local daemon pull approved grants.
      </p>

      {error && <div className="banner banner-error">{error}</div>}

      <section className="panel">
        <h2>Vault key binding</h2>
        <div className="kv">
          <span className="kv-key">Vault public key</span>
          <code title={vaultPub}>{shortKey(vaultPub)}</code>
        </div>
        {bound ? (
          <>
            <div className="kv">
              <span className="kv-key">Status</span>
              <span className="status status-approved">bound</span>
            </div>
            <div className="kv">
              <span className="kv-key">Bound</span>
              <span>{new Date(owner.vault_key!.bound_at).toLocaleString()}</span>
            </div>
            <p className="muted panel-note">
              Your daemon can sync. On your machine:
            </p>
            <pre className="code-block">{`based link    # anchor your passkey(s) as the local authority root
based sync    # pull + verify + seal approved grants (add --watch 30 to keep it running)`}</pre>
          </>
        ) : (
          <>
            <div className="kv">
              <span className="kv-key">Status</span>
              <span className="status status-denied">not bound</span>
            </div>
            <p className="muted panel-note">
              Until you bind, your local daemon cannot authenticate to pull approved grants.
              Binding signs a passkey statement over exactly this key.
            </p>
            <button className="btn btn-primary" disabled={busy} onClick={() => void onBind()}>
              {busy ? 'Waiting for passkey…' : 'Bind vault key with passkey'}
            </button>
          </>
        )}
      </section>

      <section className="panel">
        <h2>Passkeys</h2>
        <p className="muted panel-note">
          The passkeys that can authorize actions for this account. Anchor them locally with{' '}
          <code>based link</code> so your daemon trusts exactly these.
        </p>
        <ul className="rows">
          {owner.credentials.map((cr) => (
            <li key={cr.credential_id} className="row">
              <span className="row-label">{cr.nickname ?? 'Passkey'}</span>
              <code className="muted" title={cr.credential_id}>{shortKey(cr.credential_id)}</code>
              <span className="muted row-date">
                added {new Date(cr.created_at).toLocaleDateString()}
                {cr.backed_up && ' · synced'}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
