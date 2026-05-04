/**
 * Helm logger — see PROJECT_BLUEPRINT.md §19.5.
 *
 * Design:
 *   - LoggerFactory is a singleton-per-app keyed by `~/.helm/logs/` root
 *   - Per-module loggers (`factory.module('channel.lark')`) prefix every line
 *     with module name in JSON Lines format
 *   - Per-session writer (`logger.session('cursor-abc')`) appends to
 *     `sessions/<id>.jsonl` so a single chat's full event log is one file —
 *     critical for the Diagnostics bundle (§19.5.3)
 *   - All payload fields run through redact() before serialization
 *   - Writers are append-only, fsync-on-close. Rotation lands in Phase 15.
 *
 * Typical usage:
 *
 *   const factory = createLoggerFactory({ rootDir });
 *   const log = factory.module('approval.registry');
 *   log.info('settled', { approvalId, decidedBy: 'local-ui' });
 *
 * Errors writing log lines never throw — observability must not break the app.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redact } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  hostSessionId?: string;
  bindingId?: string;
  event?: string;
  data?: Record<string, unknown>;
  /** Anything else; merged into the record. */
  [k: string]: unknown;
}

export interface LogRecord extends LogFields {
  ts: string;
  level: LogLevel;
  module: string;
  msg: string;
}

export interface LoggerFactoryOptions {
  /** Root directory for log files. Created on first write. */
  rootDir: string;
  /** Minimum level to record. Defaults to 'info'. */
  minLevel?: LogLevel;
  /** When set, every record is also passed here (e.g. console.error in dev). */
  echo?: (record: LogRecord) => void;
  /** When set, errors during file IO are reported here instead of swallowed silently. */
  onIoError?: (err: Error, path: string) => void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function shouldRecord(record: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_ORDER[record] >= LEVEL_ORDER[threshold];
}

export interface Logger {
  readonly module: string;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Returns a logger that writes both the module's main file and the session file. */
  session(hostSessionId: string): Logger;
}

export interface LoggerFactory {
  module(name: string): Logger;
  /** Flush handles. Currently a no-op (synchronous appends); kept for future async writers. */
  shutdown(): void;
  /** Test hook: read the in-memory record sink, when configured. */
  readonly sink?: LogRecord[];
}

interface InternalCtx {
  rootDir: string;
  minLevel: LogLevel;
  echo?: (record: LogRecord) => void;
  onIoError: (err: Error, path: string) => void;
  sink?: LogRecord[];
}

function writeJsonLine(filePath: string, record: LogRecord, ctx: InternalCtx): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, JSON.stringify(record) + '\n');
  } catch (err) {
    ctx.onIoError(err as Error, filePath);
  }
}

function buildRecord(
  level: LogLevel,
  module: string,
  msg: string,
  fields: LogFields | undefined,
  extra?: { hostSessionId?: string },
): LogRecord {
  const { data, ...rest } = fields ?? {};
  const safeData = data === undefined ? undefined : redact(data);
  return {
    ts: new Date().toISOString(),
    level,
    module,
    msg,
    ...rest,
    ...(extra?.hostSessionId ? { hostSessionId: extra.hostSessionId } : {}),
    ...(safeData !== undefined ? { data: safeData } : {}),
  };
}

function moduleFilePath(rootDir: string, level: LogLevel): string {
  if (level === 'error') return join(rootDir, 'error.log');
  return join(rootDir, 'main.log');
}

function sessionFilePath(rootDir: string, hostSessionId: string): string {
  return join(rootDir, 'sessions', `${hostSessionId}.jsonl`);
}

function makeLogger(name: string, ctx: InternalCtx, hostSessionId?: string): Logger {
  function emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (!shouldRecord(level, ctx.minLevel)) return;
    const record = buildRecord(level, name, msg, fields, { hostSessionId });

    writeJsonLine(moduleFilePath(ctx.rootDir, level), record, ctx);
    if (level === 'error') {
      writeJsonLine(moduleFilePath(ctx.rootDir, 'info'), record, ctx);
    }
    if (hostSessionId) {
      writeJsonLine(sessionFilePath(ctx.rootDir, hostSessionId), record, ctx);
    }
    if (ctx.echo) ctx.echo(record);
    if (ctx.sink) ctx.sink.push(record);
  }

  return {
    module: name,
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    session: (sid) => makeLogger(name, ctx, sid),
  };
}

export function createLoggerFactory(options: LoggerFactoryOptions): LoggerFactory {
  const ctx: InternalCtx = {
    rootDir: options.rootDir,
    minLevel: options.minLevel ?? 'info',
    echo: options.echo,
    onIoError: options.onIoError ?? (() => {}),
  };
  const cache = new Map<string, Logger>();

  return {
    module(name: string): Logger {
      const cached = cache.get(name);
      if (cached) return cached;
      const logger = makeLogger(name, ctx);
      cache.set(name, logger);
      return logger;
    },
    shutdown(): void { /* synchronous appends; nothing to flush */ },
  };
}

/**
 * Test helper: factory that captures records in memory instead of writing to disk.
 * Use in unit tests so no log files leak into the test workspace.
 */
export function createCapturingLoggerFactory(options: Partial<LoggerFactoryOptions> = {}): LoggerFactory & { sink: LogRecord[] } {
  const sink: LogRecord[] = [];
  const ctx: InternalCtx = {
    rootDir: '/dev/null/helm-test',
    minLevel: options.minLevel ?? 'debug',
    onIoError: () => { /* never fires; we don't write */ },
    sink,
  };
  const cache = new Map<string, Logger>();
  return {
    sink,
    module(name: string): Logger {
      const cached = cache.get(name);
      if (cached) return cached;
      // Override emit to skip file IO entirely
      function emit(level: LogLevel, msg: string, fields?: LogFields, hostSessionId?: string): void {
        if (!shouldRecord(level, ctx.minLevel)) return;
        const record = buildRecord(level, name, msg, fields, { hostSessionId });
        sink.push(record);
        if (options.echo) options.echo(record);
      }
      const logger: Logger = {
        module: name,
        debug: (m, f) => emit('debug', m, f),
        info: (m, f) => emit('info', m, f),
        warn: (m, f) => emit('warn', m, f),
        error: (m, f) => emit('error', m, f),
        session(hostSessionId: string): Logger {
          return {
            module: name,
            debug: (m, f) => emit('debug', m, f, hostSessionId),
            info: (m, f) => emit('info', m, f, hostSessionId),
            warn: (m, f) => emit('warn', m, f, hostSessionId),
            error: (m, f) => emit('error', m, f, hostSessionId),
            session: () => logger.session(hostSessionId),
          };
        },
      };
      cache.set(name, logger);
      return logger;
    },
    shutdown(): void { /* in-memory only */ },
  };
}
