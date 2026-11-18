import { Activity } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useModelCalls, type CallFilters } from '@/api/models';
import type { ModelCall } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import {
  Badge,
  Card,
  CardBody,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Field,
  Input,
  Mono,
  Select,
  StatusPill,
  Timestamp,
} from '@/ui';
import s from '../shared.module.css';
import { formatDuration } from '../observability/model';
import { callTone, formatTokens, formatUsd } from './model';
import styles from './Models.module.css';

const ALL = '__all__';

const col = createDataTableColumns<ModelCall>();
const columns = col.columns([
  col.accessor('created_at', {
    header: 'Time',
    size: 120,
    cell: (info) => <Timestamp value={info.getValue()} />,
  }),
  col.accessor((c) => c.agent_name ?? '', {
    id: 'agent',
    header: 'Agent',
    size: 180,
    cell: (info) => {
      const c = info.row.original;
      if (!c.agent_name) return <span className={s.muted}>—</span>;
      return (
        <span className={s.cellStack}>
          <span>
            {c.agent_name} <span className={s.muted}>{c.agent_version}</span>
          </span>
          {c.test_run_id ? <Badge>Test run</Badge> : null}
        </span>
      );
    },
  }),
  col.accessor((c) => c.served_model ?? c.requested_model, {
    id: 'model',
    header: 'Model',
    size: 240,
    cell: (info) => {
      const c = info.row.original;
      return (
        <span className={s.cellStack}>
          <span>
            <Mono className={s.small}>{c.served_model ?? 'not served'}</Mono>
            {c.alias ? <span className={`${s.muted} ${s.xs}`}> via {c.alias}</span> : null}
          </span>
          <span className={`${s.muted} ${s.xs}`}>
            {c.provider_name}
            {c.api_version ? ` · API ${c.api_version}` : ''}
            {c.region_code ? ` · ${c.region_code}${c.region_pinned ? ' (pinned)' : ''}` : ''}
          </span>
        </span>
      );
    },
  }),
  col.accessor('status', {
    header: 'Status',
    size: 140,
    cell: (info) => (
      <span className={s.cellStack}>
        <StatusPill tone={callTone(info.getValue())}>{info.getValue()}</StatusPill>
        {info.row.original.error ? (
          <span className={`${s.muted} ${s.xs}`} style={{ whiteSpace: 'normal' }}>
            {info.row.original.error}
          </span>
        ) : info.row.original.stop_reason ? (
          <span className={`${s.muted} ${s.xs}`}>stop: {info.row.original.stop_reason}</span>
        ) : null}
      </span>
    ),
  }),
  col.accessor((c) => c.input_tokens + c.output_tokens, {
    id: 'tokens',
    header: 'Tokens in / out',
    size: 140,
    meta: { align: 'end' },
    cell: (info) => {
      const c = info.row.original;
      return `${formatTokens(c.input_tokens + c.cache_read_tokens + c.cache_write_tokens)} / ${formatTokens(c.output_tokens)}`;
    },
  }),
  col.accessor((c) => c.cost_usd ?? -1, {
    id: 'cost',
    header: 'Cost',
    size: 150,
    meta: { align: 'end' },
    cell: (info) =>
      info.row.original.cost_usd === null ? (
        <span className={styles.warnText}>Price not configured</span>
      ) : (
        formatUsd(info.row.original.cost_usd)
      ),
  }),
  col.accessor('latency_ms', {
    header: 'Latency',
    size: 100,
    meta: { align: 'end' },
    cell: (info) => formatDuration(info.getValue()),
  }),
]);

export function CallsTab({ initial }: { initial?: CallFilters }) {
  const [agent, setAgent] = useState(initial?.agent ?? '');
  const [status, setStatus] = useState(initial?.status ?? '');
  const debouncedAgent = useDebouncedValue(agent.trim(), 300);
  const filters = useMemo<CallFilters>(
    () => ({
      ...initial,
      ...(debouncedAgent ? { agent: debouncedAgent } : {}),
      ...(status ? { status } : {}),
    }),
    [initial, debouncedAgent, status],
  );
  const calls = useModelCalls(filters);

  return (
    <Card flush aria-label="Model calls">
      <div className={s.toolbar}>
        <div className={s.filters}>
          <Field label="Agent">
            <Input
              size="sm"
              mono
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              placeholder="Agent name"
            />
          </Field>
          <Field label="Status">
            <Select
              size="sm"
              options={[
                { value: ALL, label: 'Any status' },
                { value: 'ok', label: 'OK' },
                { value: 'error', label: 'Error' },
                { value: 'refused', label: 'Refused' },
              ]}
              value={status || ALL}
              onValueChange={(v) => setStatus(v === ALL ? '' : v)}
            />
          </Field>
        </div>
      </div>
      <CardBody>
        {calls.isError ? (
          <ApiErrorView
            error={calls.error}
            title="Could not load model calls"
            compact
            onRetry={() => void calls.refetch()}
          />
        ) : (
          <DataTable
            label="Model calls, newest first"
            data={calls.data}
            columns={columns}
            getRowId={(c) => c.id}
            loading={calls.isPending}
            empty={<EmptyState compact icon={<Activity />} title="No model calls" />}
          />
        )}
      </CardBody>
      <p className={s.footerNote}>
        The 100 most recent calls. “Price not configured” means the cost is unknown, not zero.
      </p>
    </Card>
  );
}
