/**
 * based timeline — the human-readable AccessEvent stream.
 */

import { Keyring } from '../keyring.js';
import type { AccessEvent, AccessEventType, VaultFile } from '../types.js';
import { CliError, parseFlags, parsePositiveInt, printTable, formatTime, agentDisplay } from './shared.js';

const EVENT_TYPES: readonly AccessEventType[] = [
  'vault_created', 'identity_added', 'identity_removed',
  'credential_added', 'credential_updated', 'credential_removed',
  'grant_created', 'grant_revoked', 'kill_switch',
  'lease', 'lease_denied',
  'request_created', 'request_approved', 'request_denied',
];

function marker(eventType: AccessEventType): string {
  if (eventType === 'lease') return '✓';
  if (eventType === 'lease_denied' || eventType === 'request_denied') return '✗';
  if (eventType === 'grant_revoked' || eventType === 'kill_switch') return '⚠';
  return '·';
}

function detailString(detail: Record<string, unknown> | null, key: string): string | undefined {
  const value = detail?.[key];
  return typeof value === 'string' ? value : undefined;
}

function eventInfo(event: AccessEvent): string {
  const parts: string[] = [];
  if (event.requesting_context) parts.push(`"${event.requesting_context}"`);
  const reason = detailString(event.detail, 'reason');
  if (reason) parts.push(`reason: ${reason}`);
  if (event.event_type === 'kill_switch') {
    const revoked = event.detail?.['revoked_grant_ids'];
    if (Array.isArray(revoked)) parts.push(`${revoked.length} grant(s) revoked`);
  }
  if (event.event_type === 'identity_added') {
    const name = detailString(event.detail, 'name');
    if (name) parts.push(`name: ${name}`);
  }
  if (event.event_type === 'request_created') {
    const provider = detailString(event.detail, 'provider');
    if (provider) parts.push(`provider: ${provider}`);
    const scope = detailString(event.detail, 'scope');
    if (scope) parts.push(`scope: ${scope}`);
  }
  if (event.event_type === 'credential_updated') {
    const resealed = event.detail?.['resealed_to'];
    if (typeof resealed === 'number') parts.push(`re-sealed to ${resealed} key(s)`);
  }
  return parts.join(' · ');
}

/** Credential label if resolvable; falls back to the label recorded in the event, then the raw ID. */
function credentialLabel(vault: VaultFile, event: AccessEvent): string {
  if (!event.credential_id) return '';
  return vault.credentials[event.credential_id]?.label
    ?? detailString(event.detail, 'label')
    ?? event.credential_id;
}

export async function cmdTimeline(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args, { value: ['agent', 'credential', 'type', 'limit'] });
  const kr = Keyring.open(dir);
  const vault = kr.vault();

  let eventType: AccessEventType | undefined;
  const typeFlag = flags.values['type'];
  if (typeFlag !== undefined) {
    if (!(EVENT_TYPES as readonly string[]).includes(typeFlag)) {
      throw new CliError(`Unknown event type "${typeFlag}". Valid types: ${EVENT_TYPES.join(', ')}`);
    }
    eventType = typeFlag as AccessEventType;
  }

  let credentialId: string | undefined;
  const credentialFlag = flags.values['credential'];
  if (credentialFlag !== undefined) {
    try {
      credentialId = kr.resolveCredential(vault, credentialFlag).credential_id;
    } catch (err) {
      // Removed credentials no longer resolve, but their events remain — allow raw IDs through.
      if (credentialFlag.startsWith('cred_')) credentialId = credentialFlag;
      else throw err;
    }
  }

  const events = kr.timeline({
    agent: flags.values['agent'],
    credential_id: credentialId,
    event_type: eventType,
    limit: flags.values['limit'] !== undefined ? parsePositiveInt(flags.values['limit'], '--limit') : undefined,
  });

  if (events.length === 0) {
    console.log('No events match.');
    return;
  }

  printTable(events.map(event => [
    `#${event.sequence}`,
    formatTime(event.timestamp),
    marker(event.event_type),
    event.event_type,
    agentDisplay(vault, `ag_${event.agent_pubkey}`),
    credentialLabel(vault, event),
    eventInfo(event),
  ]));
}
