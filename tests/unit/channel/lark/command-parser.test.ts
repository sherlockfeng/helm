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

  // ── Phase 36: bind label extraction ───────────────────────────────────
  describe('Phase 36 bind label', () => {
    it('"@bot dr bind chat" → kind=bind, label="dr"', () => {
      expect(parseCommand({ text: '@bot dr bind chat', mentioned: true }))
        .toEqual({ kind: 'bind', label: 'dr' });
    });

    it('label can carry across the keyword: "@bot bind chat for #issue-7"', () => {
      expect(parseCommand({ text: '@bot bind chat for #issue-7', mentioned: true }))
        .toEqual({ kind: 'bind', label: 'for #issue-7' });
    });

    it('Chinese: "@bot 绑定对话 调试转发" → label="调试转发"', () => {
      expect(parseCommand({ text: '@bot 绑定对话 调试转发', mentioned: true }))
        .toEqual({ kind: 'bind', label: '调试转发' });
    });

    it('multiple @ mentions are stripped from the label', () => {
      expect(parseCommand({ text: '@bot @teammate dr bind chat', mentioned: true }))
        .toEqual({ kind: 'bind', label: 'dr' });
    });

    it('plain "@bot bind chat" with no extras → label undefined (no key in object)', () => {
      const r = parseCommand({ text: '@bot bind chat', mentioned: true });
      expect(r).toEqual({ kind: 'bind' });
      expect((r as { label?: string }).label).toBeUndefined();
    });

    it('attack: very long label is truncated at 80 chars with ellipsis', () => {
      const long = 'a'.repeat(200);
      const r = parseCommand({ text: `@bot ${long} bind chat`, mentioned: true }) as { kind: string; label?: string };
      expect(r.kind).toBe('bind');
      expect(r.label).toBeDefined();
      expect(r.label!.length).toBeLessThanOrEqual(80);
      expect(r.label!.endsWith('…')).toBe(true);
    });
  });
});

describe('parseCommand — Phase 64 consume (`bind <CODE>`)', () => {
  it('"@bot bind ABC123" → consume with uppercased code', () => {
    expect(parseCommand({ text: '@bot bind ABC123', mentioned: true }))
      .toEqual({ kind: 'consume', code: 'ABC123' });
  });

  it('lowercase code is normalized to uppercase (server stores upper)', () => {
    expect(parseCommand({ text: '@bot bind abc123', mentioned: true }))
      .toEqual({ kind: 'consume', code: 'ABC123' });
  });

  it('extra text around the keyword still matches (real user messages have noise)', () => {
    // Mirrors the real screenshot: "@chat with cursor disastery recover bind E410CA"
    expect(parseCommand({
      text: '@chat with cursor disastery recover bind E410CA',
      mentioned: true,
    })).toEqual({ kind: 'consume', code: 'E410CA' });
  });

  it('without @bot mention → unknown (lifecycle commands gate on mention)', () => {
    expect(parseCommand({ text: 'bind ABC123', mentioned: false }))
      .toEqual({ kind: 'unknown' });
  });

  it('attack: 5-char hex is too short → not a consume', () => {
    expect(parseCommand({ text: '@bot bind ABCDE', mentioned: true }))
      .toEqual({ kind: 'unknown' });
  });

  it('attack: non-hex letters in code → not a consume (rejects "@bot bind GHIJKL")', () => {
    expect(parseCommand({ text: '@bot bind GHIJKL', mentioned: true }))
      .toEqual({ kind: 'unknown' });
  });

  it('"unbind" is NOT mistaken for "bind <code>" (un* prefix matches first)', () => {
    expect(parseCommand({ text: '@bot unbind', mentioned: true }))
      .toEqual({ kind: 'unbind' });
    expect(parseCommand({ text: '@bot unbind ABC123', mentioned: true }))
      .toEqual({ kind: 'unbind' });
  });

  it('"bind chat" still works after the consume parser was added', () => {
    expect(parseCommand({ text: '@bot bind chat', mentioned: true }))
      .toEqual({ kind: 'bind' });
    expect(parseCommand({ text: '@bot bind chat tce-thread', mentioned: true }))
      .toMatchObject({ kind: 'bind', label: 'tce-thread' });
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
