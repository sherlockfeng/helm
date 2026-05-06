/**
 * Pure rendering of DoctorReport into either a TTY-friendly text block or
 * machine-readable JSON. Kept separate from doctor.ts so the data
 * gathering stays pure and the renderer can be swapped (e.g. a future
 * markdown table for the diagnostics bundle).
 */

import type { CheckLevel, DoctorReport } from './doctor.js';

const ICONS: Record<CheckLevel, string> = {
  ok: '✓',
  warn: '⚠',
  error: '✗',
  info: '·',
};

/**
 * Render the report as a text block fit for `helm doctor` stdout. One
 * column for icon + label, one column for the message. Footer summarizes
 * health.
 */
export function formatDoctorText(report: DoctorReport): string {
  const labelWidth = Math.max(...report.checks.map((c) => c.label.length));
  const lines: string[] = [];

  lines.push(`Helm Doctor — ${report.generatedAt}`);
  lines.push(`  Node ${report.node.version}  ${report.node.platform}/${report.node.arch}`);
  lines.push('');

  for (const check of report.checks) {
    const icon = ICONS[check.level];
    const label = check.label.padEnd(labelWidth);
    lines.push(`${icon} ${label}  ${check.message}`);
  }
  lines.push('');
  lines.push(report.healthy
    ? 'All checks passed.'
    : 'Some checks need attention. See ⚠ / ✗ items above.');
  return lines.join('\n');
}

/**
 * JSON serialization. Stable shape so tooling (CI / bundle) can grep on it.
 */
export function formatDoctorJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}
