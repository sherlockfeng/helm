import { describe, expect, it } from 'vitest';
import { formatDoctorJson, formatDoctorText } from '../../../src/cli/format.js';
import type { DoctorReport } from '../../../src/cli/doctor.js';

const SAMPLE: DoctorReport = {
  generatedAt: '2026-05-04T00:00:00.000Z',
  node: { version: 'v20.12.0', platform: 'darwin', arch: 'arm64' },
  checks: [
    { label: 'Config', level: 'ok', message: 'loaded' },
    { label: 'Database', level: 'info', message: 'not present' },
    { label: 'Cursor hooks', level: 'warn', message: 'helm install needed' },
    { label: 'Bridge socket', level: 'error', message: 'cannot connect' },
  ],
  healthy: false,
};

describe('formatDoctorText', () => {
  it('includes header with generated timestamp and node info', () => {
    const txt = formatDoctorText(SAMPLE);
    expect(txt).toContain('2026-05-04T00:00:00.000Z');
    expect(txt).toContain('v20.12.0');
    expect(txt).toContain('darwin/arm64');
  });

  it('uses level-specific icons', () => {
    const txt = formatDoctorText(SAMPLE);
    expect(txt).toContain('✓ Config');
    expect(txt).toContain('· Database');
    expect(txt).toContain('⚠ Cursor hooks');
    expect(txt).toContain('✗ Bridge socket');
  });

  it('aligns labels to longest', () => {
    const txt = formatDoctorText(SAMPLE);
    const longest = Math.max(...SAMPLE.checks.map((c) => c.label.length));
    // Every check line layout: `<icon><space><label.padEnd(longest)><'  '><message>`.
    // So columns [2, 2+longest) hold the padded label and columns
    // [2+longest, 2+longest+2) are the literal "  " gap.
    for (const line of txt.split('\n')) {
      if (!/^[✓⚠✗·] /.test(line)) continue;
      const padded = line.slice(2, 2 + longest);
      const gap = line.slice(2 + longest, 2 + longest + 2);
      expect(padded.length).toBe(longest);
      expect(gap).toBe('  ');
    }
  });

  it('summary footer reflects health', () => {
    expect(formatDoctorText({ ...SAMPLE, healthy: true })).toContain('All checks passed');
    expect(formatDoctorText(SAMPLE)).toContain('Some checks need attention');
  });
});

describe('formatDoctorJson', () => {
  it('returns valid JSON of the report', () => {
    const parsed = JSON.parse(formatDoctorJson(SAMPLE));
    expect(parsed.generatedAt).toBe(SAMPLE.generatedAt);
    expect(parsed.node.version).toBe('v20.12.0');
    expect(parsed.checks).toHaveLength(4);
  });
});
