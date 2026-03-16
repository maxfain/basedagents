/**
 * npm resolver — fetches a package tarball from registry.npmjs.org and
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

const SCANNABLE_EXTS = new Set(['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx']);

function isScannable(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return false;
  return SCANNABLE_EXTS.has(name.slice(dot).toLowerCase());
}

interface NpmPackageMeta {
  name: string;
  version: string;
  dist: { tarball: string; size?: number };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
  description?: string;
}

export interface NpmResolveResult {
  files: FileEntry[];
  metadata: SourceMetadata;
  /** Parsed package.json (for install scripts, dep count, bin) */
  pkgJson: NpmPackageMeta | null;
}

async function fetchNpmMetadata(packageName: string, version: string): Promise<NpmPackageMeta> {
  const encodedName = packageName.startsWith('@')
    ? packageName.replace('/', '%2F')
    : packageName;

  const url = version === 'latest'
    ? `https://registry.npmjs.org/${encodedName}/latest`
    : `https://registry.npmjs.org/${encodedName}/${version}`;

  const res = await fetch(url);
  if (res.status === 404) throw new Error('PACKAGE_NOT_FOUND');
  if (!res.ok) throw new Error(`NPM_REGISTRY_ERROR:${res.status}`);

  const data = await res.json() as NpmPackageMeta;
  if (!data.dist?.tarball) throw new Error('PACKAGE_NOT_FOUND');
  return data;
}

export async function resolveNpm(
  packageName: string,
  version = 'latest',
): Promise<NpmResolveResult> {
  // 1. Fetch metadata
  const meta = await fetchNpmMetadata(packageName, version);
  const pkgVersion = meta.version;
  const tarballUrl = meta.dist.tarball;

  // MED-7: Validate tarball URL to prevent open redirect / SSRF via poisoned registry responses
  if (!tarballUrl.startsWith('https://registry.npmjs.org/')) {
    throw new Error('INVALID_TARBALL_URL');
  }

  // Check size
  const headRes = await fetch(tarballUrl, { method: 'HEAD' });
  const contentLength = parseInt(headRes.headers.get('content-length') || '0', 10);
  if (contentLength > MAX_TARBALL_BYTES) {
    throw new Error(`TARBALL_TOO_LARGE:${contentLength}`);
  }

  // 2. Fetch tarball
  const tgzRes = await fetch(tarballUrl);
  if (!tgzRes.ok) throw new Error(`TARBALL_FETCH_ERROR:${tgzRes.status}`);
  if (!tgzRes.body) throw new Error('TARBALL_FETCH_ERROR:no_body');

  // 3. Decompress
  const ds = new DecompressionStream('gzip');
  const tarStream = tgzRes.body.pipeThrough(ds);

  // 4. Parse tar entries
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const files: FileEntry[] = [];
  let totalFiles = 0;
  let totalTextBytes = 0;
  let pkgJson: NpmPackageMeta | null = null;

  for await (const entry of parseTar(tarStream, MAX_TARBALL_BYTES)) {
    if (entry.type !== 'file') continue;

    const relPath = entry.name.replace(/^package\//, '');
    totalFiles++;

    if (relPath === 'package.json' && !pkgJson) {
      try {
        pkgJson = JSON.parse(decoder.decode(entry.content)) as NpmPackageMeta;
      } catch { /* ignore */ }
      continue;
    }

    if (!isScannable(relPath)) continue;
    if (files.length >= MAX_FILES) continue;
    if (totalTextBytes >= MAX_TEXT_BYTES) continue;
    if (entry.size > MAX_FILE_BYTES) continue;

    const text = decoder.decode(entry.content);
    totalTextBytes += text.length;

    files.push({ path: relPath, content: text, size: entry.size });
  }

  const depCount =
    Object.keys(pkgJson?.dependencies ?? meta.dependencies ?? {}).length +
    Object.keys(pkgJson?.devDependencies ?? meta.devDependencies ?? {}).length;

  // Fetch monthly download count for provenance bonus
  let downloadsLastMonth: number | undefined;
  try {
    const encodedName = packageName.startsWith('@')
      ? packageName.replace('/', '%2F')
      : packageName;
    const dlRes = await fetch(
      `https://api.npmjs.org/downloads/point/last-month/${encodedName}`,
      { headers: { 'User-Agent': 'BasedAgents-Scanner/1.0' } },
    );
    if (dlRes.ok) {
      const dlData = await dlRes.json() as { downloads?: number };
      if (typeof dlData.downloads === 'number') {
        downloadsLastMonth = dlData.downloads;
      }
    }
  } catch { /* non-fatal */ }

  const sourceMeta: SourceMetadata = {
    source: 'npm',
    name: packageName,
    version: pkgVersion,
    description: pkgJson?.description ?? meta.description,
    total_size: totalTextBytes,
    total_files: totalFiles,
    scannable_files: files.length,
    extra: {
      dependency_count: depCount,
      bin: pkgJson?.bin ?? meta.bin,
      scripts: pkgJson?.scripts ?? meta.scripts,
      ...(downloadsLastMonth !== undefined ? { downloads_last_month: downloadsLastMonth } : {}),
    },
  };

  return { files, metadata: sourceMeta, pkgJson };
}
