/**
 * PyPI resolver — fetches a package sdist from pypi.org and
 * returns FileEntry[] + SourceMetadata for the shared scanner core.
 *
 * Worker-compatible: no fs, no child_process.
 */

import type { FileEntry, SourceMetadata } from '../core.js';
import { parseTar } from '../tar.js';

const MAX_TARBALL_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_TEXT_BYTES    = 10 * 1024 * 1024; // 10 MB total extracted text
const MAX_FILES         = 5_000;
const MAX_FILE_BYTES    = 1 * 1024 * 1024;  // 1 MB per file

const SCANNABLE_EXTS = new Set(['.py', '.pyx', '.pyi', '.sh', '.bash', '.yml', '.yaml']);

// Directories to skip
const SKIP_DIRS = ['__pycache__/', '.tox/', '.egg-info/', 'tests/', 'test/'];

function isScannable(name: string): boolean {
  // Check Dockerfile
  const basename = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  if (basename === 'Dockerfile' || basename.startsWith('Dockerfile.')) return true;

  const dot = name.lastIndexOf('.');
  if (dot === -1) return false;
  return SCANNABLE_EXTS.has(name.slice(dot).toLowerCase());
}

function shouldSkip(path: string): boolean {
  const lower = path.toLowerCase();
  for (const dir of SKIP_DIRS) {
    if (lower.includes('/' + dir) || lower.endsWith('/' + dir.replace('/', ''))) return true;
    // Also check from root
    if (lower.startsWith(dir)) return true;
  }
  return false;
}

// ─── PyPI API response types ───

interface PyPIRelease {
  filename: string;
  packagetype: 'sdist' | 'bdist_wheel' | string;
  url: string;
  size: number;
  digests: { md5: string; sha256: string };
}

interface PyPIInfo {
  name: string;
  version: string;
  summary?: string;
  author?: string;
  author_email?: string;
  license?: string;
  requires_python?: string;
  home_page?: string;
  project_url?: string;
  project_urls?: Record<string, string>;
  classifiers?: string[];
  description?: string;
}

interface PyPIApiResponse {
  info: PyPIInfo;
  urls: PyPIRelease[];
  releases?: Record<string, PyPIRelease[]>;
}

export interface PyPIResolveResult {
  files: FileEntry[];
  metadata: SourceMetadata;
}

async function fetchPyPIMetadata(packageName: string, version?: string): Promise<PyPIApiResponse> {
  const url = version
    ? `https://pypi.org/pypi/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}/json`
    : `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`;

  console.log(`[pypi-resolver] Fetching metadata: ${url}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BasedAgents-Scanner/1.0 (https://basedagents.ai)', 'Accept': 'application/json' },
    redirect: 'follow',
  });
  console.log(`[pypi-resolver] Response status: ${res.status}, url: ${res.url}`);
  if (res.status === 404) throw new Error('PACKAGE_NOT_FOUND');
  if (!res.ok) throw new Error(`PYPI_REGISTRY_ERROR:${res.status}`);

  return res.json() as Promise<PyPIApiResponse>;
}

export async function resolvePyPI(
  packageName: string,
  version?: string,
): Promise<PyPIResolveResult> {
  // 1. Fetch metadata
  const data = await fetchPyPIMetadata(packageName, version);
  const info = data.info;
  const pkgVersion = info.version;

  // 2. Find sdist (.tar.gz) from urls array
  const urls: PyPIRelease[] = data.urls || [];
  const sdist = urls.find(u => u.packagetype === 'sdist' && u.filename.endsWith('.tar.gz'));

  if (!sdist) {
    // Check if there's a wheel (but we don't support zip parsing yet)
    const wheel = urls.find(u => u.packagetype === 'bdist_wheel' || u.filename.endsWith('.whl'));
    if (wheel) {
      throw new Error('WHEEL_ONLY_PACKAGE');
    }
    throw new Error('PACKAGE_NOT_FOUND');
  }

  // 3. Check file size
  if (sdist.size > MAX_TARBALL_BYTES) {
    throw new Error(`TARBALL_TOO_LARGE:${sdist.size}`);
  }

  // Also do a HEAD check for size if sdist.size is 0
  if (sdist.size === 0) {
    const headRes = await fetch(sdist.url, { method: 'HEAD', headers: { 'User-Agent': 'BasedAgents-Scanner/1.0' } });
    const contentLength = parseInt(headRes.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_TARBALL_BYTES) {
      throw new Error(`TARBALL_TOO_LARGE:${contentLength}`);
    }
  }

  // 4. Download the sdist
  const tgzRes = await fetch(sdist.url, { headers: { 'User-Agent': 'BasedAgents-Scanner/1.0' } });
  if (!tgzRes.ok) throw new Error(`TARBALL_FETCH_ERROR:${tgzRes.status}`);
  if (!tgzRes.body) throw new Error('TARBALL_FETCH_ERROR:no_body');

  // 5. Decompress gzip → tar stream
  const ds = new DecompressionStream('gzip');
  const tarStream = tgzRes.body.pipeThrough(ds);

  // 6. Parse tar entries
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const files: FileEntry[] = [];
  let totalFiles = 0;
  let totalTextBytes = 0;

  // Track setup file presence
  let hasSetupPy = false;
  let hasSetupCfg = false;
  let hasPyprojectToml = false;

  for await (const entry of parseTar(tarStream, MAX_TARBALL_BYTES)) {
    if (entry.type !== 'file') continue;

    // Strip the leading package-version/ prefix (PyPI sdists are wrapped in packagename-version/)
    const relPath = entry.name.replace(/^[^/]+\//, '');
    totalFiles++;

    // Check for setup files (before skip check — these are usually at root)
    const lowerPath = relPath.toLowerCase();
    if (lowerPath === 'setup.py')         hasSetupPy = true;
    if (lowerPath === 'setup.cfg')        hasSetupCfg = true;
    if (lowerPath === 'pyproject.toml')   hasPyprojectToml = true;

    // Skip unwanted directories
    if (shouldSkip(relPath)) continue;

    // Skip non-scannable files
    if (!isScannable(relPath)) continue;

    if (files.length >= MAX_FILES) continue;
    if (totalTextBytes >= MAX_TEXT_BYTES) continue;
    if (entry.size > MAX_FILE_BYTES) continue;

    const text = decoder.decode(entry.content);
    totalTextBytes += text.length;

    files.push({ path: relPath, content: text, size: entry.size });
  }

  // 7. Build metadata
  const sourceMeta: SourceMetadata = {
    source: 'pypi',
    name: packageName,
    version: pkgVersion,
    description: info.summary ?? info.description,
    total_size: totalTextBytes,
    total_files: totalFiles,
    scannable_files: files.length,
    extra: {
      author: info.author,
      author_email: info.author_email,
      license: info.license,
      requires_python: info.requires_python,
      home_page: info.home_page,
      project_url: info.project_url,
      project_urls: info.project_urls,
      classifiers: info.classifiers,
      has_setup_py: hasSetupPy,
      has_setup_cfg: hasSetupCfg,
      has_pyproject_toml: hasPyprojectToml,
    },
  };

  return { files, metadata: sourceMeta };
}
