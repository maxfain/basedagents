/**
 * Ambient-access sweep (Custody Fix 2).
 *
 * A vault that ignores keys already lying around protects nothing. This module
 * detects, in the agent's reach, the ways it can already act as the human
 * WITHOUT going through Keyring:
 *
 *   - project `.env*` files that contain live-shaped values
 *   - logged-in provider CLIs (vercel, supabase, gh, aws, flyctl, railway …)
 *   - token-shaped environment variables
 *   - ~/.netrc credentials
 *
 * The detector is pure and injectable (home / cwd / env are parameters) so it is
 * deterministic and unit-testable. It NEVER returns secret values — only the
 * location and the shape of what it found, plus how to neutralise it.
 *
 * `doctor` reports these and exits nonzero when any ungoverned path exists; the
 * kill switch runs the same sweep so it can be honest about residuals.
 */

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type SweepKind = 'env_file' | 'cli_login' | 'env_var' | 'netrc';

export interface SweepFinding {
  kind: SweepKind;
  /** Short title, e.g. "Vercel CLI login" or ".env contains STRIPE_KEY". */
  title: string;
  /** How the agent can act through this, and how to neutralise it. Never a value. */
  detail: string;
  /** How to bring it under Keyring's custody ("Absorb") or that it's just tracked. */
  remedy: string;
  path?: string;
  provider?: string;
}

export interface SweepOptions {
  /** Project directory to scan for .env files. Default: process.cwd(). */
  cwd?: string;
  /** Home directory for CLI-login / netrc detection. Default: os.homedir(). */
  home?: string;
  /** Environment to scan for token-shaped vars. Default: process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface SweepResult {
  findings: SweepFinding[];
  scanned: { cwd: string; home: string };
}

// ── Provider CLIs: presence of these files means a logged-in session ──
interface CliLogin {
  provider: string;
  title: string;
  files: string[]; // relative to home
  logout: string;
}

const CLI_LOGINS: CliLogin[] = [
  { provider: 'vercel', title: 'Vercel CLI login', logout: 'vercel logout',
    files: ['.vercel/auth.json', '.local/share/com.vercel.cli/auth.json', 'Library/Application Support/com.vercel.cli/auth.json'] },
  { provider: 'supabase', title: 'Supabase CLI login', logout: 'supabase logout',
    files: ['.supabase/access-token', '.config/supabase/access-token'] },
  { provider: 'github', title: 'GitHub CLI (gh) login', logout: 'gh auth logout',
    files: ['.config/gh/hosts.yml'] },
  { provider: 'aws', title: 'AWS CLI credentials', logout: 'aws configure',
    files: ['.aws/credentials'] },
  { provider: 'flyctl', title: 'Fly.io CLI login', logout: 'fly auth logout',
    files: ['.fly/config.yml', '.config/fly/config.yml'] },
  { provider: 'railway', title: 'Railway CLI login', logout: 'railway logout',
    files: ['.railway/config.json', '.config/railway/config.json'] },
];

// ── Token-shaped value patterns (used for .env lines and env-var values) ──
const TOKEN_VALUE_RE = [
  /\bsk_(live|test)_[A-Za-z0-9]{8,}/,     // Stripe secret
  /\brk_(live|test)_[A-Za-z0-9]{8,}/,     // Stripe restricted
  /\bghp_[A-Za-z0-9]{20,}/,               // GitHub PAT (classic)
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,       // GitHub fine-grained PAT
  /\bgho_[A-Za-z0-9]{20,}/,               // GitHub OAuth
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,       // Slack
  /\bAKIA[0-9A-Z]{16}/,                   // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/,             // Google API key
  /\bsbp_[A-Za-z0-9]{20,}/,               // Supabase personal token
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./, // JWT-shaped
];

// Env-var NAMES that strongly imply a secret value.
const TOKEN_NAME_RE = /(^|_)(TOKEN|SECRET|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|PASSWORD|PASSWD|CLIENT[_-]?SECRET)($|_)/i;
// Names to never flag even if they match above (public / non-secret by
// convention, or pointers rather than the secret itself: *_FILE, *_PATH, …).
const NAME_ALLOW_RE = /(PUBLIC|PUBLISHABLE|_URL$|_URI$|_HOST$|_USER$|_USERNAME$|_FILE$|_PATH$|_DIR$|_NAME$|_ENABLED$)/i;

function looksLikeValue(v: string): boolean {
  const t = v.trim().replace(/^['"]|['"]$/g, '');
  if (t.length < 8) return false;
  if (/^(changeme|change-me|placeholder|example|your[-_].*|xxx+|<.*>|\$\{.*\}|todo|none|null|undefined)$/i.test(t)) return false;
  return true;
}

const ENV_FILE_RE = /^\.env(\.[A-Za-z0-9_.-]+)?$/;

/** Parse a dotenv file, returning the NAMES (never values) of live-shaped keys. */
function liveEnvKeys(contents: string): string[] {
  const keys: string[] = [];
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, name, value] = m;
    if (looksLikeValue(value) || TOKEN_VALUE_RE.some(re => re.test(value))) keys.push(name);
  }
  return keys;
}

