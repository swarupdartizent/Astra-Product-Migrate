import { Download, ScrollText } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAuditEvents, useExportAudit } from '@/api/audit';
import { saveBlob } from '@/api/client';
import { useTenants } from '@/api/tenancy';
import type { AuditEvent } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { usePermissions } from '@/app/permissions';
import { RequirePermission } from '@/app/RequirePermission';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Badge,
  Button,
  Card,
  CardBody,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Field,
  Input,
  Mono,
  PageHeader,
  Select,
  StatusPill,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import { AuditEventPanel } from './AuditEventPanel';
import { IntegrityCard } from './IntegrityCard';
import {
  ACTOR_TYPES,
  EMPTY_FILTERS,
  outcome,
  rangeError,
  toApiFilters,
  type AuditFilterForm,
} from './model';

const ALL = '__all__';
const col = createDataTableColumns<AuditEvent>();

function buildColumns(tenantName: (id: string | null) => string | null) {
  return col.columns([
    col.accessor('seq', {
      header: 'Seq',
      size: 80,
      meta: { align: 'end', mono: true },
    }),
    col.accessor('occurred_at', {
      header: 'Time',
      size: 130,
      cell: (info) => <Timestamp value={info.getValue()} />,
    }),
    col.accessor('actor_name', {
      header: 'Actor',
      size: 200,
      cell: (info) => (
        <span className={s.row}>
          <span>{info.getValue()}</span>
          <Badge>{info.row.original.actor_type}</Badge>
        </span>
      ),
    }),
    col.accessor('action', {
      header: 'Action',
      size: 230,
      cell: (info) => <Mono>{info.getValue()}</Mono>,
    }),
    col.accessor('outcome', {
      header: 'Outcome',
      size: 110,
      cell: (info) => {
        const o = outcome(info.getValue());
        return <StatusPill tone={o.tone}>{o.label}</StatusPill>;
      },
    }),
    col.accessor((row) => tenantName(row.tenant_id) ?? '', {
      id: 'tenant',
      header: 'Tenant',
      size: 170,
      cell: (info) => {
        const id = info.row.original.tenant_id;
        if (!id) return <span className={s.muted}>Platform</span>;
        return tenantName(id) ?? <Mono className={s.muted}>{id.slice(0, 8)}…</Mono>;
      },
    }),
    col.accessor((row) => `${row.target_type ?? ''} ${row.target_id ?? ''}`, {
      id: 'target',
      header: 'Target',
      size: 220,
      cell: (info) => {
        const e = info.row.original;
        if (!e.target_type && !e.target_id) return <span className={s.muted}>—</span>;
        return (
          <span className={s.cellStack}>
            <span>{e.target_type}</span>
            {e.target_id ? <Mono className={`${s.muted} ${s.xs}`}>{e.target_id}</Mono> : null}
          </span>
        );
      },
    }),
  ]);
}

export function AuditPage() {
  return (
    <RequirePermission permission="audit:read">
      <AuditView />
    </RequirePermission>
  );
}

