import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { adapterKeys, useAdapterRun, useRunObject, useRunObjects } from '@/api/adapters';
import type {
  AdapterRunDetail,
  CoverageRow,
  ExtractCount,
  ExtractedDocument,
  SourceObject,
  TrapFinding,
} from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { JobProgress } from '@/app/JobProgress';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Field,
  Input,
  KeyValueList,
  Mono,
  PageHeader,
  PlainText,
  Select,
  Sheet,
  Skeleton,
  StatusPill,
  Timestamp,
} from '@/ui';
import s from '../shared.module.css';
import {
  adapterRunStatus,
  checkSummary,
  countsMismatch,
  coverageTone,
  objectsByType,
  orderDocuments,
  RUN_KIND_LABELS,
  SEVERITY_TONE,
  WRITABLE_ACCOUNT,
} from '../adapters/model';

const wrap = { whiteSpace: 'normal' } as const;
const PAGE = 50;

export function AdapterRunPage({ runId }: { runId: string }) {
  const detail = useAdapterRun(runId);
  const qc = useQueryClient();
  useDocumentTitle('Adapter run');
  const breadcrumbs = [{ label: 'Tenants', to: '/tenants' as const }, { label: 'Adapter run' }];
  if (detail.isPending) {
    return (
      <div aria-busy="true">
        <PageHeader breadcrumbs={breadcrumbs} title={<Skeleton width="16rem" height="1.75rem" />} />
        <Skeleton height="16rem" />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <>
        <PageHeader breadcrumbs={breadcrumbs} title="Adapter run" />
        <ApiErrorView
          error={detail.error}
          title="Could not load this run"
          onRetry={() => void detail.refetch()}
        />
      </>
    );
  }
  const d = detail.data;
  const r = d.run;
  const st = adapterRunStatus(r.status);
  const breadcrumbsWithTenant = [
    { label: 'Tenants', to: '/tenants' as const },
    { label: `${RUN_KIND_LABELS[r.kind] ?? r.kind}${r.mode ? ` (${r.mode})` : ''}` },
  ];

  return (
    <>
      <PageHeader
        breadcrumbs={breadcrumbsWithTenant}
        title={`${RUN_KIND_LABELS[r.kind] ?? r.kind}${r.mode ? ` (${r.mode})` : ''}`}
        meta={<StatusPill tone={st.tone}>{st.label}</StatusPill>}
        description={
          <>
            <Mono>{r.adapter}</Mono> · requested by {r.requested_by} ·{' '}
            <Timestamp value={r.created_at} />
            {r.finished_at ? (
              <>
                {' '}
                · finished <Timestamp value={r.finished_at} />
              </>
            ) : null}
          </>
        }
      />
      <div className={s.stack}>
        {r.job_id && (r.status === 'queued' || r.status === 'running') ? (
          <JobProgress
            jobId={r.job_id}
            title="Run in progress"
            onFinished={() => void qc.invalidateQueries({ queryKey: adapterKeys.all })}
          />
        ) : null}
        {r.status === 'blocked' ? (
          <Callout tone="warning" title="Blocked">
            {r.status_detail ?? 'The run could not start.'}
          </Callout>
        ) : r.status_detail && r.kind !== 'check' ? (
          <Callout tone={r.status === 'succeeded' ? 'info' : 'danger'} title={st.label}>
            {r.status_detail}
          </Callout>
        ) : null}
        {r.kind === 'check' ? <CheckView detail={d} /> : null}
        {r.kind === 'harvest' ? <HarvestView detail={d} /> : null}
        {r.kind === 'extract' ? <ExtractView detail={d} /> : null}
      </div>
    </>
  );
}

