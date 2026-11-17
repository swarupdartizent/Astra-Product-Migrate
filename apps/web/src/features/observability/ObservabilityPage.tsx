import { useNavigate } from '@tanstack/react-router';
import { Activity, Waypoints } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useObservabilitySummary, useTraces } from '@/api/observability';
import { useTenants } from '@/api/tenancy';
import type { SummaryGroupBy, SummaryRow, TraceRow } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { RequirePermission } from '@/app/RequirePermission';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Card,
  CardBody,
  CardHeader,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Mono,
  PageHeader,
  SegmentedControl,
  StatusPill,
  Timestamp,
} from '@/ui';
import s from '../shared.module.css';
import { Bar } from './Bar';
import { barPercent, formatCost, formatDuration, GROUP_BY_OPTIONS } from './model';
import styles from './Observability.module.css';

const summaryCol = createDataTableColumns<SummaryRow>();
const traceCol = createDataTableColumns<TraceRow>();

function summaryColumns(
  groupLabel: string,
  maxTotal: number,
  keyLabel: (key: string | null) => string,
) {
  return summaryCol.columns([
    summaryCol.accessor((row) => keyLabel(row.key), {
      id: 'key',
      header: groupLabel,
      size: 240,
      cell: (info) =>
        info.row.original.key === null ? (
          <span className={s.muted}>Not set</span>
        ) : (
          <span>{info.getValue()}</span>
        ),
    }),
    summaryCol.accessor('spans', {
      header: 'Spans',
      size: 90,
      meta: { align: 'end' },
      cell: (info) => <span className={styles.num}>{info.getValue().toLocaleString()}</span>,
    }),
    summaryCol.accessor('errors', {
      header: 'Errors',
      size: 90,
      meta: { align: 'end' },
      cell: (info) => (
        <span className={`${styles.num} ${info.getValue() > 0 ? styles.errors : s.muted}`}>
          {info.getValue().toLocaleString()}
        </span>
      ),
    }),
    summaryCol.accessor('total_ms', {
      header: 'Total time',
      size: 260,
      cell: (info) => (
        <span className={styles.barCell}>
          <Bar percent={barPercent(info.getValue(), maxTotal)} />
          <span className={styles.num}>{formatDuration(info.getValue())}</span>
        </span>
      ),
    }),
    summaryCol.accessor('p95_ms', {
      header: 'p95',
      size: 100,
      meta: { align: 'end' },
      cell: (info) => <span className={styles.num}>{formatDuration(info.getValue())}</span>,
    }),
    summaryCol.accessor((row) => row.cost_usd ?? -1, {
      id: 'cost',
      header: 'Model cost',
      size: 120,
      meta: { align: 'end' },
      cell: (info) => <span className={styles.num}>{formatCost(info.row.original.cost_usd)}</span>,
    }),
  ]);
}

function traceColumns(tenantName: (id: string | null) => string | null) {
  return traceCol.columns([
    traceCol.accessor('name', {
      header: 'Trace',
      size: 280,
      cell: (info) => (
        <span className={s.cellStack}>
          <span className={s.cellPrimary}>{info.getValue()}</span>
          <Mono className={`${s.muted} ${s.xs}`}>{info.row.original.trace_id}</Mono>
        </span>
      ),
    }),
    traceCol.accessor('status', {
      header: 'Status',
      size: 100,
      cell: (info) => (
        <StatusPill tone={info.getValue() === 'error' ? 'danger' : 'success'}>
          {info.getValue() === 'error' ? 'Error' : 'OK'}
        </StatusPill>
      ),
    }),
    traceCol.accessor('started_at', {
      header: 'Started',
      size: 130,
      cell: (info) => <Timestamp value={info.getValue()} />,
    }),
    traceCol.accessor('duration_ms', {
      header: 'Duration',
      size: 110,
      meta: { align: 'end' },
      cell: (info) => <span className={styles.num}>{formatDuration(info.getValue())}</span>,
    }),
    traceCol.accessor('span_count', {
      header: 'Spans',
      size: 80,
      meta: { align: 'end' },
    }),
    traceCol.accessor((row) => tenantName(row.tenant_id) ?? '', {
      id: 'tenant',
      header: 'Tenant',
      size: 160,
      cell: (info) => {
        const id = info.row.original.tenant_id;
        if (!id) return <span className={s.muted}>Platform</span>;
        return tenantName(id) ?? <Mono className={s.muted}>{id.slice(0, 8)}…</Mono>;
      },
    }),
    traceCol.accessor((row) => row.cost_usd ?? -1, {
      id: 'cost',
      header: 'Model cost',
      size: 110,
      meta: { align: 'end' },
      cell: (info) => <span className={styles.num}>{formatCost(info.row.original.cost_usd)}</span>,
    }),
  ]);
}

