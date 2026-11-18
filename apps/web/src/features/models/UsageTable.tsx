import { Coins } from 'lucide-react';
import { useMemo } from 'react';
import type { UsageRow } from '@/api/types';
import { Callout, createDataTableColumns, DataTable, EmptyState } from '@/ui';
import s from '../shared.module.css';
import { Bar } from '../observability/Bar';
import { formatDuration } from '../observability/model';
import obs from '../observability/Observability.module.css';
import { formatTokens, formatUsd } from './model';

export interface UsageTableProps {
  rows: UsageRow[] | undefined;
  loading: boolean;
  /** Column header for the grouping key, e.g. "Agent". */
  groupLabel: string;
  keyLabel?: (key: string | null) => string;
}

/** Calls, tokens and cost per group, with a proportional cost bar and the unpriced-call warning. */
export function UsageTable({ rows, loading, groupLabel, keyLabel }: UsageTableProps) {
  const maxCost = Math.max(0, ...(rows ?? []).map((r) => r.cost_usd));
  const unpriced = (rows ?? []).reduce((n, r) => n + r.unpriced_calls, 0);
  const columns = useMemo(() => {
    const col = createDataTableColumns<UsageRow>();
    return col.columns([
      col.accessor((r) => r.key ?? '', {
        id: 'key',
        header: groupLabel,
        size: 220,
        cell: (info) =>
          info.row.original.key === null ? (
            <span className={s.muted}>Not set</span>
          ) : (
            (keyLabel?.(info.row.original.key) ?? info.row.original.key)
          ),
      }),
      col.accessor('calls', { header: 'Calls', size: 80, meta: { align: 'end' } }),
      col.accessor('errors', {
        header: 'Errors',
        size: 80,
        meta: { align: 'end' },
        cell: (info) => (
          <span className={info.getValue() > 0 ? obs.errors : s.muted}>{info.getValue()}</span>
        ),
      }),
      col.accessor('refused', { header: 'Refused', size: 80, meta: { align: 'end' } }),
      col.accessor((r) => r.input_tokens + r.output_tokens, {
        id: 'tokens',
        header: 'Tokens in / out',
        size: 150,
        meta: { align: 'end' },
        cell: (info) =>
          `${formatTokens(info.row.original.input_tokens)} / ${formatTokens(info.row.original.output_tokens)}`,
      }),
      col.accessor('cost_usd', {
        header: 'Cost',
        size: 220,
        cell: (info) => (
          <span className={obs.barCell}>
            <Bar percent={maxCost > 0 ? (info.getValue() / maxCost) * 100 : 0} />
            <span className={obs.num}>
              {formatUsd(info.getValue())}
              {info.row.original.unpriced_calls > 0 ? (
                <span className="sr-only">
                  , plus {info.row.original.unpriced_calls} unpriced calls
                </span>
              ) : null}
              {info.row.original.unpriced_calls > 0 ? (
                <span
                  aria-hidden="true"
                  title={`${info.row.original.unpriced_calls} calls without a price`}
                >
                  {' '}
                  *
                </span>
              ) : null}
            </span>
          </span>
        ),
      }),
      col.accessor('p95_latency_ms', {
        header: 'p95 latency',
        size: 110,
        meta: { align: 'end' },
        cell: (info) => formatDuration(info.getValue()),
      }),
    ]);
  }, [groupLabel, keyLabel, maxCost]);

  return (
    <div className={s.stackSm}>
      {unpriced > 0 ? (
        <Callout
          tone="warning"
          title={`${unpriced} call${unpriced === 1 ? '' : 's'} without a price`}
        >
          Costs marked * are incomplete: no price is configured for the model that answered. Add the
          model&apos;s prices on its provider.
        </Callout>
      ) : null}
      <DataTable
        label={`Model usage by ${groupLabel.toLowerCase()}`}
        data={rows}
        columns={columns}
        getRowId={(r) => r.key ?? '__none__'}
        loading={loading}
        empty={
          <EmptyState
            compact
            icon={<Coins />}
            title="No model calls yet"
            body="Usage appears once agents (or agent tests) call a model."
          />
        }
      />
    </div>
  );
}
