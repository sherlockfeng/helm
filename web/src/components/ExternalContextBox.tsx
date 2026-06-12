/**
 * PR-β (knowledge tiers): org-side context rendered NEXT TO a captured
 * fragment — prefetched at capture time, so normally it's already here
 * when the page loads. Purely presentational; pages own the data.
 */

import { type ReactElement } from 'react';
import type { CandidateExternalContext } from '../api/types.js';

export function ExternalContextBox({
  context, refreshing, onRefresh,
}: {
  context: CandidateExternalContext | undefined;
  refreshing: boolean;
  onRefresh: () => void;
}): ReactElement {
  return (
    <div style={{
      marginTop: 6, padding: '8px 10px', borderRadius: 6,
      backgroundColor: '#f5f3ff', border: '1px solid #ddd6fe',
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#6d28d9', marginBottom: 4 }}>
        组织已有相关{context ? `（${context.providers.join(' · ')}）` : ''}
        <button
          onClick={onRefresh}
          disabled={refreshing}
          style={{ marginLeft: 8, fontSize: 11 }}
        >
          {refreshing ? '查询中…' : '重查'}
        </button>
      </div>
      {context
        ? (
          <pre style={{
            margin: 0, fontSize: 12, whiteSpace: 'pre-wrap',
            maxHeight: 200, overflow: 'auto',
          }}>{context.body}</pre>
        )
        : (
          <span className="muted" style={{ fontSize: 12 }}>
            {refreshing ? '正在查询外部知识源…' : '暂无外部上下文（预取未命中或知识源未配置）'}
          </span>
        )}
    </div>
  );
}
