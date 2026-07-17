/**
 * Execution brokering (Custody Fix 1) — the logic behind `keyring_run` and
 * `keyring_render`, factored out of the MCP transport so it is directly
 * testable (see mcp-broker.test.ts, the canary invariant).
 *
 * The invariant these functions uphold: a secret value is injected into a child
 * process environment or written into a file on disk, but the string returned
 * to the model (`text`) never contains the value — captured output is redacted.
 */

import { spawn } from 'node:child_process';
import * as os from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Keyring } from '../keyring.js';
import type { AgentKeypair } from '../crypto.js';

export interface BrokerResult {
  text: string;
  isError: boolean;
}

const MAX_CAPTURE = 64 * 1024; // cap stdout/stderr returned to the model

/** Redact every secret value out of captured text (the canary-test invariant). */
export function redactSecrets(text: string, secrets: Array<{ value: string; env_var: string }>): string {
  let out = text;
  for (const s of secrets) {
    if (s.value.length >= 4) out = out.split(s.value).join(`‹redacted:${s.env_var}›`);
  }
  return out;
}

function tail(text: string): string {
  return text.length > MAX_CAPTURE
    ? `…(${text.length - MAX_CAPTURE} bytes trimmed)…\n` + text.slice(-MAX_CAPTURE)
    : text;
}

export interface RunArgs {
  credential_refs: string[];
  command: string[];
  purpose: string;
  cwd?: string;
  ttl_seconds?: number;
}

/**
 * Lease each ref (env-injection semantics — no raw value release), spawn the
 * command with the secrets in its environment, capture stdout/stderr with the
 * values redacted, record one signed 'run' event, and return model-visible text.
 */
export async function runBrokered(kr: Keyring, kp: AgentKeypair, args: RunArgs): Promise<BrokerResult> {
  const { credential_refs, command, purpose, cwd, ttl_seconds } = args;

  const leased: Array<{ env_var: string; value: string; label: string; credential_id: string }> = [];
  const denied: string[] = [];
  for (const ref of credential_refs) {
    try {
      const lease = await kr.lease(kp, ref, { context: `run: ${purpose}`, ttlSeconds: ttl_seconds });
      if (!lease.credential.env_var) {
        denied.push(`${ref}: credential "${lease.credential.label}" has no env var name — set one so it can be injected`);
        continue;
      }
      leased.push({
        env_var: lease.credential.env_var,
        value: lease.value,
        label: lease.credential.label,
        credential_id: lease.credential.credential_id,
      });
    } catch (err) {
      denied.push(`${ref}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (denied.length > 0) {
    // All-or-nothing: don't run a half-configured command.
    return {
      isError: true,
      text: [`**keyring_run refused — ${denied.length} credential(s) could not be leased.**`, '',
        ...denied.map(d => `- ${d}`), '',
        'No command was run. Resolve the grants (or use `keyring_request`) and retry.'].join('\n'),
    };
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const l of leased) env[l.env_var] = l.value;

  let stdout = '';
  let stderr = '';
  const exitCode = await new Promise<number>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command[0], command.slice(1), { env, cwd, shell: false });
    } catch (err) {
      stderr += `could not start "${command[0]}": ${(err as Error).message}\n`;
      resolve(127);
      return;
    }
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => { stderr += `could not start "${command[0]}": ${err.message}\n`; resolve(127); });
    child.on('close', (code, signal) =>
      resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 0)));
  });

  let eventId = '(not recorded)';
  try {
    const ev = await kr.recordRun(kp, {
      command: command.join(' '),
      purpose,
      credentialIds: leased.map(l => l.credential_id),
      envVars: leased.map(l => l.env_var),
      exitCode,
    });
    eventId = ev.event_id;
  } catch { /* audit failure must not hide the run result */ }

  const secrets = leased.map(l => ({ value: l.value, env_var: l.env_var }));
  const text = [
    `## Ran: \`${command.join(' ')}\``,
    '',
    `**Exit code:** ${exitCode}`,
    `**Injected (into the environment, never argv):** ${leased.map(l => `\`${l.env_var}\``).join(', ')}`,
    `**Run recorded:** signed event \`${eventId}\``,
    '',
    'Secret values were injected into the child environment and are **redacted** from the output below.',
    '',
    '**stdout:**',
    '```',
    redactSecrets(tail(stdout), secrets) || '(empty)',
    '```',
    '**stderr:**',
    '```',
    redactSecrets(tail(stderr), secrets) || '(empty)',
    '```',
  ].join('\n');
  return { isError: exitCode !== 0, text };
}

const PLACEHOLDER_RE = /\{\{\s*keyring:([^}\s]+)\s*\}\}/g;

export interface RenderArgs {
  dest_path: string;
  content?: string;
  template_path?: string;
  purpose?: string;
}

/**
 * Fill {{keyring:REF}} placeholders with real values and write dest_path,
 * without the value ever appearing in the returned text.
 */
export async function renderBrokered(kr: Keyring, kp: AgentKeypair, args: RenderArgs): Promise<BrokerResult> {
  const { dest_path, content, template_path, purpose } = args;

  if ((content == null) === (template_path == null)) {
    return { isError: true, text: 'Provide exactly one of `content` or `template_path`.' };
  }
  let template: string;
  try {
    template = content != null ? content : readFileSync(template_path as string, 'utf8');
  } catch (err) {
    return { isError: true, text: `Could not read template_path: ${(err as Error).message}` };
  }

  const refs = Array.from(new Set(Array.from(template.matchAll(PLACEHOLDER_RE), (m) => m[1].trim())));
  if (refs.length === 0) {
    return {
      isError: true,
      text: 'No {{keyring:REF}} placeholders found — nothing to render. Write the file yourself if it needs no secret.',
    };
  }

  const values = new Map<string, { value: string; credential_id: string; label: string }>();
  const denied: string[] = [];
  for (const ref of refs) {
    try {
      const lease = await kr.lease(kp, ref, { context: `render: ${dest_path}`, ttlSeconds: 300 });
      values.set(ref, { value: lease.value, credential_id: lease.credential.credential_id, label: lease.credential.label });
    } catch (err) {
      denied.push(`${ref}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (denied.length > 0) {
    return {
      isError: true,
      text: [`**keyring_render refused — ${denied.length} placeholder(s) could not be filled.**`, '',
        ...denied.map(d => `- ${d}`), '', 'Nothing was written.'].join('\n'),
    };
  }

  const rendered = template.replace(PLACEHOLDER_RE, (_m, r: string) => values.get(r.trim())?.value ?? _m);
  try {
    writeFileSync(dest_path, rendered, { mode: 0o600 });
  } catch (err) {
    return { isError: true, text: `Could not write dest_path: ${(err as Error).message}` };
  }

  let eventId = '(not recorded)';
  try {
    const ev = await kr.recordRender(kp, {
      destPath: dest_path,
      purpose,
      credentialIds: Array.from(values.values()).map(v => v.credential_id),
      placeholders: refs,
    });
    eventId = ev.event_id;
  } catch { /* audit failure must not hide the result */ }

  return {
    isError: false,
    text: [`## Rendered ${dest_path}`,
      '',
      `Filled ${refs.length} placeholder(s): ${Array.from(values.values()).map(v => `\`${v.label}\``).join(', ')}.`,
      `**Render recorded:** signed event \`${eventId}\`.`,
      '',
      `⚠️ \`${dest_path}\` now contains live secret value(s) on disk. Delete it when the deploy is done — ` +
      `it is outside the vault, so the kill switch cannot reach it.`].join('\n'),
  };
}
