/**
 * GitHub resolver — fetches a repo tarball via the GitHub API and returns
 * FileEntry[] + SourceMetadata for the shared scanner core.
 *
 * Worker-compatible: no fs, no child_process.
 * Uses unauthenticated requests (60/hr). Set GITHUB_TOKEN env for 5,000/hr.
 */

import type { FileEntry, SourceMetadata } from '../core.js';
import { parseTar } from '../tar.js';

const MAX_TARBALL_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_TEXT_BYTES    = 10 * 1024 * 1024; // 10 MB total extracted text
const MAX_FILES         = 5_000;
const MAX_FILE_BYTES    = 1 * 1024 * 1024;  // 1 MB per file

const GITHUB_UA = 'BasedAgents-Scanner/1.0';

const SCANNABLE_EXTS = new Set([
  '.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx',
  '.py', '.pyx', '.pyi',
  '.rs',
  '.sh', '.bash',
  '.yml', '.yaml',
]);

// Directories to skip
const SKIP_DIRS = ['node_modules/', 'vendor/', '.git/', 'target/'];

function isScannable(filePath: string): boolean {
  const lower = filePath.toLowerCase();

  // Skip unwanted directories
  for (const dir of SKIP_DIRS) {
    if (lower.includes('/' + dir) || lower.startsWith(dir)) return false;
  }

  const lastSlash = filePath.lastIndexOf('/');
  const basename = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;

  // Dockerfile (no extension)
  if (basename === 'Dockerfile' || basename.startsWith('Dockerfile.')) return true;

  const dotIdx = basename.lastIndexOf('.');
  if (dotIdx === -1) return false;
  return SCANNABLE_EXTS.has(basename.slice(dotIdx).toLowerCase());
}

// ─── GitHub API types ───

interface GitHubRepoResponse {
  full_name: string;
  description: string | null;
  default_branch: string;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  watchers_count: number;
  language: string | null;
  size: number;
  created_at: string;
  pushed_at: string;
  license: { spdx_id: string } | null;
}

// ─── Public types ───

export interface GitHubResolveResult {
  files: FileEntry[];
  metadata: SourceMetadata;
}

// ─── Resolver ───

