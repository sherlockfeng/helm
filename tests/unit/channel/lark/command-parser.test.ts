import { describe, expect, it } from 'vitest';
import { buildHelpText, parseCommand } from '../../../../src/channel/lark/command-parser.js';

describe('parseCommand — approval', () => {
  it('plain /allow', () => {
    expect(parseCommand({ text: '/allow' })).toEqual({
      kind: 'approval', decision: 'allow', remember: false,
    });
  });

  it('plain /deny', () => {
    expect(parseCommand({ text: '/deny' })).toEqual({
      kind: 'approval', decision: 'deny', remember: false,
    });
  });

  it('/allow! sets remember=true (no scope)', () => {
    expect(parseCommand({ text: '/allow!' })).toEqual({
      kind: 'approval', decision: 'allow', remember: true,
    });
  });

  it('/allow with id selector → targetId', () => {
    expect(parseCommand({ text: '/allow apr_abc123' })).toEqual({
      kind: 'approval', decision: 'allow', remember: false, targetId: 'apr_abc123',
    });
  });

  it('/allow! with tool keyword → scope (lowercased)', () => {
    expect(parseCommand({ text: '/allow! Shell' })).toEqual({
      kind: 'approval', decision: 'allow', remember: true, scope: 'shell',
    });
  });

  it('/allow! pnpm install → scope = "pnpm install"', () => {
    expect(parseCommand({ text: '/allow! pnpm install' })).toEqual({
      kind: 'approval', decision: 'allow', remember: true, scope: 'pnpm install',
    });
  });

  it('/allow! mcp__server__tool → scope kept as-is', () => {
    expect(parseCommand({ text: '/allow! mcp__server__tool' })).toEqual({
      kind: 'approval', decision: 'allow', remember: true, scope: 'mcp__server__tool',
    });
  });

  it('cursor: prefix is stripped', () => {
    expect(parseCommand({ text: '/cursor: allow' })).toEqual({
      kind: 'approval', decision: 'allow', remember: false,
    });
    expect(parseCommand({ text: '/cursor allow!' })).toEqual({
      kind: 'approval', decision: 'allow', remember: true,
    });
  });

  it('case-insensitive', () => {
    expect(parseCommand({ text: '/ALLOW' }).kind).toBe('approval');
    expect((parseCommand({ text: '/Deny!' }) as { decision: string }).decision).toBe('deny');
  });

  it('attack: /allow inside a paragraph still matches if at line start', () => {
    expect(parseCommand({ text: 'lgtm /allow' })).toMatchObject({ kind: 'approval', decision: 'allow' });
  });

  it('attack: /allowxyz is not a command', () => {
    expect(parseCommand({ text: '/allowxyz' })).toEqual({ kind: 'unknown' });
  });

  it('attack: empty / whitespace string', () => {
    expect(parseCommand({ text: '' })).toEqual({ kind: 'unknown' });
    expect(parseCommand({ text: '   ' })).toEqual({ kind: 'unknown' });
  });
});

describe('parseCommand — lifecycle (require @bot mention)', () => {
  it('"bind chat" needs mention', () => {
    expect(parseCommand({ text: 'bind chat', mentioned: false })).toEqual({ kind: 'unknown' });
    expect(parseCommand({ text: '@bot bind chat', mentioned: true })).toEqual({ kind: 'bind' });
  });

  it('"unbind" / "un bind" / 解绑 with mention', () => {
    expect(parseCommand({ text: '@bot unbind', mentioned: true })).toEqual({ kind: 'unbind' });
    expect(parseCommand({ text: '@bot un bind chat', mentioned: true })).toEqual({ kind: 'unbind' });
    expect(parseCommand({ text: '@bot 解绑', mentioned: true })).toEqual({ kind: 'unbind' });
  });

  it('"stop wait" / "disable wait" / "pause wait" with mention', () => {
    expect(parseCommand({ text: '@bot stop wait', mentioned: true })).toEqual({ kind: 'disable_wait' });
    expect(parseCommand({ text: '@bot disable waiting', mentioned: true })).toEqual({ kind: 'disable_wait' });
    expect(parseCommand({ text: '@bot pause wait', mentioned: true })).toEqual({ kind: 'disable_wait' });
    expect(parseCommand({ text: '@bot 停止等待', mentioned: true })).toEqual({ kind: 'disable_wait' });
  });

  it('Chinese 绑定对话 alias', () => {
    expect(parseCommand({ text: '@bot 绑定对话', mentioned: true })).toEqual({ kind: 'bind' });
  });

  it('attack: lifecycle keywords without @bot are ignored', () => {
    expect(parseCommand({ text: 'bind chat please', mentioned: false }).kind).toBe('unknown');
    expect(parseCommand({ text: 'unbind it', mentioned: false }).kind).toBe('unknown');
  });
});

describe('parseCommand — help', () => {
  it('"/help" works without mention', () => {
    expect(parseCommand({ text: '/help' })).toEqual({ kind: 'help' });
  });

  it('"help" or "帮助" require mention', () => {
    expect(parseCommand({ text: 'help', mentioned: false })).toEqual({ kind: 'unknown' });
    expect(parseCommand({ text: '@bot help', mentioned: true })).toEqual({ kind: 'help' });
    expect(parseCommand({ text: '@bot 帮助', mentioned: true })).toEqual({ kind: 'help' });
  });
});

describe('buildHelpText', () => {
  it('contains the /allow examples that the help command advertises', () => {
    const text = buildHelpText();
    expect(text).toMatch(/\/allow/);
    expect(text).toMatch(/\/deny/);
    expect(text).toMatch(/bind chat/);
  });
});
