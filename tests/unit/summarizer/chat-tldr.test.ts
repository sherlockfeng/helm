import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { upsertHostSession, getHostSessionSummary } from '../../../src/storage/repos/host-sessions.js';
import { appendHostEvent } from '../../../src/storage/repos/host-event-log.js';
import {
  generateChatTldr,
  renderTurnsForPrompt,
  sanitizeSummary,
} from '../../../src/summarizer/chat-tldr.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
function seedSession(db: BetterSqlite3.Database, id = 's1'): void {
  const now = new Date().toISOString();
  upsertHostSession(db, { id, host: 'claude-code', status: 'active', firstSeenAt: now, lastSeenAt: now });
}

describe('sanitizeSummary', () => {
  it('keeps Purpose + Progress lines (English labels)', () => {
    const raw = 'Purpose: ship the rail redesign\nProgress: PR1 merged';
    expect(sanitizeSummary(raw)).toBe('Purpose: ship the rail redesign\nProgress: PR1 merged');
  });

  it('keeps 目的 + 进展 lines (Chinese labels)', () => {
    const raw = '目的: 修 packaging 问题\n进展: 已合 PR #131';
    expect(sanitizeSummary(raw)).toBe('目的: 修 packaging 问题\n进展: 已合 PR #131');
  });

  it('strips chat preamble and trailing commentary', () => {
    const raw = 'Here is the summary:\n\nPurpose: x\nProgress: y\n\nHope that helps!';
    expect(sanitizeSummary(raw)).toBe('Purpose: x\nProgress: y');
  });

  it('returns null when neither label is present', () => {
    expect(sanitizeSummary('I can\'t summarize this — the chat is empty.')).toBeNull();
  });

  it('accepts halfwidth or fullwidth colons', () => {
    expect(sanitizeSummary('Purpose：x\nProgress：y')).toBe('Purpose：x\nProgress：y');
  });
});

describe('renderTurnsForPrompt', () => {
  it('produces USER/AI block per turn in chronological order', () => {
    const t = renderTurnsForPrompt([
      { index: 2, userPrompt: { text: 'q2' }, assistantResponse: { text: 'a2' } },
      { index: 1, userPrompt: { text: 'q1' }, assistantResponse: { text: 'a1' } },
    ]);
    expect(t).toContain('USER: q1');
    expect(t).toContain('AI: a1');
    expect(t.indexOf('USER: q1')).toBeLessThan(t.indexOf('USER: q2'));
  });

  it('skips AI line when assistantResponse is missing (in-flight turn)', () => {
    const t = renderTurnsForPrompt([
      { index: 1, userPrompt: { text: 'q' } },
    ]);
    expect(t).toContain('USER: q');
    expect(t).not.toContain('AI:');
  });
});

describe('generateChatTldr (integration)', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seedSession(db); });
  afterEach(() => { db.close(); });

  it('writes the sanitized summary to host_sessions.summary on success', async () => {
    const now = new Date().toISOString();
    appendHostEvent(db, { hostSessionId: 's1', kind: 'prompt',   payload: { text: '修 packaging' }, createdAt: now });
    appendHostEvent(db, { hostSessionId: 's1', kind: 'response', payload: { text: '已合入' },        createdAt: now });

    const llm = { generate: vi.fn(async () => 'Purpose: ship X\nProgress: done\n') };
    const result = await generateChatTldr(db, 's1', { llm });
    expect(result).toBe('Purpose: ship X\nProgress: done');

    const stored = getHostSessionSummary(db, 's1');
    expect(stored?.summary).toBe('Purpose: ship X\nProgress: done');
    expect(stored?.generatedAt).toBeTruthy();
  });

  it('returns null when the chat has no turns yet — no LLM call, no write', async () => {
    const llm = { generate: vi.fn(async () => 'never called') };
    const result = await generateChatTldr(db, 's1', { llm });
    expect(result).toBeNull();
    expect(llm.generate).not.toHaveBeenCalled();
    expect(getHostSessionSummary(db, 's1')).toBeNull();
  });

  it('returns null when LLM throws — host row stays untouched', async () => {
    const now = new Date().toISOString();
    appendHostEvent(db, { hostSessionId: 's1', kind: 'prompt', payload: { text: 'q' }, createdAt: now });
    const llm = { generate: vi.fn(async () => { throw new Error('upstream down'); }) };
    expect(await generateChatTldr(db, 's1', { llm })).toBeNull();
    expect(getHostSessionSummary(db, 's1')).toBeNull();
  });

  it('returns null when the LLM output is unparseable — host row stays untouched', async () => {
    const now = new Date().toISOString();
    appendHostEvent(db, { hostSessionId: 's1', kind: 'prompt', payload: { text: 'q' }, createdAt: now });
    const llm = { generate: vi.fn(async () => 'sorry, I cannot help with that') };
    expect(await generateChatTldr(db, 's1', { llm })).toBeNull();
    expect(getHostSessionSummary(db, 's1')).toBeNull();
  });
});
