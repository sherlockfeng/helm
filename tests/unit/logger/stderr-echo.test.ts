import { describe, expect, it } from 'vitest';
import { createStderrEcho, resolveStderrEchoLevel } from '../../../src/logger/stderr-echo.js';
import type { LogRecord } from '../../../src/logger/index.js';

interface FakeStream {
  isTTY?: boolean;
  lines: string[];
  write(s: string): void;
}

function makeStream(opts: { isTTY?: boolean } = {}): FakeStream {
  const lines: string[] = [];
  return {
    ...(opts.isTTY !== undefined ? { isTTY: opts.isTTY } : {}),
    lines,
    write(s: string) { lines.push(s); },
  };
}

function makeRecord(over: Partial<LogRecord> = {}): LogRecord {
  return {
    ts: '2026-05-06T10:30:45.678Z',
    level: 'warn',
    module: 'approval.registry',
    msg: 'pending_timeout',
    ...over,
  };
}

describe('resolveStderrEchoLevel', () => {
  it('defaults to warn', () => {
    expect(resolveStderrEchoLevel({})).toBe('warn');
  });

  it('HELM_DEV=1 bumps default to info', () => {
    expect(resolveStderrEchoLevel({ HELM_DEV: '1' })).toBe('info');
  });

  it('HELM_LOG_ECHO_LEVEL wins over HELM_DEV', () => {
    expect(resolveStderrEchoLevel({ HELM_DEV: '1', HELM_LOG_ECHO_LEVEL: 'error' })).toBe('error');
    expect(resolveStderrEchoLevel({ HELM_DEV: '1', HELM_LOG_ECHO_LEVEL: 'off' })).toBe('off');
  });

  it('case-insensitive parse + whitespace tolerance', () => {
    expect(resolveStderrEchoLevel({ HELM_LOG_ECHO_LEVEL: ' INFO ' })).toBe('info');
    expect(resolveStderrEchoLevel({ HELM_LOG_ECHO_LEVEL: 'Debug' })).toBe('debug');
  });

  it('attack: invalid override falls back to default — never throws at boot', () => {
    expect(resolveStderrEchoLevel({ HELM_LOG_ECHO_LEVEL: 'verbose' })).toBe('warn');
    expect(resolveStderrEchoLevel({ HELM_LOG_ECHO_LEVEL: '' })).toBe('warn');
    expect(resolveStderrEchoLevel({ HELM_DEV: '1', HELM_LOG_ECHO_LEVEL: 'nope' })).toBe('info');
  });
});

describe('createStderrEcho', () => {
  it("returns null for level='off' so caller can skip wiring", () => {
    expect(createStderrEcho({ level: 'off' })).toBeNull();
  });

  it('writes warn record to stream with module + msg + time component', () => {
    const stream = makeStream();
    const echo = createStderrEcho({ level: 'warn', stream })!;
    echo(makeRecord());
    expect(stream.lines).toHaveLength(1);
    const line = stream.lines[0]!;
    expect(line).toContain('WARN');
    expect(line).toContain('approval.registry');
    expect(line).toContain('pending_timeout');
    expect(line).toContain('10:30:45.678');
    // Trailing newline
    expect(line.endsWith('\n')).toBe(true);
  });

  it('drops records below threshold', () => {
    const stream = makeStream();
    const echo = createStderrEcho({ level: 'warn', stream })!;
    echo(makeRecord({ level: 'debug' }));
    echo(makeRecord({ level: 'info' }));
    expect(stream.lines).toHaveLength(0);
    echo(makeRecord({ level: 'warn' }));
    echo(makeRecord({ level: 'error' }));
    expect(stream.lines).toHaveLength(2);
  });

  it('threshold debug emits everything', () => {
    const stream = makeStream();
    const echo = createStderrEcho({ level: 'debug', stream })!;
    (['debug', 'info', 'warn', 'error'] as const).forEach((level) => echo(makeRecord({ level })));
    expect(stream.lines).toHaveLength(4);
  });

  it('serializes hostSessionId / event / data tail when present', () => {
    const stream = makeStream();
    const echo = createStderrEcho({ level: 'info', stream })!;
    echo(makeRecord({
      level: 'info',
      hostSessionId: 'sess-1',
      event: 'session_start',
      data: { cwd: '/proj' },
    }));
    const line = stream.lines[0]!;
    expect(line).toContain('session=sess-1');
    expect(line).toContain('event=session_start');
    expect(line).toContain('data={"cwd":"/proj"}');
  });

  it('includes ANSI codes when isTTY=true (auto-detect via stream)', () => {
    const stream = makeStream({ isTTY: true });
    const echo = createStderrEcho({ level: 'warn', stream })!;
    echo(makeRecord({ level: 'error' }));
    const line = stream.lines[0]!;
    // Red opening sequence + reset
    expect(line).toContain('\x1b[31m');
    expect(line).toContain('\x1b[0m');
  });

  it('skips ANSI when isTTY is undefined (e.g. piped output) — clean for grep', () => {
    const stream = makeStream();
    const echo = createStderrEcho({ level: 'warn', stream })!;
    echo(makeRecord({ level: 'error' }));
    expect(stream.lines[0]).not.toContain('\x1b[');
  });

  it('explicit color=true forces ANSI even when isTTY=false', () => {
    const stream = makeStream({ isTTY: false });
    const echo = createStderrEcho({ level: 'warn', stream, color: true })!;
    echo(makeRecord({ level: 'warn' }));
    expect(stream.lines[0]).toContain('\x1b[33m');
  });

  it('explicit color=false suppresses ANSI even when isTTY=true', () => {
    const stream = makeStream({ isTTY: true });
    const echo = createStderrEcho({ level: 'warn', stream, color: false })!;
    echo(makeRecord({ level: 'error' }));
    expect(stream.lines[0]).not.toContain('\x1b[');
  });

  it('attack: stream.write throwing must not propagate (logger never breaks app)', () => {
    const stream: FakeStream = {
      lines: [],
      write() { throw new Error('stderr is gone'); },
    };
    const echo = createStderrEcho({ level: 'warn', stream })!;
    expect(() => echo(makeRecord({ level: 'error' }))).not.toThrow();
  });

  it('attack: unserializable data falls back to placeholder, no crash', () => {
    const stream = makeStream();
    const echo = createStderrEcho({ level: 'info', stream })!;
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    echo(makeRecord({ level: 'info', data: cyclic }));
    expect(stream.lines[0]).toContain('data=<unserializable>');
  });

  it('integrates with createLoggerFactory.echo: warns surface in stream end-to-end', async () => {
    const { createCapturingLoggerFactory } = await import('../../../src/logger/index.js');
    const stream = makeStream();
    const echo = createStderrEcho({ level: 'warn', stream })!;
    const factory = createCapturingLoggerFactory({ echo });
    factory.module('approval.registry').info('booted'); // dropped
    factory.module('approval.registry').warn('timeout', { data: { id: 'x' } });
    expect(stream.lines).toHaveLength(1);
    expect(stream.lines[0]).toContain('timeout');
    expect(stream.lines[0]).toContain('data={"id":"x"}');
  });
});