function safeRead(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    if (!statSync(path).isFile()) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** List candidate .env files in a directory without a full recursive walk. */
function envFilesIn(cwd: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(cwd);
  } catch {
    return [];
  }
  return entries.filter(e => ENV_FILE_RE.test(e)).map(e => join(cwd, e));
}

export function runSweep(opts: SweepOptions = {}): SweepResult {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const findings: SweepFinding[] = [];

  // 1) Project .env* files with live-shaped values.
  for (const file of envFilesIn(cwd)) {
    const contents = safeRead(file);
    if (contents == null) continue;
    const keys = liveEnvKeys(contents);
    if (keys.length === 0) continue;
    findings.push({
      kind: 'env_file',
      title: `${file.split('/').pop()} contains ${keys.length} live value(s)`,
      detail: `Plaintext secrets your agent can read directly: ${keys.join(', ')}.`,
      remedy: 'Absorb: import these into the vault, then move the lines to a backup the agent cannot read.',
      path: file,
    });
  }

  // 2) Logged-in provider CLIs.
  for (const cli of CLI_LOGINS) {
    const hit = cli.files.map(f => join(home, f)).find(p => existsSync(p));
    if (!hit) continue;
    findings.push({
      kind: 'cli_login',
      title: cli.title,
      detail: `A logged-in ${cli.provider} CLI acts as you without asking Keyring.`,
      remedy: `Absorb: capture a scoped token in the vault, then \`${cli.logout}\`.`,
      path: hit,
      provider: cli.provider,
    });
  }

  // 3) Token-shaped environment variables.
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    const nameHit = TOKEN_NAME_RE.test(name) && !NAME_ALLOW_RE.test(name) && looksLikeValue(value);
    const valueHit = TOKEN_VALUE_RE.some(re => re.test(value));
    if (!nameHit && !valueHit) continue;
    findings.push({
      kind: 'env_var',
      title: `Environment variable ${name} looks like a live secret`,
      detail: `${name} is set in the agent's environment and it can read it directly.`,
      remedy: 'Absorb: store it in the vault and unset it from the agent\'s environment.',
    });
  }

  // 4) ~/.netrc credentials.
  const netrc = join(home, '.netrc');
  const netrcContents = safeRead(netrc);
  if (netrcContents && /\bmachine\b/.test(netrcContents) && /\bpassword\b/.test(netrcContents)) {
    findings.push({
      kind: 'netrc',
      title: '~/.netrc contains credentials',
      detail: 'Tools that read ~/.netrc (curl, git, …) authenticate as you automatically.',
      remedy: 'Absorb the relevant machine entries into the vault, or acknowledge as known ambient access.',
      path: netrc,
    });
  }

  return { findings, scanned: { cwd, home } };
}

/** One-line residual summary for the kill switch (Custody Fix 2). */
export function summarizeResiduals(findings: SweepFinding[]): string {
  if (findings.length === 0) return 'No ambient access found outside Keyring.';
  return findings.map(f => `• ${f.title} — ${f.remedy}`).join('\n');
}
