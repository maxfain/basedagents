/**
 * basedagents scan <package>
 *
 * Downloads an npm package, scans it for dangerous patterns,
 * and displays a color-coded trust report.
 */

import { scan, type ScanReport, type Finding } from '../scanner/index.js';
import { RegistryClient } from '../index.js';

// ─── Colors ───

const R      = '\x1b[0m';
const bold   = (s: string) => `\x1b[1m${s}${R}`;
const dim    = (s: string) => `\x1b[2m${s}${R}`;
const red    = (s: string) => `\x1b[31m${s}${R}`;
const green  = (s: string) => `\x1b[32m${s}${R}`;
const yellow = (s: string) => `\x1b[33m${s}${R}`;
const cyan   = (s: string) => `\x1b[36m${s}${R}`;
const orange = (s: string) => `\x1b[38;5;208m${s}${R}`;

const API_URL = process.env.BASEDAGENTS_API_URL ?? 'https://api.basedagents.ai';

// ─── Display Helpers ───

function severityIcon(sev: Finding['severity']): string {
  switch (sev) {
    case 'critical': return red('⛔');
    case 'high':     return orange('⚠');
    case 'medium':   return yellow('ℹ');
    case 'low':      return dim('·');
    case 'info':     return cyan('✦');
  }
}

function severityColor(sev: Finding['severity'], s: string): string {
  switch (sev) {
    case 'critical': return red(s);
    case 'high':     return orange(s);
    case 'medium':   return yellow(s);
    case 'low':      return dim(s);
    case 'info':     return cyan(s);
  }
}

function gradeColor(grade: ScanReport['grade']): string {
  switch (grade) {
    case 'A': return green(grade);
    case 'B': return cyan(grade);
    case 'C': return yellow(grade);
    case 'D': return orange(grade);
    case 'F': return red(grade);
  }
}

