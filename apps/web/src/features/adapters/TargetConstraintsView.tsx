import { useMemo } from 'react';
import { useTargetConstraints } from '@/api/adapters';
import type { TargetConstraint } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import {
  Badge,
  Callout,
  Card,
  CardBody,
  CardHeader,
  createDataTableColumns,
  DataTable,
  KeyValueList,
  Mono,
  Skeleton,
  StatusPill,
} from '@/ui';
import s from '../shared.module.css';
import { confidence, loadBlockedReason } from './model';
import { UnvalidatedBadge } from './UnvalidatedBadge';

const wrap = { whiteSpace: 'normal' } as const;

export function TargetConstraintsView({ name, version }: { name: string; version: string }) {
  const data = useTargetConstraints(name, version);
  const columns = useMemo(() => {
    const col = createDataTableColumns<TargetConstraint>();
    return col.columns([
      col.accessor('title', {
        header: 'Constraint',
        size: 300,
        cell: (info) => (
          <span className={s.cellStack} style={wrap}>
            <span className={s.cellPrimary}>{info.getValue()}</span>
            <span className={s.small}>{info.row.original.statement}</span>
            <span className={`${s.muted} ${s.xs}`}>
              Becomes rule <Mono>{info.row.original.rule_id}</Mono>
            </span>
          </span>
        ),
      }),
      col.accessor('kind', {
        header: 'Kind',
        size: 130,
        cell: (info) => <Badge>{info.getValue().replace(/_/g, ' ')}</Badge>,
      }),
      col.accessor((c) => c.applies_to.join(', '), {
        id: 'applies',
        header: 'Applies to',
        size: 170,
        cell: (info) => <span style={wrap}>{info.getValue() || '—'}</span>,
      }),
      col.accessor('confidence', {
        header: 'Confidence',
        size: 130,
        cell: (info) => {
          const c = confidence(info.getValue());
          return (
            <span className={s.cellStack} style={wrap}>
              <StatusPill tone={c.tone}>{c.label}</StatusPill>
              <span className={`${s.muted} ${s.xs}`}>{c.meaning}</span>
            </span>
          );
        },
      }),
      col.display({
        id: 'source',
        header: 'Source',
        size: 220,
        cell: (info) => {
          const c = info.row.original;
          return (
            <span className={s.cellStack} style={wrap}>
              {c.source.url ? (
                <a href={c.source.url} target="_blank" rel="noopener noreferrer">
                  {c.source.reference}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ) : (
                <span>{c.source.reference}</span>
              )}
              <span className={`${s.muted} ${s.xs}`}>recorded {c.recorded_on}</span>
            </span>
          );
        },
      }),
    ]);
  }, []);

  if (data.isPending) return <Skeleton height="16rem" />;
  if (data.isError) {
    return (
      <ApiErrorView
        error={data.error}
        title="Could not load constraints"
        onRetry={() => void data.refetch()}
      />
    );
  }
  const d = data.data;
  const blocked = loadBlockedReason(d.load);
  return (
    <div className={s.stack}>
      {blocked ? (
        <Callout tone="warning" title="Blocked">
          {blocked}
        </Callout>
      ) : null}
      <Card aria-labelledby="tgt-load">
        <CardHeader
          titleId="tgt-load"
          title="Load configuration"
          actions={!d.validated ? <UnvalidatedBadge /> : null}
        />
        <CardBody>
          <KeyValueList
            items={[
              {
                key: 'method',
                label: 'Method',
                value: d.load.method === 'rest_api' ? 'REST API' : 'Vendor-approved tool',
              },
              {
                key: 'auth',
                label: 'Authentication',
                value: `${d.load.auth.replace(/_/g, ' ')}${d.load.scopes.length ? ` (scopes ${d.load.scopes.join(', ')})` : ''}`,
              },
              {
                key: 'token',
                label: 'Token path',
                value: d.load.token_path ? <Mono>{d.load.token_path}</Mono> : 'Not recorded',
              },
              {
                key: 'endpoints',
                label: 'Endpoints',
                value: d.load.endpoints.length ? (
                  <ul style={{ listStyle: 'none' }}>
                    {d.load.endpoints.map((e) => (
                      <li key={e.entity}>
                        <strong>{e.entity}</strong>:{' '}
                        <Mono>
                          {e.method} {e.path}
                        </Mono>{' '}
                        <span className={`${s.muted} ${s.xs}`}>batch {e.batch_size}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  'None recorded'
                ),
              },
              {
                key: 'rate',
                label: 'Rate limit',
                value: `${d.load.rate_limit.requests_per_minute} requests per minute, burst ${d.load.rate_limit.burst} (${d.load.rate_limit.source.reference}, ${d.load.rate_limit.recorded_on})`,
              },
              {
                key: 'tools',
                label: 'Approved tools',
                value: d.load.approved_tools.join(', ') || null,
              },
            ]}
          />
        </CardBody>
      </Card>
      <Card flush aria-labelledby="tgt-constraints">
        <CardHeader
          titleId="tgt-constraints"
          title={`Constraints (${d.constraints.length})`}
          description="What the target product allows. Each becomes a planning rule (TGT-…) that plans and designs must follow."
        />
        <CardBody>
          <DataTable
            label="Target constraints"
            data={d.constraints}
            columns={columns}
            getRowId={(c) => c.id}
          />
        </CardBody>
      </Card>
    </div>
  );
}
