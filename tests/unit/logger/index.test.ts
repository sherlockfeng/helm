import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCapturingLoggerFactory,
  createLoggerFactory,
} from '../../../src/logger/index.js';

let rootDir: string;

beforeEach(() => { rootDir = mkdtempSync(join(tmpdir(), 'helm-log-')); });
afterEach(() => { rmSync(rootDir, { recursive: true, force: true }); });

function readJsonLines(path: string): Array<Record<string, unknown>> {
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((l) => JSON.parse(l));
}

describe('createLoggerFactory — file output', () => {
  it('writes module info to main.log as JSON Lines', () => {
    const factory = createLoggerFactory({ rootDir });
    factory.module('test').info('hello', { event: 'e1', data: { x: 1 } });
    const lines = readJsonLines(join(rootDir, 'main.log'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info', module: 'test', msg: 'hello', event: 'e1', data: { x: 1 },
    });
    expect(lines[0]?.['ts']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('error level lands in BOTH error.log and main.log', () => {
    const factory = createLoggerFactory({ rootDir });
    factory.module('test').error('oops', { event: 'failed' });

    const errLines = readJsonLines(join(rootDir, 'error.log'));
    const mainLines = readJsonLines(join(rootDir, 'main.log'));
    expect(errLines).toHaveLength(1);
    expect(mainLines).toHaveLength(1);
    expect(errLines[0]?.['level']).toBe('error');
  });

  it('debug below default minLevel is dropped', () => {
    const factory = createLoggerFactory({ rootDir });
    factory.module('test').debug('hidden');
    expect(existsSync(join(rootDir, 'main.log'))).toBe(false);
  });

  it('respects minLevel=debug option', () => {
    const factory = createLoggerFactory({ rootDir, minLevel: 'debug' });
    factory.module('test').debug('shown');
    const lines = readJsonLines(join(rootDir, 'main.log'));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['level']).toBe('debug');
  });

  it('redacts sensitive fields in data', () => {
    const factory = createLoggerFactory({ rootDir });
    factory.module('test').info('m', { data: { apiKey: 'sk-abcdefghij' } });
    const lines = readJsonLines(join(rootDir, 'main.log'));
    expect(lines[0]?.['data']).toEqual({ apiKey: 'sk-a***' });
  });
});

describe('Logger.session — per-session archive', () => {
  it('writes a copy to sessions/<id>.jsonl', () => {
    const factory = createLoggerFactory({ rootDir });
    factory.module('chan').session('abc').info('hi', { event: 'inbound' });

    const sessionLines = readJsonLines(join(rootDir, 'sessions', 'abc.jsonl'));
    expect(sessionLines).toHaveLength(1);
    expect(sessionLines[0]).toMatchObject({ module: 'chan', event: 'inbound', hostSessionId: 'abc' });

    const mainLines = readJsonLines(join(rootDir, 'main.log'));
    expect(mainLines[0]).toMatchObject({ hostSessionId: 'abc' });
  });

  it('different sessions go to different files', () => {
    const factory = createLoggerFactory({ rootDir });
    factory.module('m').session('A').info('a');
    factory.module('m').session('B').info('b');

    expect(readJsonLines(join(rootDir, 'sessions', 'A.jsonl'))).toHaveLength(1);
    expect(readJsonLines(join(rootDir, 'sessions', 'B.jsonl'))).toHaveLength(1);
  });

  it('module-level logging without session does NOT create session files', () => {
    const factory = createLoggerFactory({ rootDir });
    factory.module('m').info('hi');
    expect(existsSync(join(rootDir, 'sessions'))).toBe(false);
  });
});

describe('module reuse + echo', () => {
  it('module() returns same instance for same name', () => {
    const factory = createLoggerFactory({ rootDir });
    expect(factory.module('a')).toBe(factory.module('a'));
    expect(factory.module('a')).not.toBe(factory.module('b'));
  });

  it('echo callback fires for every record', () => {
    const seen: string[] = [];
    const factory = createLoggerFactory({ rootDir, echo: (r) => seen.push(r.msg) });
    factory.module('test').info('a');
    factory.module('test').error('b');
    expect(seen).toEqual(['a', 'b']);
  });
});

describe('attack: file IO failures do not throw', () => {
  it('onIoError fires when target dir is uncreateable; logger does not throw', () => {
    const errors: string[] = [];
    // Pass a path under a regular file to trigger ENOTDIR
    const blockerFile = join(rootDir, 'blocker');
    require('node:fs').writeFileSync(blockerFile, 'not a dir');
    const factory = createLoggerFactory({
      rootDir: blockerFile, // will fail to mkdir under a regular file
      onIoError: (err) => errors.push(err.message),
    });
    expect(() => factory.module('test').info('hi')).not.toThrow();
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('createCapturingLoggerFactory — in-memory test helper', () => {
  it('records to sink without touching disk', () => {
    const factory = createCapturingLoggerFactory();
    factory.module('m').info('hi', { data: { a: 1 } });
    factory.module('m').session('s1').warn('there', { event: 'e' });
    expect(factory.sink).toHaveLength(2);
    expect(factory.sink[1]?.hostSessionId).toBe('s1');
  });
});