function CheckView({ detail }: { detail: AdapterRunDetail }) {
  const chk = checkSummary(detail.run);
  if (!chk) {
    return detail.run.status === 'queued' || detail.run.status === 'running' ? null : (
      <EmptyState compact title="No check result" body={detail.run.status_detail ?? undefined} />
    );
  }
  return (
    <div className={s.stack}>
      {!chk.read_only ? (
        <Callout tone="danger" title="Not read-only">
          {WRITABLE_ACCOUNT}
        </Callout>
      ) : null}
      {chk.problems.length > 0 ? (
        <Callout tone={chk.ok ? 'warning' : 'danger'} title="Problems">
          <ul style={{ paddingLeft: 'var(--space-4)' }}>
            {chk.problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
      <Card aria-labelledby="check-result">
        <CardHeader
          titleId="check-result"
          title="Connection check"
          actions={
            <StatusPill tone={chk.ok ? 'success' : 'danger'}>
              {chk.ok ? 'Passed' : 'Failed'}
            </StatusPill>
          }
        />
        <CardBody>
          <KeyValueList
            items={[
              {
                key: 'engine',
                label: 'Engine',
                value: `${chk.engine}${chk.engine_version ? ` ${chk.engine_version}` : ''}`,
              },
              { key: 'edition', label: 'Edition', value: chk.edition },
              {
                key: 'db',
                label: 'Database',
                value: chk.database ? <Mono>{chk.database}</Mono> : null,
              },
              { key: 'login', label: 'Login', value: chk.login ? <Mono>{chk.login}</Mono> : null },
              {
                key: 'ro',
                label: 'Read-only',
                value: (
                  <StatusPill tone={chk.read_only ? 'success' : 'danger'}>
                    {chk.read_only ? 'Yes' : 'No: the account can write'}
                  </StatusPill>
                ),
              },
              {
                key: 'evidence',
                label: 'Read-only evidence',
                value: chk.read_only_evidence.length ? (
                  <ul style={{ paddingLeft: 'var(--space-4)' }}>
                    {chk.read_only_evidence.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                ) : null,
              },
              {
                key: 'supported',
                label: 'Engine version supported',
                value: chk.supported ? 'Yes' : 'No',
              },
            ]}
          />
        </CardBody>
      </Card>
    </div>
  );
}

function HarvestView({ detail }: { detail: AdapterRunDetail }) {
  const summary = detail.run.summary;
  const byType = objectsByType(summary);
  const complete = summary.coverage_complete === true;
  const coverage = detail.coverage ?? [];
  const traps = detail.traps ?? [];
  const covColumns = useMemo(() => {
    const col = createDataTableColumns<CoverageRow>();
    return col.columns([
      col.accessor('label', {
        header: 'Object type',
        size: 220,
        cell: (info) => (
          <span className={s.cellStack}>
            <span>{info.getValue()}</span>
            <span className={`${s.muted} ${s.xs}`}>
              <Mono>{info.row.original.object_type}</Mono>
              {info.row.original.required ? '' : ' · optional'}
            </span>
          </span>
        ),
      }),
      col.accessor('status', {
        header: 'Status',
        size: 120,
        cell: (info) => (
          <StatusPill tone={coverageTone(info.row.original)}>{info.getValue()}</StatusPill>
        ),
      }),
      col.accessor((r) => r.count ?? -1, {
        id: 'count',
        header: 'Objects',
        size: 90,
        meta: { align: 'end' },
        cell: (info) => info.row.original.count ?? '—',
      }),
      col.accessor((r) => r.dependencies ?? -1, {
        id: 'deps',
        header: 'Dependencies',
        size: 120,
        meta: { align: 'end' },
        cell: (info) => info.row.original.dependencies ?? '—',
      }),
      col.accessor((r) => r.code_missing ?? 0, {
        id: 'code',
        header: 'Code missing',
        size: 120,
        meta: { align: 'end' },
        cell: (info) =>
          (info.row.original.code_missing ?? 0) > 0 ? (
            <Badge tone="warning">{info.row.original.code_missing}</Badge>
          ) : (
            '0'
          ),
      }),
      col.accessor((r) => r.error ?? '', {
        id: 'error',
        header: 'Error',
        size: 260,
        cell: (info) => <span style={wrap}>{info.row.original.error ?? '—'}</span>,
      }),
    ]);
  }, []);

  return (
    <div className={s.stack}>
      <Card aria-labelledby="harvest-coverage">
        <CardHeader
          titleId="harvest-coverage"
          title="Coverage"
          description={byType.map(([t, n]) => `${t}: ${n}`).join(' · ') || undefined}
          actions={
            <StatusPill tone={complete ? 'success' : 'warning'}>
              {complete ? 'Coverage complete' : 'Coverage incomplete'}
            </StatusPill>
          }
        />
        <CardBody>
          <DataTable
            label="Coverage by object type"
            data={coverage}
            columns={covColumns}
            getRowId={(r) => r.object_type}
          />
        </CardBody>
      </Card>
      <Card aria-labelledby="harvest-traps">
        <CardHeader
          titleId="harvest-traps"
          title={`Trap findings (${traps.length})`}
          description="Known problems found in this estate."
        />
        <CardBody className={s.stackSm}>
          {traps.length === 0 ? (
            <p className={s.muted}>No known traps were found.</p>
          ) : (
            traps.map((t: TrapFinding) => (
              <section
                key={`${t.origin}:${t.trap_id}`}
                aria-label={t.title}
                className={s.cellStack}
              >
                <span className={s.row}>
                  <Badge tone={SEVERITY_TONE[t.severity] ?? 'neutral'}>{t.severity}</Badge>
                  <strong>{t.title}</strong>
                  <Mono className={s.xs}>{t.trap_id}</Mono>
                  <Badge>{t.stream}</Badge>
                  <Badge tone={t.origin === 'curated' ? 'accent' : 'neutral'}>{t.origin}</Badge>
                </span>
                <span className={s.small}>{t.advice}</span>
                {t.hits.length ? (
                  <PlainText label={`Hits for ${t.trap_id}`}>{t.hits.join('\n')}</PlainText>
                ) : null}
              </section>
            ))
          )}
        </CardBody>
      </Card>
      <ObjectBrowser runId={detail.run.id} types={byType.map(([t]) => t)} />
    </div>
  );
}

function ObjectBrowser({ runId, types }: { runId: string; types: string[] }) {
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const dq = useDebouncedValue(q.trim(), 300);
  const objects = useRunObjects(runId, {
    ...(type ? { object_type: type } : {}),
    ...(dq ? { q: dq } : {}),
    offset,
    limit: PAGE,
  });
  const [open, setOpen] = useState<SourceObject | null>(null);
  const columns = useMemo(() => {
    const col = createDataTableColumns<SourceObject>();
    return col.columns([
      col.accessor('name', {
        header: 'Object',
        size: 300,
        cell: (info) => (
          <span className={s.cellStack}>
            <Mono className={s.small}>
              {info.row.original.schema ? `${info.row.original.schema}.` : ''}
              {info.getValue()}
            </Mono>
            <span className={`${s.muted} ${s.xs}`}>{info.row.original.object_type}</span>
          </span>
        ),
      }),
      col.accessor((o) => o.owner ?? '', { id: 'owner', header: 'Owner', size: 120 }),
      col.accessor((o) => o.modified_at ?? '', {
        id: 'modified',
        header: 'Last change',
        size: 130,
        cell: (info) =>
          info.row.original.modified_at ? <Timestamp value={info.row.original.modified_at} /> : '—',
      }),
      col.accessor((o) => (o.depends_on ?? []).length, {
        id: 'deps',
        header: 'Depends on',
        size: 110,
        meta: { align: 'end' },
      }),
      col.accessor('has_code', {
        header: 'Code',
        size: 80,
        cell: (info) => (info.getValue() ? <Badge tone="info">Code</Badge> : '—'),
      }),
    ]);
  }, []);
  const total = objects.data?.total ?? 0;

  return (
    <Card flush aria-labelledby="objects-title">
      <CardHeader
        titleId="objects-title"
        title="Object browser"
        description={`${total.toLocaleString()} objects match.`}
      />
      <div className={s.toolbar}>
        <div className={s.filters}>
          <Field label="Object type">
            <Select
              size="sm"
              options={[
                { value: '__all__', label: 'All types' },
                ...types.map((t) => ({ value: t, label: t })),
              ]}
              value={type || '__all__'}
              onValueChange={(v) => {
                setType(v === '__all__' ? '' : v);
                setOffset(0);
              }}
            />
          </Field>
          <Field label="Name or schema">
            <Input
              size="sm"
              type="search"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setOffset(0);
              }}
              startAdornment={<Search />}
            />
          </Field>
        </div>
      </div>
      <CardBody>
        {objects.isError ? (
          <ApiErrorView
            error={objects.error}
            title="Could not load objects"
            compact
            onRetry={() => void objects.refetch()}
          />
        ) : (
          <DataTable
            label="Harvested objects"
            data={objects.data?.items}
            columns={columns}
            getRowId={(o) => `${o.object_type}:${o.schema}:${o.name}`}
            loading={objects.isPending}
            onRowClick={setOpen}
            empty={<EmptyState compact title="No objects match" />}
          />
        )}
      </CardBody>
      <div className={s.center} style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
        <Button
          size="sm"
          variant="ghost"
          leadingIcon={<ChevronLeft aria-hidden="true" />}
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - PAGE))}
        >
          Previous
        </Button>
        <span className={`${s.muted} ${s.small}`} role="status">
          {total === 0 ? '0' : `${offset + 1}–${Math.min(offset + PAGE, total)}`} of{' '}
          {total.toLocaleString()}
        </span>
        <Button
          size="sm"
          variant="ghost"
          trailingIcon={<ChevronRight aria-hidden="true" />}
          disabled={offset + PAGE >= total}
          onClick={() => setOffset(offset + PAGE)}
        >
          Next
        </Button>
      </div>
      {open ? <ObjectSheet runId={runId} object={open} onClose={() => setOpen(null)} /> : null}
    </Card>
  );
}

