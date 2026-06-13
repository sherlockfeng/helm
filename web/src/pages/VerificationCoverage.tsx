/**
 * Verification › Coverage — PR 7 functional cut.
 *
 * Cross-references roles against the confirmed cases that target them.
 * Roles with zero confirmed cases are flagged "uncovered"; the rest get
 * a case count + the most recent alignment seen across their cases.
 *
 * Per design §17.4: the cold-start solution for old roles is the §4.7
 * proposal flow + git-substrate seed — this surface just makes the
 * problem visible.
 */

import { useMemo, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { Card } from '../components/Card.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';
import { CardSkeletonList } from '../components/Skeleton.js';
import type { RoleSummary } from '../api/types.js';

interface RoleCoverageRow {
  role: RoleSummary;
  caseCount: number;
  proposedCount: number;
}

export function VerificationCoveragePage(): ReactElement {
  const rolesQuery = useApi(() => helmApi.roles(), []);
  const casesQuery = useApi(() => helmApi.listVerificationCases({ status: 'all', limit: 500 }), []);

  const rows = useMemo<RoleCoverageRow[]>(() => {
    const roles = rolesQuery.data?.roles ?? [];
    const cases = casesQuery.data?.cases ?? [];
    return roles
      .map((role) => ({
        role,
        caseCount: cases.filter((c) =>
          c.status === 'confirmed' && c.targetRoleIds.includes(role.id),
        ).length,
        proposedCount: cases.filter((c) =>
          c.status === 'proposed' && c.targetRoleIds.includes(role.id),
        ).length,
      }))
      .sort((a, b) => {
        if (a.caseCount === 0 && b.caseCount > 0) return -1;
        if (b.caseCount === 0 && a.caseCount > 0) return 1;
        return a.caseCount - b.caseCount;
      });
  }, [rolesQuery.data, casesQuery.data]);

  const uncovered = rows.filter((r) => r.caseCount === 0).length;
  const covered = rows.length - uncovered;

  const loading = rolesQuery.loading || casesQuery.loading;
  const error = rolesQuery.error ?? casesQuery.error;

  if (error) {
    return (
      <div className="helm-page">
        <PageHeader title="Verification coverage" />
        <EmptyState
          title="Could not load coverage."
          hint={error instanceof Error ? error.message : String(error)}
        />
      </div>
    );
  }

  return (
    <div className="helm-page">
      <PageHeader
        title="Verification coverage"
        subtitle={
          loading
            ? 'Loading…'
            : `${covered}/${rows.length} roles covered by at least one confirmed case; ${uncovered} uncovered.`
        }
      />

      {loading && !rolesQuery.data && <CardSkeletonList n={4} />}

      {!loading && rows.length === 0 && (
        <EmptyState
          title="No topics found."
          hint={<>Create one in <Link to="/knowledge/topics">Topics</Link>.</>}
        />
      )}

      {rows.map((row) => (
        <CoverageCard key={row.role.id} row={row} />
      ))}
    </div>
  );
}

function CoverageCard({ row }: { row: RoleCoverageRow }): ReactElement {
  const isUncovered = row.caseCount === 0;
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <strong>{row.role.name}</strong>
          <div className="muted" style={{ fontSize: 12 }}>{row.role.id}</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 13 }}>
          {isUncovered
            ? <span style={{ color: '#dc2626' }}>⚠ no cases</span>
            : <span style={{ color: '#16a34a' }}>{row.caseCount} confirmed case{row.caseCount === 1 ? '' : 's'}</span>}
          {row.proposedCount > 0 && (
            <div style={{ color: '#d97706' }}>{row.proposedCount} proposed</div>
          )}
        </div>
      </div>
    </Card>
  );
}