export function ObservabilityPage() {
  return (
    <RequirePermission permission="observability:read">
      <ObservabilityView />
    </RequirePermission>
  );
}

type StatusFilter = 'all' | 'ok' | 'error';

function ObservabilityView() {
  useDocumentTitle('Observability');
  const navigate = useNavigate();
  const [groupBy, setGroupBy] = useState<SummaryGroupBy>('category');
  const [status, setStatus] = useState<StatusFilter>('all');
  const summary = useObservabilitySummary(groupBy);
  const traces = useTraces(status === 'all' ? null : status);
  const tenants = useTenants();

  const tenantMap = useMemo(
    () => new Map((tenants.data ?? []).map((t) => [t.id, t.name])),
    [tenants.data],
  );
  const tenantName = useMemo(
    () => (id: string | null) => (id ? (tenantMap.get(id) ?? null) : null),
    [tenantMap],
  );
  const groupLabel = GROUP_BY_OPTIONS.find((o) => o.value === groupBy)?.label ?? 'Group';
  const maxTotal = Math.max(0, ...(summary.data ?? []).map((r) => r.total_ms));
  const sColumns = useMemo(
    () =>
      summaryColumns(groupLabel, maxTotal, (key) =>
        key === null ? 'Not set' : groupBy === 'tenant' ? (tenantName(key) ?? key) : key,
      ),
    [groupLabel, maxTotal, groupBy, tenantName],
  );
  const tColumns = useMemo(() => traceColumns(tenantName), [tenantName]);
  const noCost = (summary.data ?? []).every((r) => r.cost_usd === null);

  return (
    <>
      <PageHeader
        title="Observability"
        description="Where time goes across the platform, from recorded trace spans. Model cost is attributed per span once agents call models."
      />
      <div className={s.stack}>
        <Card flush aria-labelledby="summary-title">
          <CardHeader
            titleId="summary-title"
            title="Time and errors"
            description={`Spans grouped by ${groupLabel.toLowerCase()}, slowest total first.`}
            actions={
              <SegmentedControl
                label="Group by"
                size="sm"
                options={GROUP_BY_OPTIONS}
                value={groupBy}
                onValueChange={setGroupBy}
              />
            }
          />
          <CardBody>
            {summary.isError ? (
              <ApiErrorView
                error={summary.error}
                title="Could not load the summary"
                onRetry={() => void summary.refetch()}
                retrying={summary.isFetching}
                compact
              />
            ) : (
              <DataTable
                label={`Span summary by ${groupLabel.toLowerCase()}`}
                data={summary.data}
                columns={sColumns}
                getRowId={(r) => r.key ?? '__null__'}
                loading={summary.isPending}
                empty={
                  <EmptyState
                    compact
                    icon={<Activity />}
                    title="No spans recorded"
                    body="Spans appear here as the platform handles requests and runs jobs."
                  />
                }
              />
            )}
          </CardBody>
          {summary.data && summary.data.length > 0 && noCost ? (
            <p className={s.footerNote}>
              Model cost shows “—” because no span has a cost yet. It appears once agents run and
              call models.
            </p>
          ) : null}
        </Card>

        <Card flush aria-labelledby="traces-title">
          <CardHeader
            titleId="traces-title"
            title="Recent traces"
            description="The 50 most recent root operations. Select one to see its spans."
            actions={
              <SegmentedControl
                label="Trace status"
                size="sm"
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'ok', label: 'OK' },
                  { value: 'error', label: 'Errors' },
                ]}
                value={status}
                onValueChange={setStatus}
              />
            }
          />
          <CardBody>
            {traces.isError ? (
              <ApiErrorView
                error={traces.error}
                title="Could not load traces"
                onRetry={() => void traces.refetch()}
                retrying={traces.isFetching}
                compact
              />
            ) : (
              <DataTable
                label="Recent traces"
                data={traces.data}
                columns={tColumns}
                getRowId={(t) => t.trace_id}
                loading={traces.isPending}
                onRowClick={(t) =>
                  void navigate({
                    to: '/observability/traces/$traceId',
                    params: { traceId: t.trace_id },
                  })
                }
                empty={
                  <EmptyState
                    compact
                    icon={<Waypoints />}
                    title={status === 'error' ? 'No failed traces' : 'No traces recorded'}
                  />
                }
              />
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