function ObjectSheet({
  runId,
  object,
  onClose,
}: {
  runId: string;
  object: SourceObject;
  onClose: () => void;
}) {
  const detail = useRunObject(runId, {
    type: object.object_type,
    name: object.name,
    schema: object.schema,
  });
  const o = detail.data;
  return (
    <Sheet
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title={`${object.schema ? `${object.schema}.` : ''}${object.name}`}
      description={object.object_type}
      size="lg"
    >
      {detail.isPending ? (
        <Skeleton height="12rem" />
      ) : detail.isError ? (
        <ApiErrorView
          error={detail.error}
          title="Could not load the object"
          compact
          onRetry={() => void detail.refetch()}
        />
      ) : o ? (
        <>
          <KeyValueList
            items={[
              { key: 'owner', label: 'Owner', value: o.owner },
              {
                key: 'modified',
                label: 'Last change',
                value: o.modified_at ? <Timestamp value={o.modified_at} /> : null,
              },
              {
                key: 'deps',
                label: 'Depends on',
                value: o.depends_on?.length ? (
                  <PlainText label="Dependencies">{o.depends_on.join('\n')}</PlainText>
                ) : null,
              },
              {
                key: 'sha',
                label: 'Code digest',
                value: o.definition_sha256 ? (
                  <Mono className={s.xs}>{o.definition_sha256}</Mono>
                ) : null,
              },
            ]}
          />
          <section aria-label="Source code" className={s.stackSm}>
            <h3 className={s.cellPrimary}>Source code (legacy, shown as text)</h3>
            <PlainText
              label={`Source code of ${object.name}`}
              lineNumbers
              empty={<p className={s.muted}>This object has no code.</p>}
            >
              {o.definition}
            </PlainText>
          </section>
          {o.detail && Object.keys(o.detail).length > 0 ? (
            <section aria-label="Detail" className={s.stackSm}>
              <h3 className={s.cellPrimary}>Detail</h3>
              <PlainText label="Object detail">{JSON.stringify(o.detail, null, 2)}</PlainText>
            </section>
          ) : null}
        </>
      ) : null}
    </Sheet>
  );
}

