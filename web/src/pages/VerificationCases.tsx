/**
 * Verification › Cases — PR 7 functional cut.
 *
 * Per design §5.7 wireframe.
 * Surfaces benchmark cases by status (confirmed default; proposed for the
 * §4.7 review queue; all for audit). One inline form to add a manual case.
 *
 * The page-level Run button is intentionally absent: PR 5 left the run
 * endpoint behind an LLM provider config that ships in a follow-up. When
 * that lands, the per-row "Run" button gets wired without a layout change.
 */

import { useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ApiError, helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';
import { CardSkeletonList } from '../components/Skeleton.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/Select.js';
import type { BenchmarkCase, BenchmarkCaseStatus } from '../api/types.js';

type StatusFilter = BenchmarkCaseStatus | 'all';

export function VerificationCasesPage(): ReactElement {
  const [status, setStatus] = useState<StatusFilter>('confirmed');
  const [showNew, setShowNew] = useState(false);
  const [busyBulk, setBusyBulk] = useState(false);

  const { data, error, loading, reload } = useApi(
    () => helmApi.listVerificationCases({ status, limit: 200 }),
    [status],
  );

  const cases = useMemo(() => data?.cases ?? [], [data]);

  // 为所有 topic 生成 case：one LLM pass per non-builtin topic with chunks.
  const backfill = async (): Promise<void> => {
    setBusyBulk(true);
    try {
      const { results } = await helmApi.backfillCases();
      const total = results.reduce((n, r) => n + r.proposed, 0);
      toast.success(`已为 ${results.length} 个 topic 生成 ${total} 条 case`);
      setStatus('proposed');
      reload();
    } catch (err) {
      toast.error(`生成失败：${err instanceof ApiError ? err.message : String(err)}`);
    } finally { setBusyBulk(false); }
  };

  // 全部确认：confirm every proposed case + materialize files.
  const confirmAll = async (): Promise<void> => {
    setBusyBulk(true);
    try {
      const { confirmed, filesWritten } = await helmApi.confirmCasesBatch({ all: true });
      toast.success(`已确认 ${confirmed}（落 ${filesWritten} 个文件）`);
      reload();
    } catch (err) {
      toast.error(`确认失败：${err instanceof ApiError ? err.message : String(err)}`);
    } finally { setBusyBulk(false); }
  };

  return (
    <div className="helm-page">
      <PageHeader
        title="Verification cases"
        subtitle="Knowledge probes the agent should pass. Each case pins a question + expected truth + golden points."
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
              <SelectTrigger aria-label="Status filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="confirmed">Confirmed</SelectItem>
                <SelectItem value="proposed">Proposed (R-5)</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={backfill} disabled={busyBulk}>
              为所有 topic 生成 case
            </Button>
            {status === 'proposed' && cases.length > 0 && (
              <Button onClick={confirmAll} disabled={busyBulk} variant="primary">
                全部确认
              </Button>
            )}
            <Button onClick={() => setShowNew((p) => !p)}>
              {showNew ? 'Hide form' : '+ New case'}
            </Button>
          </div>
        }
      />

      {showNew && (
        <NewCaseForm
          onCreated={() => { setShowNew(false); reload(); }}
        />
      )}

      {loading && !data && <CardSkeletonList n={3} />}

      {error && (
        <EmptyState
          title="Could not load cases."
          hint={error instanceof Error ? error.message : String(error)}
        />
      )}

      {!loading && !error && cases.length === 0 && (
        <EmptyState
          title={
            status === 'proposed'
              ? 'No proposed cases pending.'
              : status === 'confirmed'
              ? 'No confirmed cases yet.'
              : 'No cases match this filter.'
          }
          hint={
            status === 'confirmed'
              ? <>Create one with <strong>+ New case</strong>, or accept knowledge in Review to trigger LLM-on-edit proposals.</>
              : undefined
          }
        />
      )}

      {cases.map((c) => (
        <CaseRow key={c.id} c={c} onActed={reload} />
      ))}
    </div>
  );
}

