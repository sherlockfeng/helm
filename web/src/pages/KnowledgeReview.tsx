/**
 * Knowledge › Review — PR 4 functional cut.
 *
 * Surfaces pending knowledge candidates extracted from chat captures.
 * Per design §5.3 / R-5:
 *   - sort by recent (default) OR score (entity×0.4 + cosine×0.6)
 *   - per-row Accept / Edit-and-Accept / Reject actions
 *   - bulk reject ONLY — bulk accept is intentionally absent so
 *     every promotion requires a fresh human decision
 *   - source-chat deep link to /conversations/:id when the candidate
 *     carries a hostSessionId
 *
 * The full Accept-edit modal + the "similar exists, append?" suggestion
 * land in PR 5; this is the lean cut that proves the end-to-end loop.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ApiError, helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';
import { CardSkeletonList } from '../components/Skeleton.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/Select.js';
import type { KnowledgeCandidate } from '../api/types.js';

type SortMode = 'recent' | 'score';

export function KnowledgeReviewPage() {
  const [sort, setSort] = useState<SortMode>('recent');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data, error, loading, reload } = useApi(
    () => helmApi.listReviewCandidates({ status: 'pending', sort, limit: 200 }),
    [sort],
  );

  // Clear stale selections whenever the list changes.
  useEffect(() => {
    if (!data) return;
    const live = new Set(data.candidates.map((c) => c.id));
    setSelected((prev) => new Set([...prev].filter((id) => live.has(id))));
  }, [data]);

  const candidates = useMemo(() => data?.candidates ?? [], [data]);
  const selectedCount = selected.size;

  if (error) {
    return (
      <div className="helm-page">
        <PageHeader title="Review" />
        <EmptyState
          title="Could not load review queue."
          hint={error instanceof Error ? error.message : String(error)}
        />
      </div>
    );
  }

  return (
    <div className="helm-page">
      <PageHeader
        title="Review"
        subtitle="Candidates extracted from your conversations, waiting for your judgement."
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Select value={sort} onValueChange={(v) => setSort(v as SortMode)}>
              <SelectTrigger aria-label="Sort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="recent">Recent first</SelectItem>
                <SelectItem value="score">Highest score</SelectItem>
              </SelectContent>
            </Select>
            {selectedCount > 0 && (
              <Button
                variant="danger"
                onClick={() => void doBulkReject([...selected], reload, setSelected)}
              >
                Reject selected ({selectedCount})
              </Button>
            )}
          </div>
        }
      />

      {loading && !data && <CardSkeletonList n={3} />}

      {!loading && candidates.length === 0 && (
        <EmptyState
          title="No candidates pending."
          hint={
            <>
              When an agent emits a passage worth keeping, it lands here. Bind
              a knowledge collection to a chat to start producing candidates.
            </>
          }
        />
      )}

      {candidates.map((c) => (
        <CandidateCard
          key={c.id}
          candidate={c}
          selected={selected.has(c.id)}
          onToggleSelected={(next) => {
            setSelected((prev) => {
              const out = new Set(prev);
              if (next) out.add(c.id); else out.delete(c.id);
              return out;
            });
          }}
          onAfterAction={reload}
        />
      ))}
    </div>
  );
}

async function doBulkReject(
  ids: string[],
  refresh: () => void,
  setSelected: (s: Set<string>) => void,
): Promise<void> {
  try {
    const r = await helmApi.bulkRejectCandidates(ids);
    toast.success(`Rejected ${r.flipped} candidate${r.flipped === 1 ? '' : 's'}.`);
    setSelected(new Set());
    refresh();
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : String(err);
    toast.error(`Bulk reject failed: ${msg}`);
  }
}

function CandidateCard({
  candidate,
  selected,
  onToggleSelected,
  onAfterAction,
}: {
  candidate: KnowledgeCandidate;
  selected: boolean;
  onToggleSelected: (next: boolean) => void;
  onAfterAction: () => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);

  const accept = async (): Promise<void> => {
    setBusy(true);
    try {
      await helmApi.acceptCandidate(candidate.id);
      toast.success('Accepted; chunk added to collection.');
      onAfterAction();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      toast.error(`Accept failed: ${msg}`);
    } finally { setBusy(false); }
  };

  const reject = async (): Promise<void> => {
    setBusy(true);
    try {
      await helmApi.rejectCandidate(candidate.id);
      toast.success('Rejected.');
      onAfterAction();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      toast.error(`Reject failed: ${msg}`);
    } finally { setBusy(false); }
  };

  return (
    <Card>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => onToggleSelected(e.target.checked)}
          aria-label={`Select candidate ${candidate.id}`}
          style={{ marginTop: 4 }}
        />
        <div style={{ flex: 1 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            Role: <strong>{candidate.roleId}</strong>
            {' · '}
            Kind: <code>{candidate.kind}</code>
            {' · '}
            Score: entity {candidate.scoreEntity?.toFixed(1) ?? '—'} ·
            cosine {candidate.scoreCosine?.toFixed(2) ?? '—'}
            {candidate.hostSessionId && (
              <>
                {' · '}
                <Link to={`/conversations/${candidate.hostSessionId}`}>
                  source chat ↗
                </Link>
              </>
            )}
          </div>
          <p style={{ whiteSpace: 'pre-wrap', margin: '8px 0' }}>{candidate.chunkText}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={accept} disabled={busy} variant="primary">Accept</Button>
            <Button onClick={reject} disabled={busy} variant="danger">Reject</Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
