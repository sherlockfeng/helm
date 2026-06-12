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
  isBucketableEntity,
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

// One paragraph (>=80 chars after trim — splitter default minimum)
// mentioning DECC twice; stays one segment and passes the 2-mention bar.
const DECC_PARA =
  'DECC 的跨区数据通道申请流程踩过坑：必须先建 channel 再注册数据表，顺序反了会被审批系统直接打回；'
  + '另外 DECC 的权限审批必须挂在通道维度而不是单表维度，挂错维度的工单会停在初审环节没有任何提示，'
  + '这个坑排查了一个下午才发现，记录下来避免后续接入的同学重复踩。';

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
    // Namespace collection materialized with the entity's display name —
    // as a Collection, not a bindable Expert (PR-δ).
    expect(getRole(db, 'decc')?.name).toBe('DECC');
    expect(getRole(db, 'decc')?.bindable).toBe(false);
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
      'OG 标签的接入要点整理：OG 数据必须先完成注册流程才能打 OG 标签，这一步没有任何界面提示，全靠口口相传；'
      + 'schema 不匹配的场景下回退 v4 的老约定仍然有效，迁移期间注意保留原始字段不要删，否则回退路径会直接断掉。';
    const result = captureToEntityBuckets({ db, hostSessionId: 'sess-1', responseText: text });
    const buckets = result.byRole.map((r) => r.roleId);
    expect(buckets).toContain('og');
    expect(getRole(db, 'og')?.name).toBe('OG');

    // Two mentions only → below the 2-char bar, no bucket.
    const weak =
      'OG 标签的事情确实很重要，OG 数据的注册流程我们后面再展开细说，今天先把基础通道建好，'
      + '审批和权限的部分等流程文档补齐之后再来逐项讨论，避免现在拍脑袋定下来后面又要返工。';
    const r2 = captureToEntityBuckets({ db, hostSessionId: 'sess-1', responseText: weak });
    expect(r2.byRole.map((r) => r.roleId)).not.toContain('og');
  });

  it('caps buckets per response at maxBuckets, most-mentioned first', () => {
    const text =
      'BAM 接口元数据的几个要点：BAM 的 IDL 检查里 BAM 的命名规则是最严格的，提交前先在本地把字段过一遍。\n\n'
      + 'GECKO 资源的发布必须走 GECKO 工单流程，直接改线上包会被回滚；NETLINK 的域名配置统一在 NETLINK 平台操作，'
      + 'AEOLUS 数据集的查询直接套用 AEOLUS 已保存的模板即可，整体的流程文档我们后面统一补齐归档。';
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
      responseText:
        '今天聊的内容基本都是日常琐事和无关紧要的进展同步，没有任何值得沉淀的具体技术实体出现在这一大段话里，'
        + '纯粹的闲聊而已，按设计这类回复不应该产生任何候选条目，也不应该创建任何新的命名空间集合。',
    });
    expect(r.candidatesCreated).toBe(0);
    expect(r.byRole).toEqual([]);
  });
});

describe('isBucketableEntity (降噪)', () => {
  it('rejects artifact-shaped tokens; keeps topic-shaped ones', () => {
    // Artifacts: hosts, path/file segments, PR/issue ids, plain words.
    expect(isBucketableEntity('github.com')).toBe(false);
    expect(isBucketableEntity('heyunfeng.feng')).toBe(false);
    expect(isBucketableEntity('165')).toBe(false);
    expect(isBucketableEntity('github')).toBe(false);
    // Topics: acronyms + camelCase identifiers.
    expect(isBucketableEntity('DECC')).toBe(true);
    expect(isBucketableEntity('OG')).toBe(true);
    expect(isBucketableEntity('gatewayHandler')).toBe(true);
  });
});

describe('captureToEntityBuckets — 降噪回归', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seedSession(db, 's1'); });
  afterEach(() => { db.close(); });

  it('URL hosts / path ids never create buckets (the github/165 junk)', () => {
    const text =
      '相关讨论都在 https://github.com/org/repo/pull/165 这条 PR 里，'
      + '另一个参考是 https://github.com/org/repo/pull/165 的评论区，'
      + '路径在 chat-captured/heyunfeng.feng/og/ 下面，注意保留原始目录结构不要随意移动。';
    const r = captureToEntityBuckets({ db, hostSessionId: 's1', responseText: text });
    const buckets = r.byRole.map((b) => b.roleId);
    expect(buckets.some((b) => b.includes('github'))).toBe(false);
    expect(buckets.some((b) => b.includes('165'))).toBe(false);
    expect(buckets.some((b) => b.includes('heyunfeng'))).toBe(false);
  });

  it('2-char dev-chat noise (AI/TL/DR) stays stopped at any frequency', () => {
    const text =
      'AI 的事情 AI 再说，AI 模型选型继续观望；TL 的反馈 TL 已经同步，TL 那边没有新意见；'
      + 'DR 演练 DR 计划 DR 复盘都排到下个季度了，今天先把手头的发布流程走完再说。';
    const r = captureToEntityBuckets({ db, hostSessionId: 's1', responseText: text });
    expect(r.byRole).toEqual([]);
  });

  it('known-entity check is case-insensitive', () => {
    upsertRole(db, {
      id: 'infra', name: 'Infra', systemPrompt: 'p',
      isBuiltin: false, createdAt: new Date().toISOString(),
    });
    insertChunk(db, {
      id: 'c-low', roleId: 'infra', chunkText: 'decc 知识',
      kind: 'other', createdAt: new Date().toISOString(),
    });
    insertChunkEntity(db, {
      chunkId: 'c-low', roleId: 'infra', entity: 'decc',
      createdAt: new Date().toISOString(),
    });
    const r = captureToEntityBuckets({ db, hostSessionId: 's1', responseText: DECC_PARA });
    expect(r.candidatesCreated).toBe(0);
  });
});

describe('entityBucketId', () => {
  it('kebab-cases and lowercases', () => {
    expect(entityBucketId('OG')).toBe('og');
    expect(entityBucketId('gatewayHandler')).toBe('gatewayhandler');
    expect(entityBucketId('qps.argos')).toBe('qps-argos');
  });
});
