import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalPolicyEngine } from '../../../src/approval/policy.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import { getApprovalPolicy } from '../../../src/storage/repos/approval.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

let db: BetterSqlite3.Database;
let engine: ApprovalPolicyEngine;

beforeEach(() => {
  db = openDb();
  engine = new ApprovalPolicyEngine(db);
});

afterEach(() => {
  db.close();
});

describe('ApprovalPolicyEngine.add / list / remove', () => {
  it('add stores the rule and returns it with id + hits=0', () => {
    const rule = engine.add({ tool: 'Shell', commandPrefix: 'pnpm', decision: 'allow' });
    expect(rule.id).toMatch(/^pol_/);
    expect(rule.hits).toBe(0);
    expect(rule.commandPrefix).toBe('pnpm');
    expect(engine.list()).toHaveLength(1);
  });

  it('attack: missing tool throws', () => {
    expect(() => engine.add({ tool: '', decision: 'allow' })).toThrow(/tool/);
  });

  it('attack: invalid decision throws', () => {
    expect(() => engine.add({ tool: 'Shell', decision: 'maybe' as 'allow' })).toThrow(/allow\|deny/);
  });

  it('remove drops the rule', () => {
    const rule = engine.add({ tool: 'Shell', commandPrefix: 'ls', decision: 'allow' });
    engine.remove(rule.id);
    expect(engine.list()).toHaveLength(0);
  });
});

describe('ApprovalPolicyEngine.match — basic matching', () => {
  it('returns null when no rule applies', () => {
    expect(engine.match({ tool: 'Shell', command: 'rm -rf /' })).toBeNull();
  });

  it('matches commandPrefix exactly', () => {
    engine.add({ tool: 'Shell', commandPrefix: 'pnpm', decision: 'allow' });
    const m = engine.match({ tool: 'Shell', command: 'pnpm install' });
    expect(m?.permission).toBe('allow');
  });

  it('does not match a different tool', () => {
    engine.add({ tool: 'Shell', commandPrefix: 'pnpm', decision: 'allow' });
    expect(engine.match({ tool: 'Bash', command: 'pnpm install' })).toBeNull();
  });

  it('mcp__ rule with toolScope matches any args', () => {
    engine.add({ tool: 'mcp__svc__do', toolScope: true, decision: 'allow' });
    const m = engine.match({ tool: 'mcp__svc__do', command: '{"x":1}' });
    expect(m?.permission).toBe('allow');
  });

  it('pathPrefix matches absolute path command', () => {
    engine.add({ tool: 'Write', pathPrefix: '/proj', decision: 'allow' });
    const m = engine.match({ tool: 'Write', command: '/proj/src/file.ts' });
    expect(m?.permission).toBe('allow');
  });

  it('pathPrefix matches via cwd when command is not an absolute path', () => {
    engine.add({ tool: 'Write', pathPrefix: '/proj', decision: 'allow' });
    const m = engine.match({ tool: 'Write', command: 'src/foo.ts', cwd: '/proj' });
    expect(m?.permission).toBe('allow');
  });

  it('pathPrefix does not match a parallel directory', () => {
    engine.add({ tool: 'Write', pathPrefix: '/proj', decision: 'allow' });
    const m = engine.match({ tool: 'Write', command: '/other/file.ts' });
    expect(m).toBeNull();
  });

  it('attack: empty commandPrefix only matches empty incoming command', () => {
    engine.add({ tool: 'Shell', commandPrefix: '', decision: 'allow' });
    expect(engine.match({ tool: 'Shell', command: 'something' })).toBeNull();
    expect(engine.match({ tool: 'Shell', command: '' })?.permission).toBe('allow');
    expect(engine.match({ tool: 'Shell', command: '   ' })?.permission).toBe('allow');
  });

  it('pathPrefix is normalized with trailing slash before matching', () => {
    engine.add({ tool: 'Write', pathPrefix: '/proj', decision: 'allow' });
    expect(engine.match({ tool: 'Write', command: '/projection/foo' })).toBeNull();
    expect(engine.match({ tool: 'Write', command: '/proj/foo' })?.permission).toBe('allow');
  });
});

describe('ApprovalPolicyEngine.match — ranking', () => {
  it('longest commandPrefix wins among multiple matches', () => {
    engine.add({ tool: 'Shell', commandPrefix: 'git', decision: 'deny' });
    engine.add({ tool: 'Shell', commandPrefix: 'git push', decision: 'allow' });
    const m = engine.match({ tool: 'Shell', command: 'git push origin main' });
    expect(m?.permission).toBe('allow');
    expect(m?.rule.commandPrefix).toBe('git push');
  });

  it('longest pathPrefix wins', () => {
    engine.add({ tool: 'Write', pathPrefix: '/proj', decision: 'deny' });
    engine.add({ tool: 'Write', pathPrefix: '/proj/src', decision: 'allow' });
    const m = engine.match({ tool: 'Write', command: '/proj/src/file.ts' });
    expect(m?.permission).toBe('allow');
  });

  it('toolScope rule beats prefix rule for same tool', () => {
    engine.add({ tool: 'mcp__svc__do', commandPrefix: '{"foo":"bar"}', decision: 'deny' });
    engine.add({ tool: 'mcp__svc__do', toolScope: true, decision: 'allow' });
    const m = engine.match({ tool: 'mcp__svc__do', command: '{"foo":"bar"}' });
    expect(m?.permission).toBe('allow');
  });
});

describe('ApprovalPolicyEngine.match — side effects', () => {
  it('increments hits on the matched rule', () => {
    const rule = engine.add({ tool: 'Shell', commandPrefix: 'ls', decision: 'allow' });
    engine.match({ tool: 'Shell', command: 'ls -la' });
    engine.match({ tool: 'Shell', command: 'ls' });
    expect(getApprovalPolicy(db, rule.id)?.hits).toBe(2);
  });

  it('does not increment hits on losing rule when multiple match', () => {
    const broad = engine.add({ tool: 'Shell', commandPrefix: 'git', decision: 'deny' });
    const narrow = engine.add({ tool: 'Shell', commandPrefix: 'git push', decision: 'allow' });
    engine.match({ tool: 'Shell', command: 'git push' });
    expect(getApprovalPolicy(db, narrow.id)?.hits).toBe(1);
    expect(getApprovalPolicy(db, broad.id)?.hits).toBe(0);
  });
});