function AuditView() {
  useDocumentTitle('Audit log');
  const { can } = usePermissions();
  const tenants = useTenants();
  const [form, setForm] = useState<AuditFilterForm>(EMPTY_FILTERS);
  const debounced = useDebouncedValue(form, 350);
  const invalidRange = rangeError(debounced);
  const filters = useMemo(() => toApiFilters(debounced), [debounced]);
  const events = useAuditEvents(filters);
  const exporter = useExportAudit();
  const [selected, setSelected] = useState<AuditEvent | null>(null);

  const tenantMap = useMemo(
    () => new Map((tenants.data ?? []).map((t) => [t.id, t.name])),
    [tenants.data],
  );
  const columns = useMemo(
    () => buildColumns((id) => (id ? (tenantMap.get(id) ?? null) : null)),
    [tenantMap],
  );
  const items = useMemo(() => events.data?.pages.flatMap((p) => p.items), [events.data]);
  const filtered = Object.keys(filters).length > 0;

  function set<K extends keyof AuditFilterForm>(key: K, value: AuditFilterForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function exportAs(format: 'csv' | 'jsonl') {
    exporter.mutate(
      { format, filters },
      {
        onSuccess: (file) => {
          saveBlob(file);
          toast.success(`Exported ${file.filename}`, {
            description: 'The export itself is recorded in the audit log.',
          });
        },
        onError: (error) =>
          toast.error('Export failed', {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  }

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every action on the platform, written once and never changed. Each event carries the hash of the one before it, so any edit or deletion breaks the chain and shows up in verification."
        actions={
          can('audit:export') ? (
            <div className={s.row}>
              <Button
                leadingIcon={<Download aria-hidden="true" />}
                loading={exporter.isPending && exporter.variables.format === 'csv'}
                disabled={exporter.isPending}
                onClick={() => exportAs('csv')}
              >
                Export CSV
              </Button>
              <Button
                leadingIcon={<Download aria-hidden="true" />}
                loading={exporter.isPending && exporter.variables.format === 'jsonl'}
                disabled={exporter.isPending}
                onClick={() => exportAs('jsonl')}
              >
                Export JSONL
              </Button>
            </div>
          ) : null
        }
      />
      <div className={s.stack}>
        <Card flush aria-label="Audit events">
          <div className={s.toolbar}>
            <div className={s.filters}>
              <Field label="Tenant">
                <Select
                  size="sm"
                  options={[
                    { value: ALL, label: 'All tenants and platform' },
                    ...(tenants.data ?? []).map((t) => ({ value: t.id, label: t.name })),
                  ]}
                  value={form.tenant_id || ALL}
                  onValueChange={(v) => set('tenant_id', v === ALL ? '' : v)}
                />
              </Field>
              <Field label="Actor type">
                <Select
                  size="sm"
                  options={[
                    { value: ALL, label: 'Any actor' },
                    ...ACTOR_TYPES.map((t) => ({
                      value: t,
                      label: t.charAt(0).toUpperCase() + t.slice(1),
                    })),
                  ]}
                  value={form.actor_type || ALL}
                  onValueChange={(v) =>
                    set('actor_type', v === ALL ? '' : (v as AuditFilterForm['actor_type']))
                  }
                />
              </Field>
              <Field label="Action starts with">
                <Input
                  size="sm"
                  mono
                  placeholder="e.g. tenant."
                  value={form.action}
                  onChange={(e) => set('action', e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
              </Field>
              <Field label="From">
                <Input
                  size="sm"
                  type="datetime-local"
                  value={form.since}
                  onChange={(e) => set('since', e.target.value)}
                />
              </Field>
              <Field label="To" error={invalidRange}>
                <Input
                  size="sm"
                  type="datetime-local"
                  value={form.until}
                  onChange={(e) => set('until', e.target.value)}
                />
              </Field>
            </div>
            {filtered ? (
              <Button size="sm" variant="ghost" onClick={() => setForm(EMPTY_FILTERS)}>
                Clear filters
              </Button>
            ) : null}
          </div>
          <CardBody>
            {events.isError ? (
              <ApiErrorView
                error={events.error}
                title="Could not load audit events"
                onRetry={() => void events.refetch()}
                retrying={events.isFetching}
                compact
              />
            ) : (
              <DataTable
                label="Audit events, newest first"
                data={items}
                columns={columns}
                getRowId={(e) => String(e.seq)}
                loading={events.isPending}
                skeletonRows={8}
                onRowClick={setSelected}
                empty={
                  <EmptyState
                    compact
                    icon={<ScrollText />}
                    title={filtered ? 'No events match these filters' : 'No audit events yet'}
                    body={filtered ? 'Widen the time range or clear a filter.' : undefined}
                  />
                }
              />
            )}
          </CardBody>
          {events.hasNextPage ? (
            <div className={s.center}>
              <Button
                variant="secondary"
                size="sm"
                loading={events.isFetchingNextPage}
                onClick={() => void events.fetchNextPage()}
              >
                Load older events
              </Button>
            </div>
          ) : items && items.length > 0 ? (
            <p className={s.footerNote}>
              Showing all {items.length} matching events.
              {can('audit:export') ? ' Exports include every event matching the filters.' : ''}
            </p>
          ) : null}
        </Card>

        <IntegrityCard />
      </div>
      {selected ? (
        <AuditEventPanel
          event={selected}
          tenantName={selected.tenant_id ? (tenantMap.get(selected.tenant_id) ?? null) : null}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  );
}
