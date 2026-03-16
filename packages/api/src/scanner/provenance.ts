/**
 * Provenance bonus — rewards established, well-known packages with a score bonus.
 *
 * This does NOT hide findings; it adjusts the final score to reflect that a package
 * with millions of downloads and years of history is less likely to be malicious.
 *
 * Worker-compatible: no fs, no child_process.
 */

import type { SourceMetadata } from './core.js';

export interface ProvenanceResult {
  bonus: number;
  signals: string[];
}

export function computeProvenanceBonus(metadata: SourceMetadata): ProvenanceResult {
  let bonus = 0;
  const signals: string[] = [];
  const extra = metadata.extra;

  if (metadata.source === 'npm') {
    const downloads = extra.downloads_last_month as number | undefined;
    if (downloads && downloads > 1_000_000) {
      bonus += 10;
      signals.push(`${(downloads / 1e6).toFixed(1)}M monthly downloads`);
    } else if (downloads && downloads > 100_000) {
      bonus += 7;
      signals.push(`${(downloads / 1e3).toFixed(0)}K monthly downloads`);
    } else if (downloads && downloads > 10_000) {
      bonus += 5;
      signals.push(`${(downloads / 1e3).toFixed(0)}K monthly downloads`);
    } else if (downloads && downloads > 1_000) {
      bonus += 2;
      signals.push(`${(downloads / 1e3).toFixed(1)}K monthly downloads`);
    }
  }

  if (metadata.source === 'github') {
    const stars = extra.stars as number | undefined;
    if (stars && stars > 10_000) {
      bonus += 10;
      signals.push(`${(stars / 1000).toFixed(1)}K stars`);
    } else if (stars && stars > 1_000) {
      bonus += 7;
      signals.push(`${(stars / 1000).toFixed(1)}K stars`);
    } else if (stars && stars > 100) {
      bonus += 5;
      signals.push(`${stars} stars`);
    } else if (stars && stars > 10) {
      bonus += 2;
      signals.push(`${stars} stars`);
    }

    if (extra.has_ci) {
      bonus += 3;
      signals.push('CI configured');
    }
    if ((extra.forks as number | undefined) && (extra.forks as number) > 100) {
      bonus += 2;
      signals.push(`${extra.forks} forks`);
    }
  }

  if (metadata.source === 'pypi') {
    const classifiers = extra.classifiers as string[] | undefined;
    if (classifiers?.some(c => c.includes('Production/Stable'))) {
      bonus += 5;
      signals.push('Production/Stable');
    }
    if (extra.requires_python) {
      bonus += 2;
      signals.push('Python version specified');
    }
    // Package age: if upload_time is available and > 2 years old
    const uploadTime = extra.upload_time as string | undefined;
    if (uploadTime) {
      const ageMs = Date.now() - new Date(uploadTime).getTime();
      const twoYearsMs = 2 * 365 * 24 * 60 * 60 * 1000;
      if (ageMs > twoYearsMs) {
        bonus += 3;
        const years = Math.floor(ageMs / (365 * 24 * 60 * 60 * 1000));
        signals.push(`${years}+ years old`);
      }
    }
  }

  // Cap bonus at 15
  bonus = Math.min(15, bonus);

  return { bonus, signals };
}
