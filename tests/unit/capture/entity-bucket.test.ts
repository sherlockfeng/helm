/**
 * Entity-bucket capture (knowledge tiers PR-α): unbound chats capture
 * fragments into entity-named namespace collections.
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  captureToEntityBuckets,
  entityBucketId,
} from '../../../src/capture/entity-bucket.js';
import { getRole, upsertRole, insertChunk, insertChunkEntity } from '../../../src/storage/repos/roles.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedSession(db: BetterSqlite3.Database, id: string): void {
  db.prepare(`
    INSERT INTO host_sessions (id, host, cwd, status, first_seen_at, last_seen_at)
    VALUES (?, 'cursor', '/tmp', 'active', ?, ?)
  `).run(id, new Date().toISOString(), new Date().toISOString());
}

// One paragraph (≥80 chars) mentioning DECC twice — the splitter keeps
// it as a single segment and the entity bar (2 mentions) passes.
const DECC_PARA =
  'DECC 的跨区数据通道申请流程踩过坑：先建 channel 再注册数据，DECC 的权限审批必须挂在通道而不是表上，否则会被打回。';

describe('captureToEntityBuckets', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seedSession(db, 'sess-1'); });
  afterEach(() => { db.close(); });

  it('creates a bucket collection + candidate for an unknown entity', () => {
    const result = captureToEntityBuckets({
      db, hostSessionId: 'sess-1', responseText: DECC_PARA,
    });
    expect(result.candidatesCreated).toBe(1);
    const cand = result.inserted[0]!;
    expect(cand.roleId).toBe('decc');
    expect(cand.scoreEntity).toBeGreaterThanOrEqual(2);
    expect(cand.scoreCosine).toBe(0);
    // Namespace collection materialized with the entity's display name.
    expect(getRole(db, 'decc')?.name).toBe('DECC');
  });

  it('skips entities some role already knows (they belong to that flow)', () => {
    upsertRole(db, {
      id: 'infra-expert', name: 'Infra', systemPrompt: 'p',
      isBuiltin: false, createdAt: new Date().toISOString(),
    });
    insertChunk(db, {
      id: 'c1', roleId: 'infra-expert', chunkText: 'DECC 通道知识',
      kind: 'other', createdAt: new Date().toISOString(),
    });
    insertChunkEntity(db, {
      chunkId: 'c1', roleId: 'infra-expert', entity: 'DECC',
      createdAt: new Date().toISOString(),
    });
    const result = captureToEntityBuckets({
      db, hostSessionId: 'sess-1', responseText: DECC_PARA,
    });
    expect(result.candidatesCreated).toBe(0);
    expect(getRole(db, 'decc')).toBeUndefined();
  });

  it('dedup: re-sweeping the same response inserts nothing new', () => {
    const first = captureToEntityBuckets({ db, hostSessionId: 'sess-1', responseText: DECC_PARA });
    const second = captureToEntityBuckets({ db, hostSessionId: 'sess-1', responseText: DECC_PARA });
    expect(first.candidatesCreated).toBe(1);
    expect(second.candidatesCreated).toBe(0);
  });

  it('2-char acronyms (OG) qualify at the stricter 3-mention bar', () => {
    const text =
      'OG 标签的接入要点：OG 数据要先在 DECC 注册才能打 OG 标签，schema 不匹配时回退 v4 的约定仍然有效，注意保留原字段。';
    const result = captureToEntityBuckets({ db, hostSessionId: 'sess-1', responseText: text });
    const buckets = result.byRole.map((r) => r.roleId);
    expect(buckets).toContain('og');
    expect(getRole(db, 'og')?.name).toBe('OG');

    // Two mentions only → below the 2-char bar, no bucket.
    const weak = 'OG 标签很重要，OG 数据注册流程后面再说，先把通道建好再讨论后续的审批和权限问题。';
    const r2 = captureToEntityBuckets({ db, hostSessionId: 'sess-1', responseText: weak });
    expect(r2.byRole.map((r) => r.roleId)).not.toContain('og');
  });

  it('caps buckets per response at maxBuckets, most-mentioned first', () => {
    const text =
      'BAM 接口元数据：BAM 的 IDL 检查里 BAM 规则最严。GECKO 资源走 GECKO 工单。NETLINK 域名配置在 NETLINK 平台。'
      + 'AEOLUS 数据集查询用 AEOLUS 模板即可，整体流程文档后补。';
    const result = captureToEntityBuckets({
      db, hostSessionId: 'sess-1', responseText: text, maxBuckets: 2,
    });
    expect(result.byRole.length).toBeLessThanOrEqual(2);
    expect(result.byRole[0]!.roleId).toBe('bam'); // 3 mentions beats 2
  });

  it('never clobbers an existing role with the same id', () => {
    upsertRole(db, {
      id: 'decc', name: 'DECC 专家', systemPrompt: 'trained prompt',
      isBuiltin: false, createdAt: '2026-01-01T00:00:00.000Z',
    });
    captureToEntityBuckets({ db, hostSessionId: 'sess-1', responseText: DECC_PARA });
    const role = getRole(db, 'decc');
    expect(role?.systemPrompt).toBe('trained prompt');
    expect(role?.name).toBe('DECC 专家');
  });

  it('empty / entity-free responses produce nothing', () => {
    const r = captureToEntityBuckets({
      db, hostSessionId: 'sess-1',
      responseText: '今天聊的内容都是日常琐事，没有任何值得沉淀的具体技术实体出现在这段话里面，纯粹的闲聊而已。',
    });
    expect(r.candidatesCreated).toBe(0);
    expect(r.byRole).toEqual([]);
  });
});

describe('entityBucketId', () => {
  it('kebab-cases and lowercases', () => {
    expect(entityBucketId('OG')).toBe('og');
    expect(entityBucketId('gatewayHandler')).toBe('gatewayhandler');
    expect(entityBucketId('qps.argos')).toBe('qps-argos');
  });
});