function scoreColor(score: number, s: string): string {
  if (score >= 90) return green(s);
  if (score >= 75) return cyan(s);
  if (score >= 60) return yellow(s);
  if (score >= 40) return orange(s);
  return red(s);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Upload ───

async function uploadReport(report: ScanReport, apiUrl: string): Promise<void> {
  try {
    const client = new RegistryClient(apiUrl);
    const payload = {
      package_name: report.package,
      package_version: report.version,
      score: report.score,
      grade: report.grade,
      findings: report.findings,
      metadata: report.metadata,
      basedagents: report.basedagents,
      scanned_at: report.scanned_at,
    };
    await client.fetchJson('/v1/scan', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    console.log(green('  ✓ Report uploaded successfully'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(yellow(`  ⚠ Upload failed: ${msg}`));
  }
}

// ─── Main ───

export async function scanCommand(args: string[]): Promise<void> {
  const jsonMode = args.includes('--json');
  const upload = args.includes('--upload');
  const apiUrl = args.includes('--api') ? args[args.indexOf('--api') + 1] : API_URL;

  const positional = args.filter((a, i) =>
    !['--json', '--upload', '--api'].includes(a) && (i === 0 || args[i - 1] !== '--api')
  );
  const packageSpec = positional[0];

  if (!packageSpec || packageSpec === '--help' || packageSpec === '-h') {
    console.log(`
${bold('basedagents scan')} ${dim('<package>')}

Download and scan an npm package for dangerous patterns.
Returns a trust score from 0 (dangerous) to 100 (safe).

${bold('Usage:')}
  basedagents scan lodash
  basedagents scan @modelcontextprotocol/server-filesystem
  basedagents scan some-package@1.2.3

${bold('Options:')}
  --json          Output raw JSON report
  --upload        Submit report to api.basedagents.ai
  --api <url>     Use a custom registry API endpoint
  --help, -h      Show this help message

${bold('Grades:')}
  A  90-100   Clean — minimal risk patterns
  B  75-89    Good — minor issues
  C  60-74    Fair — several concerns
  D  40-59    Poor — significant risk
  F  0-39     Dangerous — critical or many high-severity findings
`);
    process.exit(0);
  }

  if (!jsonMode) {
    console.log('');
    process.stdout.write(`  🔍 ${bold('Scanning')} ${cyan(packageSpec)}...`);
  }

  let report: ScanReport;
  try {
    report = await scan(packageSpec, { apiUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonMode) {
      console.log(JSON.stringify({ error: msg, package: packageSpec }, null, 2));
    } else {
      process.stdout.write('\r');
      console.log(`  ${red('✗')} Failed to scan ${cyan(packageSpec)}`);
      console.log(`  ${dim(msg)}`);
    }
    process.exit(1);
  }

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    if (upload) await uploadReport(report, apiUrl);
    process.exit(report.score >= 60 ? 0 : 1);
  }

  // ── Formatted output ──
  process.stdout.write('\r\x1b[K'); // clear the "Scanning..." line

  const { score, grade, findings, metadata, basedagents: ba } = report;

  console.log('');
  console.log(`  🔍 ${bold(report.package)} ${dim(`v${report.version}`)}`);
  console.log('');

  // Score + Grade
  const scoreStr = scoreColor(score, `${score}/100`);
  const gradeStr = gradeColor(grade);
  console.log(`  ${bold('Score:')} ${scoreStr}   ${bold('Grade:')} ${gradeStr}`);
  console.log('');

  // Group by severity (excluding info)
  const severities: Finding['severity'][] = ['critical', 'high', 'medium', 'low'];
  const bySeverity = new Map<Finding['severity'], Finding[]>();
  for (const sev of severities) {
    const group = findings.filter(f => f.severity === sev);
    if (group.length) bySeverity.set(sev, group);
  }

  if (bySeverity.size === 0) {
    console.log(`  ${green('✓')} ${bold('No dangerous patterns detected')}`);
  } else {
    for (const sev of severities) {
      const group = bySeverity.get(sev);
      if (!group) continue;

      const icon = severityIcon(sev);
      const label = sev.toUpperCase();
      console.log(`  ${icon} ${bold(severityColor(sev, label))} ${dim(`(${group.length})`)}`);

      // Show up to 5 findings per severity to keep output manageable
      const shown = group.slice(0, 5);
      for (const f of shown) {
        const location = `${f.file}:${f.line}`;
        console.log(`    ${severityColor(sev, f.pattern)} ${dim('—')} ${dim(location)}`);
        if (f.context) {
          console.log(`    ${dim('>')} ${f.context.slice(0, 100)}`);
        }
      }
      if (group.length > 5) {
        console.log(`    ${dim(`... and ${group.length - 5} more`)}`);
      }
      console.log('');
    }
  }

  // Install scripts warning
  if (metadata.has_install_scripts) {
    const installInfos = findings.filter(f => f.severity === 'info' && f.category === 'Install Script');
    console.log(`  ${red('⚠')} ${bold(red('Install scripts detected'))} — these run automatically on npm install:`);
    for (const f of installInfos) {
      console.log(`    ${dim(f.context)}`);
    }
    console.log('');
  }

  // Metadata
  console.log(`  ${dim('Files scanned:')}  ${metadata.files_scanned} / ${metadata.total_files}`);
  console.log(`  ${dim('Package size:')}   ${formatBytes(metadata.package_size_bytes)}`);
  console.log(`  ${dim('Dependencies:')}   ${metadata.dependency_count}`);
  console.log('');

  // BasedAgents status
  if (ba.registered) {
    const repStr = ba.reputation_score !== null ? ` (rep: ${(ba.reputation_score * 100).toFixed(0)}%)` : '';
    const verStr = ba.verified ? green('✓ Verified') : yellow('Unverified');
    console.log(`  ${bold('BasedAgents:')} ${green('Registered')}${dim(repStr)}  ${verStr}`);
  } else {
    console.log(`  ${bold('BasedAgents:')} ${yellow('Not registered')}`);
  }
  console.log('');

  // Share link
  // Keep the @ symbol but encode slashes for a clean-looking URL
  const sharePackage = report.package.replace(/\//g, '%2F');
  console.log(`  ${dim('Share:')} ${cyan(`https://basedagents.ai/scan/${sharePackage}`)}`);
  console.log('');

  if (upload) await uploadReport(report, apiUrl);

  process.exit(score >= 60 ? 0 : 1);
}
