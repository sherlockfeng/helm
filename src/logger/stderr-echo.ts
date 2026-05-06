/**
 * Helm logger — `process.stderr` echo (Phase 28 / §25.3 C4).
 *
 * The file logger writes JSON Lines under `~/.helm/logs/`; great for shipping
 * to a diagnostics bundle, but invisible while running `pnpm dev`. This
 * module provides a `LoggerFactoryOptions['echo']` callback that mirrors
 * relevant records to `process.stderr` in a human-readable, optionally
 * colorized form so warnings and errors surface in the dev console without
 * the user having to `tail -f` a logfile.
 *
 * Behavior:
 *   - Default minLevel = 'warn' (warn + error). Bump via env
 *     `HELM_LOG_ECHO_LEVEL=debug|info|warn|error`. Use `off` to disable.
 *   - HELM_DEV=1 bumps the default to 'info' so dev runs see the bridge
 *     boot / session_start chatter without further config.
 *   - ANSI colors only when `stderr.isTTY` is true (so test runners and
 *     CI / piped output stay clean).
 *
 * The helper is pure of Electron / Node specifics so unit tests can drive it
 * with a fake stream + isTTY=false.
 */

import type { LogLevel, LogRecord } from './index.js';

export type StderrEchoLevel = LogLevel | 'off';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const RESET = '\x1b[0m';
const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[2m', // dim
  info: '\x1b[36m', // cyan
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
};

const VALID_LEVELS = new Set<StderrEchoLevel>(['debug', 'info', 'warn', 'error', 'off']);

export interface StderrEchoOptions {
  /** Threshold; below this records are dropped. Defaults to 'warn'. */
  minLevel?: LogLevel;
  /** Force colors on/off. When undefined, auto-detect via `stream.isTTY`. */
  color?: boolean;
  /**
   * Sink — the writable to push formatted lines to. Defaults to
   * `process.stderr`. Tests inject a buffer.
   */
  stream?: { write(s: string): void; isTTY?: boolean };
}

/**
 * Resolve the effective echo threshold from env. Returns `'off'` to mean
 * "don't wire any echo at all"; the caller can then skip passing `echo`.
 *
 * Precedence:
 *   - `HELM_LOG_ECHO_LEVEL` (explicit) wins
 *   - `HELM_DEV=1` → 'info'
 *   - default 'warn'
 */
export function resolveStderrEchoLevel(env: NodeJS.ProcessEnv = process.env): StderrEchoLevel {
  const raw = env['HELM_LOG_ECHO_LEVEL'];
  if (raw !== undefined) {
    const lower = raw.trim().toLowerCase() as StderrEchoLevel;
    if (VALID_LEVELS.has(lower)) return lower;
    // Invalid override — fall through to defaults rather than throwing during boot.
  }
  if (env['HELM_DEV'] === '1') return 'info';
  return 'warn';
}

function pad(level: LogLevel): string {
  return level.toUpperCase().padEnd(5, ' ');
}

function formatRecord(record: LogRecord, useColor: boolean): string {
  // ts is ISO-8601; show the time-of-day portion for compactness in interactive use.
  const time = record.ts.slice(11, 23);
  const head = `[${time}] ${pad(record.level)}  ${record.module}  ${record.msg}`;

  // Tail: hostSessionId + serialized event/data when present. Keep payload on
  // the same line so devs can grep by msg or module.
  const extras: string[] = [];
  if (record.hostSessionId) extras.push(`session=${record.hostSessionId}`);
  if (record.event) extras.push(`event=${record.event}`);
  if (record.data !== undefined) {
    try { extras.push(`data=${JSON.stringify(record.data)}`); }
    catch { extras.push('data=<unserializable>'); }
  }

  const line = extras.length === 0 ? head : `${head} ${extras.join(' ')}`;
  if (!useColor) return line;
  return `${COLORS[record.level]}${line}${RESET}`;
}

/**
 * Build a stderr echo callback compatible with `LoggerFactoryOptions.echo`.
 * Returns `null` when the resolved level is `'off'` so the caller can skip
 * wiring entirely (the LoggerFactory's `echo` is optional).
 */
export function createStderrEcho(
  options: StderrEchoOptions & { level?: StderrEchoLevel } = {},
): ((record: LogRecord) => void) | null {
  const level: StderrEchoLevel = options.level ?? options.minLevel ?? 'warn';
  if (level === 'off') return null;

  const stream = options.stream ?? process.stderr;
  const useColor = options.color ?? Boolean(stream.isTTY);
  const threshold = LEVEL_ORDER[level];

  return (record: LogRecord) => {
    if (LEVEL_ORDER[record.level] < threshold) return;
    try {
      stream.write(formatRecord(record, useColor) + '\n');
    } catch {
      // stderr write failure is unrecoverable noise — never throw.
    }
  };
}
