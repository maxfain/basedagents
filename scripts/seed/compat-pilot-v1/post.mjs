#!/usr/bin/env node
/**
 * Seed the ba-compat-pilot-v1 batch: 10 free compatibility tasks (no bounty).
 *
 *   node scripts/seed/compat-pilot-v1/post.mjs                          # dry run: validate, write dry-run.json
 *   node scripts/seed/compat-pilot-v1/post.mjs --publish [--keypair <file>] [--api <url>]
 *
 * Idempotent: a task whose "Task key:" marker is already on the board (any
 * status) under the posting agent is never posted again, and neither is one
 * the ledger records. After an uncertain response (network error, 5xx) the
 * script re-reads the board instead of retrying, and stops if the task isn't
 * there.
 *
 * The key: --keypair <file> (same JSON as the CLI), or BASEDAGENTS_BOT_PUBLIC_KEY
 * and BASEDAGENTS_BOT_PRIVATE_KEY (hex) in the environment. It is never printed.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(HERE, 'seed.json'), 'utf8'));
const LEDGER_PATH = join(HERE, 'ledger.json');
const LIMITS = { title: 200, description: 10_000, expected_output: 2_000 };

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const publish = argv.includes('--publish');
const api = flag('--api') ?? 'https://api.basedagents.ai';

function fail(msg) { console.error(`post: ${msg}`); process.exit(1); }
const keyOf = (description) => description.match(/^Task key: (ba-compat-pilot-v1-\d\d)$/m)?.[1] ?? null;

// ── 1. validate the payloads ──
for (const { key, payload: p } of SEED.tasks) {
  const errors = [];
  if (/\{\{[^}]*\}\}/.test(p.title + p.description + p.expected_output)) errors.push('unresolved {{placeholder}}');
  if (keyOf(p.description) !== key) errors.push('missing or wrong "Task key:" marker');
  for (const [f, max] of Object.entries(LIMITS)) if ((p[f] ?? '').length > max) errors.push(`${f} over ${max} chars`);
  if (p.bounty !== undefined || p.escrow !== undefined) errors.push('this batch is free: no bounty or escrow');
  if (errors.length) fail(`${key}: ${errors.join('; ')}`);
}
console.log(`${SEED.batch}: ${SEED.tasks.length} free tasks (no bounty, nothing to fund)`);

if (!publish) {
  writeFileSync(join(HERE, 'dry-run.json'), JSON.stringify(SEED.tasks, null, 2) + '\n');
  for (const { key, payload } of SEED.tasks) console.log(`  ${key}  ${payload.category.padEnd(10)} ${payload.description.length} chars  ${payload.title}`);
  console.log('Dry run: nothing posted. Payloads written to dry-run.json.');
  process.exit(0);
}

// ── 2. the posting identity (never printed) ──
const sdk = await import('basedagents');
let kp;
if (flag('--keypair')) kp = sdk.deserializeKeypair(readFileSync(flag('--keypair'), 'utf8'));
else if (process.env.BASEDAGENTS_BOT_PUBLIC_KEY && process.env.BASEDAGENTS_BOT_PRIVATE_KEY) {
  kp = sdk.deserializeKeypair(JSON.stringify({ publicKey: process.env.BASEDAGENTS_BOT_PUBLIC_KEY.trim(), privateKey: process.env.BASEDAGENTS_BOT_PRIVATE_KEY.trim() }));
} else fail('Pass --keypair <file>, or set BASEDAGENTS_BOT_PUBLIC_KEY / BASEDAGENTS_BOT_PRIVATE_KEY');
const creator = sdk.publicKeyToAgentId(kp.publicKey);
const client = new sdk.RegistryClient(api);
console.log(`Posting as ${creator}`);

const ledger = existsSync(LEDGER_PATH) ? JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) : { batch: SEED.batch, creator, entries: {} };
const saveLedger = () => writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + '\n');

async function liveByKey() {
  const found = {};
  for (let offset = 0; ; offset += 100) {
    const page = await client.getTasks({ creator, status: 'all', limit: 100, offset });
    for (const t of page.tasks) { const k = keyOf(t.description ?? ''); if (k) found[k] = t; }
    if (page.tasks.length < 100) return found;
  }
}

// ── 3. reconcile, then post what is missing ──
const live = await liveByKey();
for (const { key, payload } of SEED.tasks) {
  if (live[key]) {
    ledger.entries[key] ??= { task_id: live[key].task_id, note: 'found on the board' };
    console.log(`  ${key}  exists: ${live[key].task_id} (${live[key].status}), skipped`);
    continue;
  }
  if (ledger.entries[key]?.task_id) {
    console.log(`  ${key}  ledger has ${ledger.entries[key].task_id} but the board doesn't list it; not recreating. Check it by hand.`);
    continue;
  }
  try {
    const res = await client.createTask(kp, payload);
    ledger.entries[key] = { task_id: res.task_id, created_at: new Date().toISOString() };
    saveLedger();
    console.log(`  ${key}  posted: ${res.task_id}`);
  } catch (err) {
    const status = err instanceof sdk.ApiError ? err.status : null;
    if (status !== null && status < 500) { console.log(`  ${key}  refused (${status}): ${err.message}`); continue; }
    // Uncertain: the task may or may not exist. Re-read the board; never retry blind.
    const again = await liveByKey().catch(() => ({}));
    if (again[key]) {
      ledger.entries[key] = { task_id: again[key].task_id, created_at: again[key].created_at, note: 'reconciled after an uncertain response' };
      saveLedger();
      console.log(`  ${key}  posted (reconciled): ${again[key].task_id}`);
    } else {
      console.log(`  ${key}  uncertain (${err.message}) and not on the board; stopping. Rerun to continue.`);
      break;
    }
  }
}
saveLedger();

// ── 4. confirm every created task as the API shows it ──
for (const { key, payload } of SEED.tasks) {
  const id = ledger.entries[key]?.task_id;
  if (!id) { console.log(`${key}  not posted`); continue; }
  const d = await client.getTask(id);
  const t = d.task ?? d;
  const checks = {
    creator: t.creator_agent_id === creator,
    marker: keyOf(t.description ?? '') === key,
    description: t.description === payload.description,
    free: t.bounty === null,
  };
  Object.assign(ledger.entries[key], { status: t.status, url: `https://basedagents.ai/tasks/${id}`, title: t.title, checks, checked_at: new Date().toISOString() });
  const ok = Object.values(checks).every(Boolean);
  console.log(`${key}  ${id}  ${t.status}  ${ok ? 'confirmed' : `CHECK FAILED ${JSON.stringify(checks)}`}`);
}
saveLedger();