function ExtractView({ detail }: { detail: AdapterRunDetail }) {
  const counts = detail.counts ?? [];
  const docs = orderDocuments(detail.documents ?? []);
  const broken = docs.filter((d) => !d.link_resolved).length;
  const countColumns = useMemo(() => {
    const col = createDataTableColumns<ExtractCount>();
    return col.columns([
      col.accessor('entity', { header: 'Entity', size: 200 }),
      col.accessor((c) => c.source_count ?? -1, {
        id: 'source',
        header: 'In the source',
        size: 130,
        meta: { align: 'end' },
        cell: (info) => info.row.original.source_count?.toLocaleString() ?? '—',
      }),
      col.accessor('extracted', {
        header: 'Extracted',
        size: 120,
        meta: { align: 'end' },
        cell: (info) => info.getValue().toLocaleString(),
      }),
      col.display({
        id: 'match',
        header: 'Match',
        size: 120,
        cell: (info) =>
          countsMismatch(info.row.original) ? (
            <StatusPill tone="danger">Mismatch</StatusPill>
          ) : (
            <StatusPill tone="success">Match</StatusPill>
          ),
      }),
      col.accessor((c) => c.watermark ?? '', {
        id: 'wm',
        header: 'Watermark',
        size: 200,
        cell: (info) =>
          info.row.original.watermark ? (
            <Mono className={s.xs}>{info.row.original.watermark}</Mono>
          ) : (
            '—'
          ),
      }),
    ]);
  }, []);
  const docColumns = useMemo(() => {
    const col = createDataTableColumns<ExtractedDocument>();
    return col.columns([
      col.accessor('name', {
        header: 'Document',
        size: 240,
        cell: (info) => (
          <span className={s.cellStack}>
            <span>{info.getValue()}</span>
            <Mono className={`${s.muted} ${s.xs}`}>{info.row.original.doc_key}</Mono>
          </span>
        ),
      }),
      col.display({
        id: 'link',
        header: 'Linked to',
        size: 220,
        cell: (info) => {
          const d = info.row.original;
          return d.link_entity ? `${d.link_entity} ${d.link_key ?? ''}` : '—';
        },
      }),
      col.accessor('link_resolved', {
        header: 'Link',
        size: 120,
        cell: (info) =>
          info.getValue() ? (
            <StatusPill tone="success">Resolved</StatusPill>
          ) : (
            <StatusPill tone="danger">Broken</StatusPill>
          ),
      }),
      col.accessor((d) => d.size_bytes ?? -1, {
        id: 'size',
        header: 'Size',
        size: 100,
        meta: { align: 'end' },
        cell: (info) =>
          info.row.original.size_bytes === null
            ? '—'
            : `${info.row.original.size_bytes.toLocaleString()} B`,
      }),
    ]);
  }, []);
  return (
    <div className={s.stack}>
      <Card flush aria-labelledby="extract-counts">
        <CardHeader
          titleId="extract-counts"
          title="Counts per entity"
          description="Rows counted in the source against rows extracted."
        />
        <CardBody>
          <DataTable
            label="Extract counts"
            data={counts}
            columns={countColumns}
            getRowId={(c) => c.entity}
          />
        </CardBody>
      </Card>
      <Card flush aria-labelledby="extract-docs">
        <CardHeader
          titleId="extract-docs"
          title={`Documents (${docs.length})`}
          description={
            broken > 0
              ? `${broken} document link${broken === 1 ? '' : 's'} could not be resolved; they are listed first.`
              : 'Every document link resolved.'
          }
        />
        <CardBody>
          <DataTable
            label="Extracted documents"
            data={docs}
            columns={docColumns}
            getRowId={(d) => d.doc_key}
            maxHeight="32rem"
          />
        </CardBody>
      </Card>
    </div>
  );
}
