import { describe, expect, it } from 'vitest';
import { inferRuleScope, isPathBasedTool, isRiskyPreToolUse } from '../../../../src/host/cursor/scope.js';

describe('isRiskyPreToolUse', () => {
  it.each(['Shell', 'Bash', 'Write', 'Edit', 'Delete', 'ApplyPatch', 'MultiEdit', 'mcp__server__tool', 'MCP:server'])(
    '%s is risky',
    (name) => { expect(isRiskyPreToolUse(name)).toBe(true); },
  );

  it.each(['Read', 'Search', 'WebFetch', 'NotebookEdit', '', 'Grep'])(
    '%s is not risky',
    (name) => { expect(isRiskyPreToolUse(name)).toBe(false); },
  );

  it('attack: case-insensitive matching for Shell/Bash/etc', () => {
    expect(isRiskyPreToolUse('shell')).toBe(true);
    expect(isRiskyPreToolUse('SHELL')).toBe(true);
  });
});

describe('isPathBasedTool', () => {
  it('matches the canonical path-based tool names', () => {
    expect(isPathBasedTool('Write')).toBe(true);
    expect(isPathBasedTool('Edit')).toBe(true);
    expect(isPathBasedTool('Delete')).toBe(true);
    expect(isPathBasedTool('ApplyPatch')).toBe(true);
    expect(isPathBasedTool('MultiEdit')).toBe(true);
  });

  it('attack: case-sensitive (rejects "write")', () => {
    expect(isPathBasedTool('write')).toBe(false);
  });

  it('rejects shell-like and unknown tools', () => {
    expect(isPathBasedTool('Shell')).toBe(false);
    expect(isPathBasedTool('Read')).toBe(false);
    expect(isPathBasedTool('')).toBe(false);
  });
});

describe('inferRuleScope', () => {
  it('mcp__ tool → toolScope true, no command/path prefix', () => {
    expect(inferRuleScope({ tool: 'mcp__server__tool', command: 'whatever' }))
      .toEqual({ commandPrefix: '', pathPrefix: '', toolScope: true });
  });

  it('Shell with package manager → first token only', () => {
    expect(inferRuleScope({ tool: 'Shell', command: 'pnpm install' }))
      .toEqual({ commandPrefix: 'pnpm', pathPrefix: '' });
    expect(inferRuleScope({ tool: 'Bash', command: 'yarn run build' }))
      .toEqual({ commandPrefix: 'yarn', pathPrefix: '' });
  });

  it('Shell with non-pkg-manager command → first two tokens', () => {
    expect(inferRuleScope({ tool: 'Shell', command: 'git status' }))
      .toEqual({ commandPrefix: 'git status', pathPrefix: '' });
  });

  it('Shell with single token → that token only', () => {
    expect(inferRuleScope({ tool: 'Shell', command: 'ls' }))
      .toEqual({ commandPrefix: 'ls', pathPrefix: '' });
  });

  it('attack: empty command → empty prefixes', () => {
    expect(inferRuleScope({ tool: 'Shell', command: '' }))
      .toEqual({ commandPrefix: '', pathPrefix: '' });
    expect(inferRuleScope({ tool: 'Shell', command: '   ' }))
      .toEqual({ commandPrefix: '', pathPrefix: '' });
  });

  it('path-based tool with cwd fallback when command is not a path', () => {
    const result = inferRuleScope({ tool: 'Write', command: 'no-path-here', cwd: '/Users/me/proj' });
    expect(result.pathPrefix).toBe('/Users/me/proj/');
    expect(result.commandPrefix).toBe('');
  });

  it('path-based tool falls back to last branch when no cwd and no project marker', () => {
    const result = inferRuleScope({ tool: 'Write', command: 'relative.txt' });
    expect(result.pathPrefix).toBe('');
  });

  it('attack: undefined fields default cleanly', () => {
    expect(() => inferRuleScope({ tool: '' })).not.toThrow();
  });
});