function CaseRow({ c, onActed }: { c: BenchmarkCase; onActed: () => void }): ReactElement {
  const [busy, setBusy] = useState(false);

  const confirm = async (): Promise<void> => {
    setBusy(true);
    try {
      await helmApi.confirmVerificationCase(c.id);
      toast.success('Confirmed.');
      onActed();
    } catch (err) {
      toast.error(`Confirm failed: ${err instanceof ApiError ? err.message : String(err)}`);
    } finally { setBusy(false); }
  };

  const reject = async (): Promise<void> => {
    setBusy(true);
    try {
      await helmApi.rejectVerificationCase(c.id);
      toast.success('Rejected.');
      onActed();
    } catch (err) {
      toast.error(`Reject failed: ${err instanceof ApiError ? err.message : String(err)}`);
    } finally { setBusy(false); }
  };

  const runNow = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await helmApi.runVerificationCase(c.id);
      toast.success(`Ran: ${r.run.alignmentPct.toFixed(1)}% alignment, ${r.run.recallPct.toFixed(1)}% recall.`);
      onActed();
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        toast.error(
          'No verification runner configured. Create '
          + '~/.helm/benchmark/providers.json and restart helm.',
        );
      } else {
        toast.error(`Run failed: ${err instanceof ApiError ? err.message : String(err)}`);
      }
    } finally { setBusy(false); }
  };

  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <strong>{c.name}</strong>
          <div className="muted" style={{ fontSize: 12 }}>
            <StatusBadge status={c.status} />
            {' · '}
            <code>{c.proposedSource}</code>
            {' · '}
            <Link to={`/verification/cases/${c.id}/runs`}>view runs ↗</Link>
          </div>
        </div>
        <div style={{ fontSize: 13 }}>
          <em>Q:</em> {c.question}
        </div>
        <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>
          <em>Expected:</em> {c.expectedTruth}
        </div>
        {c.goldenPointIds.length > 0 && (
          <div className="muted" style={{ fontSize: 12 }}>
            golden: {c.goldenPointIds.join(', ')}
          </div>
        )}
        {c.targetRoleIds.length > 0 && (
          <div className="muted" style={{ fontSize: 12 }}>
            roles: {c.targetRoleIds.join(', ')}
          </div>
        )}
        {c.status === 'proposed' && (
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <Button onClick={confirm} disabled={busy} variant="primary">Confirm</Button>
            <Button onClick={reject} disabled={busy} variant="danger">Reject</Button>
          </div>
        )}
        {c.status === 'confirmed' && (
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <Button onClick={runNow} disabled={busy} variant="primary">Run now</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function StatusBadge({ status }: { status: BenchmarkCaseStatus }): ReactElement {
  const styleByStatus: Record<BenchmarkCaseStatus, { bg: string; fg: string }> = {
    proposed:  { bg: '#fef3c7', fg: '#92400e' },
    confirmed: { bg: '#dcfce7', fg: '#166534' },
    rejected:  { bg: '#fee2e2', fg: '#991b1b' },
    archived:  { bg: '#e5e7eb', fg: '#374151' },
  };
  const s = styleByStatus[status];
  return (
    <span style={{
      backgroundColor: s.bg, color: s.fg,
      padding: '1px 6px', borderRadius: 4,
      fontSize: 11, textTransform: 'uppercase', fontWeight: 600,
    }}>{status}</span>
  );
}

function NewCaseForm({ onCreated }: { onCreated: () => void }): ReactElement {
  const [name, setName] = useState('');
  const [question, setQuestion] = useState('');
  const [expectedTruth, setExpectedTruth] = useState('');
  const [goldenRaw, setGoldenRaw] = useState('');
  const [rolesRaw, setRolesRaw] = useState('');
  const [busy, setBusy] = useState(false);
  // R-20 — pull the existing role list so the form can suggest them
  // via a <datalist> instead of asking the user to type ids cold.
  // Same trick for golden points: we surface a flat list of every
  // chunk id the renderer can see, scoped to the loaded roles.
  const rolesQuery = useApi(() => helmApi.roles(), []);
  const roleSummaries = rolesQuery.data?.roles ?? [];

  const submit = async (): Promise<void> => {
    if (!name.trim() || !question.trim() || !expectedTruth.trim()) {
      toast.error('Name, question, and expected truth are required.');
      return;
    }
    setBusy(true);
    try {
      const goldenPointIds = splitCsv(goldenRaw);
      const targetRoleIds = splitCsv(rolesRaw);
      await helmApi.createVerificationCase({
        name, question, expectedTruth,
        ...(goldenPointIds.length ? { goldenPointIds } : {}),
        ...(targetRoleIds.length ? { targetRoleIds } : {}),
      });
      toast.success('Case created.');
      setName(''); setQuestion(''); setExpectedTruth(''); setGoldenRaw(''); setRolesRaw('');
      onCreated();
    } catch (err) {
      toast.error(`Create failed: ${err instanceof ApiError ? err.message : String(err)}`);
    } finally { setBusy(false); }
  };

  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>New manual case</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label>Name
          <input value={name} onChange={(e) => setName(e.target.value)}
            placeholder="dr-my-dc-failure" style={{ width: '100%' }} />
        </label>
        <label>Question
          <input value={question} onChange={(e) => setQuestion(e.target.value)}
            placeholder="MY DC fails: how to switch?" style={{ width: '100%' }} />
        </label>
        <label>Expected truth
          <textarea value={expectedTruth} onChange={(e) => setExpectedTruth(e.target.value)}
            placeholder="MY is in SG region; failover to SG1 via internal BFC..."
            rows={4} style={{ width: '100%' }} />
        </label>
        <label>Golden point ids (comma-separated, optional)
          <input value={goldenRaw} onChange={(e) => setGoldenRaw(e.target.value)}
            placeholder="dr-overview, bfc" style={{ width: '100%' }}
            list="helm-known-points" />
        </label>
        <label>Target topic ids (comma-separated, optional)
          <input value={rolesRaw} onChange={(e) => setRolesRaw(e.target.value)}
            placeholder="tiktok-web-dr" style={{ width: '100%' }}
            list="helm-known-roles" />
        </label>
        {/* R-20: datalist suggestions so users don't have to remember
            role / point ids verbatim. Empty list when the API hasn't
            returned yet — datalist is a hint, never load-bearing. */}
        <datalist id="helm-known-roles">
          {roleSummaries.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </datalist>
        <div>
          <Button onClick={submit} disabled={busy} variant="primary">Create</Button>
        </div>
      </div>
    </Card>
  );
}

function splitCsv(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}