export async function resolveGitHub(
  owner: string,
  repo: string,
  ref?: string,
  githubToken?: string,
): Promise<GitHubResolveResult> {
  const headers: Record<string, string> = {
    'User-Agent': GITHUB_UA,
    'Accept': 'application/vnd.github+json',
  };
  if (githubToken) {
    headers['Authorization'] = `Bearer ${githubToken}`;
  }

  // 1. Fetch repo metadata
  const metaRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  if (metaRes.status === 404) throw new Error('GITHUB_REPO_NOT_FOUND');
  if (metaRes.status === 403) throw new Error('GITHUB_RATE_LIMITED');
  if (!metaRes.ok) throw new Error(`GITHUB_API_ERROR:${metaRes.status}`);

  const repoMeta = await metaRes.json() as GitHubRepoResponse;

  // 2. Resolve ref
  const resolvedRef = ref || repoMeta.default_branch;

  // 3. Fetch tarball URL (GitHub returns 302 redirect)
  const tarballUrl = `https://api.github.com/repos/${owner}/${repo}/tarball/${resolvedRef}`;

  // Follow redirect manually to check Content-Length
  const redirectRes = await fetch(tarballUrl, {
    headers,
    redirect: 'manual',
  });

  let finalTarballUrl: string;
  if (redirectRes.status === 302 || redirectRes.status === 301) {
    finalTarballUrl = redirectRes.headers.get('location') || tarballUrl;
  } else if (redirectRes.ok) {
    // Some environments auto-follow
    finalTarballUrl = tarballUrl;
  } else {
    throw new Error(`GITHUB_TARBALL_ERROR:${redirectRes.status}`);
  }

  // 4. Fetch the tarball, check size
  const tgzRes = await fetch(finalTarballUrl, {
    headers: { 'User-Agent': GITHUB_UA },
  });
  if (!tgzRes.ok) throw new Error(`GITHUB_TARBALL_FETCH_ERROR:${tgzRes.status}`);
  if (!tgzRes.body) throw new Error('GITHUB_TARBALL_FETCH_ERROR:no_body');

  const contentLength = parseInt(tgzRes.headers.get('content-length') || '0', 10);
  if (contentLength > MAX_TARBALL_BYTES) {
    throw new Error(`TARBALL_TOO_LARGE:${contentLength}`);
  }

  // 5. Decompress gzip → tar stream
  const ds = new DecompressionStream('gzip');
  const tarStream = tgzRes.body.pipeThrough(ds);

  // 6. Parse tar entries
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const files: FileEntry[] = [];
  let totalFiles = 0;
  let totalTextBytes = 0;
  let hasCI = false;

  for await (const entry of parseTar(tarStream, MAX_TARBALL_BYTES)) {
    if (entry.type !== 'file') continue;

    // GitHub tarballs prefix with "owner-repo-sha/" — strip it
    const firstSlash = entry.name.indexOf('/');
    const relPath = firstSlash >= 0 ? entry.name.slice(firstSlash + 1) : entry.name;

    totalFiles++;

    // Check for CI presence (before filtering)
    if (
      relPath.startsWith('.github/workflows/') && relPath.endsWith('.yml') ||
      relPath.startsWith('.github/workflows/') && relPath.endsWith('.yaml') ||
      relPath === '.circleci/config.yml' ||
      relPath === 'Jenkinsfile'
    ) {
      hasCI = true;
    }

    if (!isScannable(relPath)) continue;
    if (files.length >= MAX_FILES) continue;
    if (totalTextBytes >= MAX_TEXT_BYTES) continue;
    if (entry.size > MAX_FILE_BYTES) continue;

    // Try to decode as UTF-8; skip binary files
    const text = decoder.decode(entry.content);
    // Heuristic: if replacement chars are >5% of content, likely binary
    const replacements = (text.match(/\uFFFD/g) || []).length;
    if (text.length > 0 && replacements / text.length > 0.05) continue;

    totalTextBytes += text.length;
    files.push({ path: relPath, content: text, size: entry.size });
  }

  // 7. Build metadata
  const fullName = `${owner}/${repo}`;

  const sourceMeta: SourceMetadata = {
    source: 'github',
    name: fullName,
    version: resolvedRef,
    description: repoMeta.description ?? undefined,
    total_size: totalTextBytes,
    total_files: totalFiles,
    scannable_files: files.length,
    extra: {
      stars: repoMeta.stargazers_count,
      forks: repoMeta.forks_count,
      open_issues: repoMeta.open_issues_count,
      watchers: repoMeta.watchers_count,
      default_branch: repoMeta.default_branch,
      language: repoMeta.language,
      license: repoMeta.license?.spdx_id ?? null,
      created_at: repoMeta.created_at,
      pushed_at: repoMeta.pushed_at,
      has_ci: hasCI,
      repo_size_kb: repoMeta.size,
    },
  };

  return { files, metadata: sourceMeta };
}

/**
 * Parse a GitHub target string into owner + repo.
 * Accepts: "owner/repo", "https://github.com/owner/repo", "github:owner/repo"
 */
export function parseGitHubTarget(target: string): { owner: string; repo: string } {
  // Full URL
  const urlMatch = target.match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2].replace(/\.git$/, '') };
  }

  // "github:owner/repo"
  const prefixMatch = target.match(/^github:([^/]+)\/(.+)$/);
  if (prefixMatch) {
    return { owner: prefixMatch[1], repo: prefixMatch[2] };
  }

  // "owner/repo"
  const slashMatch = target.match(/^([^/]+)\/([^/]+)$/);
  if (slashMatch) {
    return { owner: slashMatch[1], repo: slashMatch[2] };
  }

  throw new Error(`INVALID_GITHUB_TARGET:${target}`);
}
