# Universal Scanner — Specification

Extends the basedagents.ai scanning system beyond npm to support **any software source**: GitHub repos, PyPI packages, and direct URL/tarball uploads.

---

## Table of Contents

- [Architecture](#architecture)
- [Source Types](#source-types)
- [Shared Scanner Core](#shared-scanner-core)
- [Language-Specific Patterns](#language-specific-patterns)
- [API Endpoints](#api-endpoints)
- [Database Changes](#database-changes)
- [Frontend Changes](#frontend-changes)
- [SDK CLI Changes](#sdk-cli-changes)
- [Security & Limits](#security--limits)
- [What's Built vs What's New](#whats-built-vs-whats-new)

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    Source Resolvers                    │
│                                                       │
│   NpmResolver    GitHubResolver   PyPIResolver        │
│   (existing)     (new)            (new)               │
│                                                       │
│   Each resolver:                                      │
│   1. Validates the input (URL, package name, etc.)    │
│   2. Fetches metadata (version, description, etc.)    │
│   3. Downloads + extracts source files into memory    │
│   4. Returns: FileEntry[] + metadata                  │
└───────────────────────┬──────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────┐
│                   Shared Scanner Core                  │
│                                                       │
│   1. Route files to language-specific pattern sets     │
│   2. Run pattern matching (same engine as today)       │
│   3. Collect metadata findings (install scripts, etc.) │
│   4. computeScore() with deduplication                 │
│   5. computeGrade()                                    │
│   6. BasedAgents registry lookup                       │
│   7. Return ScanReport                                 │
└──────────────────────────────────────────────────────┘
```

The key insight: **resolvers are pluggable, the scanner core is shared**. A GitHub repo and an npm package go through the same pattern matching — the only difference is how we get the files.

---

## Source Types

### 1. npm (existing)

- Input: package name, optional version
- Resolver: fetch tarball from `registry.npmjs.org`
- Already built and working

### 2. GitHub Repository (new)

- Input: `owner/repo` or full GitHub URL (`https://github.com/owner/repo`)
- Optional: branch/tag/commit ref (default: default branch)
- Resolver flow:
  1. Parse the input → extract `owner`, `repo`, optional `ref`
  2. `GET https://api.github.com/repos/{owner}/{repo}` — get metadata (description, stars, default branch, language, size)
  3. `GET https://api.github.com/repos/{owner}/{repo}/tarball/{ref}` — download source tarball (GitHub returns a gzipped tarball, same format as npm)
  4. Decompress + parse tar (reuse existing `tar.ts`)
  5. Scan all files, respecting language detection
- Metadata to capture:
  - `repo_url`, `default_branch`, `stars`, `forks`, `open_issues`
  - `contributors` count (from API)
  - `last_commit_date`
  - `languages` (from GitHub Languages API)
  - `has_ci` (check for `.github/workflows/`, `.circleci/`, `Jenkinsfile`)
  - `license` (from repo metadata)
  - Single-commit repos → `info` finding ("repo has only 1 commit — low provenance signal")
  - Anonymous/new accounts → `info` finding
- GitHub-specific findings:
  - `install.sh` or `setup.sh` with `curl | sh` patterns → `critical`
  - GitHub Actions workflows with `pull_request_target` + checkout of PR head → `high` (pwn request)
  - Workflow files with `${{ github.event.*.body }}` injection → `high`
  - `.env` files committed → `high`
  - Hardcoded tokens/secrets in source → `critical`

### 3. PyPI (new)

- Input: package name, optional version
- Resolver flow:
  1. `GET https://pypi.org/pypi/{package}/json` — metadata + file URLs
  2. Find the sdist tarball (`.tar.gz`) or wheel (`.whl` = zip)
  3. Download and extract
  4. Scan `.py`, `.pyx`, `.pyi` files
- Python-specific patterns needed (see [Language-Specific Patterns](#language-specific-patterns))

### 4. URL/Tarball (future, not in v1)

- Direct URL to a `.tar.gz`, `.zip`, or `.tgz`
- Useful for private registries, self-hosted packages

---

## Shared Scanner Core

### File Entry Interface

```typescript
interface FileEntry {
  /** Relative path within the archive (e.g., "src/index.ts") */
  path: string;
  /** File contents as UTF-8 string */
  content: string;
  /** File size in bytes */
  size: number;
}

interface SourceMetadata {
  /** Source type */
  source: 'npm' | 'github' | 'pypi';
  /** Package/repo name */
  name: string;
  /** Version, tag, or commit ref */
  version: string;
  /** Description from registry/repo */
  description?: string;
  /** Total size of all source files */
  total_size: number;
  /** Number of files extracted */
  total_files: number;
  /** Number of scannable files */
  scannable_files: number;
  /** Source-specific metadata (stars, downloads, etc.) */
  extra: Record<string, unknown>;
}
```

### Scanner Pipeline

```typescript
async function scanFiles(
  files: FileEntry[],
  metadata: SourceMetadata,
  db: DBAdapter
): Promise<ScanReport>
```

1. **Language detection** — determine patterns to apply per file by extension:
   - `.js`, `.ts`, `.mjs`, `.cjs`, `.jsx`, `.tsx` → JS/TS patterns (existing)
   - `.py`, `.pyx`, `.pyi` → Python patterns (new)
   - `.rs` → Rust patterns (new)
   - `.sh`, `.bash` → Shell patterns (new)
   - `.yml`, `.yaml` → CI/config patterns (new)
   - `Dockerfile` → Container patterns (new)

2. **Pattern matching** — same engine, routed by language. Each language has its own `PatternDef[]` array.

3. **Cross-file analysis** (new) — after individual file scanning:
   - If `process.env` + outbound network call in same file → `high` "Credential Exfiltration" (already have this)
   - If `eval()` + obfuscated string in same file → bump to `critical`
   - If install script + network call → `high` "Install-time Data Exfiltration"

4. **Metadata findings** — package.json scripts, setup.py commands, Makefile targets, etc.

5. **Score + Grade** — existing `computeScore()` with deduplication, `computeGrade()`

6. **BasedAgents lookup** — check if any registered agent declares this package/repo

---

## Language-Specific Patterns

### JavaScript/TypeScript (existing)
Already built. No changes needed.

### Python (new)

```typescript
const PYTHON_PATTERNS: PatternDef[] = [
  // ── Critical: code execution ──
  { severity: 'critical', category: 'Code Execution', pattern: 'exec()',
    regex: /\bexec\s*\(/g,
    description: 'exec() — executes arbitrary Python code from strings' },
  { severity: 'critical', category: 'Code Execution', pattern: 'eval()',
    regex: /\beval\s*\(/g,
    description: 'eval() — evaluates arbitrary Python expressions' },
  { severity: 'critical', category: 'Code Execution', pattern: 'compile()',
    regex: /\bcompile\s*\([^)]*,\s*[^)]*,\s*['"]exec['"]/g,
    description: 'compile() with exec mode — compiles code for execution' },
  { severity: 'critical', category: 'Obfuscation', pattern: '__import__',
    regex: /__import__\s*\(/g,
    description: '__import__() — dynamic module import, common in obfuscated code' },
  { severity: 'critical', category: 'Obfuscation', pattern: 'marshal.loads',
    regex: /\bmarshal\.loads?\s*\(/g,
    description: 'marshal.loads() — deserializes bytecode, used to hide malicious code' },
  { severity: 'critical', category: 'Obfuscation', pattern: 'pickle.loads',
    regex: /\bpickle\.loads?\s*\(/g,
    description: 'pickle.loads() — deserializes objects, can execute arbitrary code' },

  // ── High: shell execution ──
  { severity: 'high', category: 'Shell Execution', pattern: 'subprocess',
    regex: /\bsubprocess\.(?:call|run|Popen|check_output|check_call|getoutput)\s*\(/g,
    description: 'subprocess call — can execute shell commands' },
  { severity: 'high', category: 'Shell Execution', pattern: 'os.system',
    regex: /\bos\.system\s*\(/g,
    description: 'os.system() — executes shell commands' },
  { severity: 'high', category: 'Shell Execution', pattern: 'os.popen',
    regex: /\bos\.popen\s*\(/g,
    description: 'os.popen() — opens a pipe to a shell command' },
  { severity: 'high', category: 'Shell Execution', pattern: 'commands.getoutput',
    regex: /\bcommands\.getoutput\s*\(/g,
    description: 'commands.getoutput() — legacy shell execution' },

  // ── High: destructive file ops ──
  { severity: 'high', category: 'Destructive File Operation', pattern: 'os.remove',
    regex: /\bos\.(?:remove|unlink)\s*\(/g,
    description: 'os.remove()/unlink() — deletes files' },
  { severity: 'high', category: 'Destructive File Operation', pattern: 'shutil.rmtree',
    regex: /\bshutil\.rmtree\s*\(/g,
    description: 'shutil.rmtree() — recursively deletes directories' },
  { severity: 'high', category: 'Destructive File Operation', pattern: 'os.chmod',
    regex: /\bos\.chmod\s*\(/g,
    description: 'os.chmod() — modifies file permissions' },

  // ── High: credential access ──
  { severity: 'high', category: 'Credential Exfiltration', pattern: 'env var in network call',
    regex: /(?:requests\.(?:get|post|put)|urllib\.request\.urlopen|httpx\.(?:get|post))\s*\([^)]*os\.environ/g,
    description: 'Environment variable passed into a network call — potential exfiltration' },

  // ── Medium ──
  { severity: 'medium', category: 'Environment Access', pattern: 'os.environ',
    regex: /\bos\.environ\b/g,
    description: 'Accesses environment variables — common for configuration' },
  { severity: 'medium', category: 'Network Call', pattern: 'requests/urllib',
    regex: /\b(?:requests\.(?:get|post|put|delete|patch|head)|urllib\.request\.urlopen)\s*\(/g,
    description: 'HTTP request — makes outbound network connections' },
  { severity: 'medium', category: 'Network Call', pattern: 'socket',
    regex: /\bsocket\.(?:socket|create_connection)\s*\(/g,
    description: 'Raw socket usage — opens network connections' },
  { severity: 'medium', category: 'File System Read', pattern: 'open()',
    regex: /\bopen\s*\([^)]*['"][rwa]/g,
    description: 'File open — reads or writes files on disk' },
  { severity: 'medium', category: 'Crypto Usage', pattern: 'cryptography/hashlib',
    regex: /\b(?:from\s+cryptography|import\s+hashlib|from\s+Crypto)\b/g,
    description: 'Crypto library usage' },
];
```

### Rust (new)

```typescript
const RUST_PATTERNS: PatternDef[] = [
  // ── Critical ──
  { severity: 'critical', category: 'Unsafe Code', pattern: 'unsafe block',
    regex: /\bunsafe\s*\{/g,
    description: 'unsafe block — bypasses Rust safety guarantees' },
  { severity: 'critical', category: 'Code Execution', pattern: 'std::process::Command',
    regex: /\bCommand::new\s*\(/g,
    description: 'Command::new() — executes external processes' },

  // ── High ──
  { severity: 'high', category: 'Shell Execution', pattern: 'shell command string',
    regex: /Command::new\s*\(\s*["'](?:sh|bash|cmd|powershell)/g,
    description: 'Spawns a shell process — can run arbitrary commands' },
  { severity: 'high', category: 'Destructive File Operation', pattern: 'fs::remove',
    regex: /\bfs::remove_(?:file|dir|dir_all)\s*\(/g,
    description: 'Filesystem deletion' },
  { severity: 'high', category: 'Network Call', pattern: 'raw socket',
    regex: /\bTcpStream::connect\b/g,
    description: 'Raw TCP connection' },
  { severity: 'high', category: 'FFI', pattern: 'extern "C"',
    regex: /\bextern\s+"C"\s*\{/g,
    description: 'FFI block — calls into C code, bypasses Rust safety' },

  // ── Medium ──
  { severity: 'medium', category: 'Environment Access', pattern: 'std::env',
    regex: /\bstd::env::(?:var|vars|args)\b/g,
    description: 'Environment variable or argument access' },
  { severity: 'medium', category: 'Network Call', pattern: 'reqwest/hyper',
    regex: /\b(?:reqwest|hyper)::(?:get|Client)\b/g,
    description: 'HTTP client usage' },
  { severity: 'medium', category: 'File System Read', pattern: 'fs::read',
    regex: /\bfs::(?:read|read_to_string|read_dir)\s*\(/g,
    description: 'Filesystem read operations' },
];
```

### Shell Scripts (new)

```typescript
const SHELL_PATTERNS: PatternDef[] = [
  // ── Critical ──
  { severity: 'critical', category: 'Remote Execution', pattern: 'curl | sh',
    regex: /curl\s+[^|]*\|\s*(?:sh|bash|sudo\s+(?:sh|bash))/g,
    description: 'Pipes remote content to shell — executes untrusted code' },
  { severity: 'critical', category: 'Remote Execution', pattern: 'wget | sh',
    regex: /wget\s+[^|]*\|\s*(?:sh|bash|sudo\s+(?:sh|bash))/g,
    description: 'Pipes remote content to shell — executes untrusted code' },
  { severity: 'critical', category: 'Privilege Escalation', pattern: 'chmod 777',
    regex: /chmod\s+777\b/g,
    description: 'chmod 777 — makes files world-readable/writable/executable' },

  // ── High ──
  { severity: 'high', category: 'Credential Access', pattern: 'cat credentials',
    regex: /cat\s+[^\n]*(?:\.ssh|\.aws|\.env|\.npmrc|credentials|password|token|secret)/gi,
    description: 'Reads credential files' },
  { severity: 'high', category: 'Data Exfiltration', pattern: 'curl POST with file',
    regex: /curl\s+[^\n]*(?:-d\s+@|-F\s+['"]?file=@|--data-binary\s+@)/g,
    description: 'Uploads file contents via curl — potential data exfiltration' },
  { severity: 'high', category: 'Destructive', pattern: 'rm -rf',
    regex: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\b/g,
    description: 'Recursive force delete' },
  { severity: 'high', category: 'Persistence', pattern: 'crontab modification',
    regex: /crontab\s+/g,
    description: 'Modifies cron jobs — can establish persistence' },
  { severity: 'high', category: 'Persistence', pattern: 'systemd service install',
    regex: /cp\s+[^\n]*\.service\s+.*systemd|systemctl\s+(?:enable|daemon-reload)/g,
    description: 'Installs a systemd service — establishes persistence' },

  // ── Medium ──
  { severity: 'medium', category: 'Environment Access', pattern: 'env var access',
    regex: /\$\{?(?:HOME|USER|PATH|SSH_AUTH_SOCK|AWS_|GITHUB_TOKEN|NPM_TOKEN)\}?/g,
    description: 'Accesses sensitive environment variables' },
  { severity: 'medium', category: 'Network Call', pattern: 'curl/wget download',
    regex: /(?:curl|wget)\s+(?:https?:\/\/)/g,
    description: 'Downloads content from the internet' },
];
```

### CI/Config YAML (new)

```typescript
const YAML_PATTERNS: PatternDef[] = [
  { severity: 'high', category: 'CI Injection', pattern: 'expression injection',
    regex: /\$\{\{\s*github\.event\.(?:issue|pull_request|comment)\.(?:body|title)\s*\}\}/g,
    description: 'GitHub Actions expression injection — user input in workflow commands' },
  { severity: 'high', category: 'CI Injection', pattern: 'pull_request_target + checkout',
    regex: /pull_request_target/g,
    description: 'pull_request_target event — can expose secrets to untrusted PR code' },
  { severity: 'medium', category: 'CI Permission', pattern: 'write-all permissions',
    regex: /permissions:\s*write-all/g,
    description: 'Overly broad CI permissions' },
];
```

### Dockerfile (new)

```typescript
const DOCKERFILE_PATTERNS: PatternDef[] = [
  { severity: 'high', category: 'Privilege', pattern: 'USER root',
    regex: /^\s*USER\s+root\s*$/gm,
    description: 'Container runs as root' },
  { severity: 'high', category: 'Remote Execution', pattern: 'curl pipe to shell',
    regex: /RUN\s+.*curl\s+[^|]*\|\s*(?:sh|bash)/g,
    description: 'Installs software by piping curl to shell in container build' },
  { severity: 'medium', category: 'Secret Exposure', pattern: 'ARG/ENV with secret',
    regex: /(?:ARG|ENV)\s+(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)\b/gi,
    description: 'Secret passed as build arg or env — may be cached in layer' },
];
```

---

## API Endpoints

### Modified: `POST /v1/scan/trigger`

Extend to accept a `source` field:

```json
{
  "source": "github",
  "target": "RightNow-AI/openfang",
  "ref": "main"
}
```

```json
{
  "source": "npm",
  "target": "@basedagents/mcp",
  "version": "latest"
}
```

```json
{
  "source": "pypi",
  "target": "requests",
  "version": "2.31.0"
}
```

**Backward compatible:** if `source` is omitted and `package` is provided, treat as npm (existing behavior).

**Response:** Same format as today. Add `source` field to response:

```json
{
  "ok": true,
  "source": "github",
  "id": "uuid",
  "package_name": "RightNow-AI/openfang",
  "package_version": "main@abc1234",
  "score": 5,
  "grade": "F",
  "finding_count": 47,
  "critical_high_count": 23,
  "report_url": "https://basedagents.ai/scan/github:RightNow-AI/openfang",
  "message": "Scan complete"
}
```

### Modified: `GET /v1/scan/:identifier`

The `:identifier` param now supports:
- `lodash` → npm (legacy, backward compatible)
- `npm:lodash` → explicit npm
- `github:owner/repo` → GitHub repo
- `pypi:requests` → PyPI package

URL encoding: `github:RightNow-AI%2Fopenfang` (slash in repo name encoded)

### Modified: `GET /v1/scan` (list)

Add `source` filter param:
```
GET /v1/scan?source=github&limit=20
```

---

## Database Changes

### Migration: `0018_scan_source_type.sql`

```sql
-- Add source column (default 'npm' for existing rows)
ALTER TABLE scan_reports ADD COLUMN source TEXT NOT NULL DEFAULT 'npm';

-- Add ref column for GitHub (branch/tag/commit)
ALTER TABLE scan_reports ADD COLUMN ref TEXT;

-- Update unique index to include source
-- (same package name could exist on npm and pypi)
DROP INDEX IF EXISTS idx_scan_reports_package_version;
CREATE UNIQUE INDEX idx_scan_reports_source_package_version 
  ON scan_reports(source, package_name, package_version);
```

---

## Frontend Changes

### Scan Page (`Scan.tsx`)

1. **Source selector** — tabs or dropdown: "npm" | "GitHub" | "PyPI"
2. **Input adapts per source:**
   - npm: package name input (existing)
   - GitHub: `owner/repo` input with optional ref field
   - PyPI: package name input
3. **URL routing:**
   - `/scan/lodash` → npm (backward compatible)
   - `/scan/github:owner/repo` → GitHub
   - `/scan/pypi:package` → PyPI
4. **Report display** — add source badge, show source-specific metadata:
   - GitHub: stars, forks, last commit, contributors, license
   - PyPI: downloads, Python version requirement
5. **Language breakdown** — show which languages were scanned (pie chart or bar)

### Scan List (`ScanList.tsx`)

1. **Source filter tabs** — All | npm | GitHub | PyPI
2. **Source icon** on each card (📦 npm, 🐙 GitHub, 🐍 PyPI)

### Agent Profile (`AgentProfile.tsx`)

1. **Skill cards** — add a "Scan" link/button next to each declared skill that links to its scan report (or triggers a scan)

---

## SDK CLI Changes

### Extended `basedagents scan` command

```bash
# npm (existing, unchanged)
basedagents scan lodash
basedagents scan @scope/package@1.2.3

# GitHub (new)
basedagents scan github:owner/repo
basedagents scan github:owner/repo@branch
basedagents scan https://github.com/owner/repo

# PyPI (new)
basedagents scan pypi:requests
basedagents scan pypi:requests@2.31.0
```

Detection: if the argument contains `github:`, `pypi:`, or looks like a GitHub URL, route to the appropriate resolver. Otherwise default to npm.

The CLI scanner for GitHub/PyPI can use the same resolvers as the Worker (HTTP fetch + in-memory extraction) since these don't need `npm pack`.

---

## Security & Limits

| Limit | Value |
|-------|-------|
| Max tarball/archive size | 50 MB |
| Max extracted text | 10 MB |
| Max files scanned | 5,000 |
| Max file size (individual) | 1 MB (skip larger files) |
| Scan timeout | 30 seconds |
| Rate limit (trigger) | 5/min per IP |
| GitHub API rate limit | 60/hr unauthenticated (use `GITHUB_TOKEN` env if available for 5,000/hr) |

### GitHub-Specific Security

- **Private repos:** Not supported in v1 (would require user auth flow)
- **Large repos:** GitHub tarball API caps at ~100MB; we reject at 50MB
- **Submodules:** Not followed (only scan the repo itself)
- **Binary files:** Skip any file that doesn't decode as valid UTF-8

---

## What's Built vs What's New

| Component | Status |
|-----------|--------|
| npm tarball fetch + extract | ✅ Built |
| Tar parser (Worker-compatible) | ✅ Built |
| JS/TS patterns | ✅ Built |
| Score + Grade calculation | ✅ Built |
| Deduplication in scoring | ✅ Built |
| BasedAgents registry lookup | ✅ Built |
| Scan trigger API | ✅ Built |
| Scan report storage | ✅ Built |
| Frontend scan UI | ✅ Built |
| **GitHub resolver** | 🆕 New |
| **PyPI resolver** | 🆕 New |
| **Python patterns** | 🆕 New |
| **Rust patterns** | 🆕 New |
| **Shell patterns** | 🆕 New |
| **YAML/CI patterns** | 🆕 New |
| **Dockerfile patterns** | 🆕 New |
| **Multi-source API** | 🆕 New |
| **Source selector UI** | 🆕 New |
| **Cross-file analysis** | 🆕 New |
| **DB migration** | 🆕 New |
| **CLI multi-source** | 🆕 New |

---

## Build Order

**Phase 1: GitHub scanning (highest value)**
1. GitHub resolver (fetch tarball via API, extract, return FileEntry[])
2. Shell script patterns (critical for repos like OpenFang)
3. Rust patterns (for Rust projects)
4. YAML/CI patterns
5. Dockerfile patterns
6. Refactor scanner core to accept FileEntry[] from any resolver
7. API: extend `/v1/scan/trigger` with `source: "github"`
8. API: extend `/v1/scan/:identifier` with `github:` prefix
9. DB migration
10. Frontend: source selector + GitHub metadata display

**Phase 2: PyPI**
1. PyPI resolver
2. Python patterns
3. Frontend + CLI support

**Phase 3: Polish**
1. Cross-file analysis
2. Agent profile skill scan links
3. CLI multi-source detection
