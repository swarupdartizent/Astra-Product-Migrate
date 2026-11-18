import { useQueryClient } from '@tanstack/react-query';
import { Code, Play, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSourceConnections } from '@/api/adapters';
import type { Project } from '@/api/types';
import {
  upgradeKeys,
  useConversionRuns,
  useConvertedObject,
  useConvertedObjects,
  useStartConversion,
} from '@/api/upgrade';
import type {
  ConversionRun,
  ConvertedObject,
  ConvertedObjectDetail,
  TestOutcome,
} from '@/api/upgrade-types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { JobProgress } from '@/app/JobProgress';
import { hasErrors, mergeFieldErrors, type FieldErrors } from '@/lib/forms';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
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
  PlainText,
  Select,
  Sheet,
  Skeleton,
  StatusPill,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import styles from '../discovery/Discovery.module.css';
import { countText, runStatus } from '../discovery/model';
import { objectStatus, OBJECT_PAGE, OBJECT_STATUS, show, TARGET_DIALECTS } from './model';
import { RecordedTests } from './RecordedTests';

const ALL = '__all__';

export function ConversionTab({ project }: { project: Project }) {
  const runs = useConversionRuns(project.id);
  const qc = useQueryClient();
  const canRun = project.permissions.includes('source:manage');
  const [starting, setStarting] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const active = runs.data?.find((r) => r.status === 'queued' || r.status === 'running');
  const current = runs.data?.find((r) => r.id === selected) ?? runs.data?.[0] ?? null;

  return (
    <div className={s.stack}>
      <Card aria-labelledby="conv-runs">
        <CardHeader
          titleId="conv-runs"
          title="Code conversion"
          description="Converts the source's procedures, functions, triggers and views to the target dialect, compiles each one on the workbench against the pinned target baseline, and replays the recorded tests. Objects that cannot be converted safely go to the review queue with the reason."
          actions={
            canRun ? (
              <Button
                variant="primary"
                leadingIcon={<Play aria-hidden="true" />}
                onClick={() => setStarting(true)}
                disabled={!!active}
              >
                Run conversion
              </Button>
            ) : null
          }
        />
        <CardBody className={s.stackSm}>
          {active?.job_id ? (
            <JobProgress
              jobId={active.job_id}
              title="Code conversion"
              cancellable
              onFinished={() => void qc.invalidateQueries({ queryKey: upgradeKeys.all })}
            />
          ) : null}
          {runs.isPending ? (
            <Skeleton height="4rem" />
          ) : runs.isError ? (
            <ApiErrorView
              error={runs.error}
              title="Could not load conversion runs"
              compact
              onRetry={() => void runs.refetch()}
            />
          ) : runs.data.length === 0 ? (
            <EmptyState compact icon={<Code />} title="No conversion yet" />
          ) : (
            <ul style={{ listStyle: 'none' }} className={s.stackSm} aria-label="Conversion runs">
              {runs.data.map((r) => {
                const st = runStatus(r.status);
                return (
                  <li key={r.id} className={s.row}>
                    <StatusPill tone={st.tone}>{st.label}</StatusPill>
                    <Button
                      size="sm"
                      variant={r.id === current?.id ? 'secondary' : 'ghost'}
                      aria-pressed={r.id === current?.id}
                      onClick={() => setSelected(r.id)}
                    >
                      {r.connection_name ?? 'Source'}: {r.source_dialect} to {r.target_dialect}
                    </Button>
                    <span className={`${s.muted} ${s.xs}`}>
                      <Timestamp value={r.created_at} /> · {r.requested_by}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>
      {current ? <ConversionRunView run={current} /> : null}
      <RecordedTests project={project} />
      {starting ? (
        <StartConversionDialog project={project} onClose={() => setStarting(false)} />
      ) : null}
    </div>
  );
}

function StartConversionDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const conns = useSourceConnections(project.tenant_id);
  const start = useStartConversion(project.id);
  const [connectionId, setConnectionId] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const client: FieldErrors<'connection_id' | 'target_dialect'> = {};
  if (!connectionId) client.connection_id = 'Choose a source connection.';
  const errors = mergeFieldErrors(client, start.error, submitted);
  const dialect = TARGET_DIALECTS[0];
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Run code conversion"
      description="Runs in the background. Needs a passing connection check and a pinned target baseline."
      submitLabel="Start conversion"
      pending={start.isPending}
      error={start.error}
      fields={['connection_id', 'target_dialect']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(client)) return;
        start.mutate(
          { connection_id: connectionId, target_dialect: dialect },
          {
            onSuccess: () => {
              toast.info('Conversion started');
              onClose();
            },
          },
        );
      }}
    >
      <Field label="Source connection" error={errors.connection_id} required>
        <Select
          options={(conns.data ?? []).map((c) => ({
            value: c.id,
            label: `${c.name} (${c.engine})${c.last_check?.status === 'succeeded' ? '' : ' · not checked'}`,
          }))}
          value={connectionId}
          onValueChange={setConnectionId}
          placeholder={conns.isPending ? 'Loading…' : 'Choose a connection'}
        />
      </Field>
      <Field
        label="Target dialect"
        error={errors.target_dialect}
        help="The only target dialect the platform converts to today. A source engine with no converter for it is refused."
      >
        <Input value={dialect} readOnly mono />
      </Field>
    </FormDialog>
  );
}

function ConversionRunView({ run: r }: { run: ConversionRun }) {
  const st = runStatus(r.status);
  const done = r.status === 'succeeded';
  const sm = r.summary;
  const metrics: [string, string][] = [
    ['Objects', countText(sm.objects)],
    ['Compiled', countText(sm.compiled)],
    ['Do not compile', countText(sm.compile_failed)],
    ['Need review', countText(sm.review)],
    ['Tests passed', countText(sm.tests?.passed)],
    ['Tests failed', countText(sm.tests?.failed)],
    ['Code unreadable', countText(sm.code_unreadable)],
    ['Workbench tables', countText(sm.workbench_tables)],
  ];
  return (
    <Card aria-labelledby={`conv-${r.id}`}>
      <CardHeader
        titleId={`conv-${r.id}`}
        title={`${r.connection_name ?? 'Source'}: ${r.source_dialect} to ${r.target_dialect}`}
        description={`Compiled against ${r.baseline}.`}
        actions={<StatusPill tone={st.tone}>{st.label}</StatusPill>}
      />
      <CardBody className={s.stack}>
        {r.status === 'blocked' ? (
          <Callout tone="warning" title="Blocked">
            {r.status_detail ?? 'The conversion could not start.'}
          </Callout>
        ) : r.status_detail ? (
          <Callout tone={done ? 'info' : 'danger'} title={st.label}>
            {r.status_detail}
          </Callout>
        ) : null}
        {done ? (
          <>
            <dl className={styles.metrics}>
              {metrics.map(([label, value]) => (
                <div key={label} className={styles.metric}>
                  <dt className={styles.metricLabel}>{label}</dt>
                  <dd className={styles.metricValue}>{value}</dd>
                </div>
              ))}
            </dl>
            {(sm.code_unreadable ?? 0) > 0 ? (
              <Callout tone="warning">
                The code of {sm.code_unreadable} object(s) could not be read through the adapter, so
                they were not converted.
              </Callout>
            ) : null}
            <ObjectsTable runId={r.id} />
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

function ObjectsTable({ runId }: { runId: string }) {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q.trim(), 300);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<ConvertedObject | null>(null);
  const objects = useConvertedObjects(runId, {
    ...(status ? { status } : {}),
    ...(dq ? { q: dq } : {}),
    offset,
    limit: OBJECT_PAGE,
  });
  const columns = useMemo(() => {
    const col = createDataTableColumns<ConvertedObject>();
    return col.columns([
      col.accessor('name', {
        header: 'Object',
        size: 240,
        cell: (info) => <Mono className={s.small}>{info.getValue()}</Mono>,
      }),
      col.accessor('object_type', { header: 'Type', size: 110 }),
      col.accessor('status', {
        header: 'Status',
        size: 150,
        cell: (info) => (
          <StatusPill tone={objectStatus(info.getValue()).tone}>
            {objectStatus(info.getValue()).label}
          </StatusPill>
        ),
      }),
      col.accessor((o) => o.tests.filter((t) => t.passed).length, {
        id: 'tests',
        header: 'Tests',
        size: 120,
        cell: (info) => {
          const t = info.row.original.tests;
          if (t.length === 0) return '—';
          const failed = t.filter((x) => !x.passed).length;
          return failed ? (
            <Badge tone="danger">
              {failed} of {t.length} failed
            </Badge>
          ) : (
            <Badge tone="success">{t.length} passed</Badge>
          );
        },
      }),
      col.accessor((o) => o.warnings.length + o.review.length, {
        id: 'notes',
        header: 'Warnings',
        size: 100,
        meta: { align: 'end' },
      }),
    ]);
  }, []);
  const total = objects.data?.total ?? 0;
  return (
    <section aria-labelledby={`objs-${runId}`}>
      <h3 id={`objs-${runId}`} className={styles.sectionTitle}>
        Converted objects
      </h3>
      <div className={s.filters} style={{ marginBottom: 'var(--space-2)' }}>
        <Field label="Status">
          <Select
            size="sm"
            options={[
              { value: ALL, label: 'All' },
              ...Object.entries(OBJECT_STATUS).map(([k, v]) => ({ value: k, label: v.label })),
            ]}
            value={status || ALL}
            onValueChange={(v) => {
              setStatus(v === ALL ? '' : v);
              setOffset(0);
            }}
          />
        </Field>
        <Field label="Name contains">
          <Input
            size="sm"
            type="search"
            startAdornment={<Search />}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOffset(0);
            }}
          />
        </Field>
      </div>
      {objects.isError ? (
        <ApiErrorView
          error={objects.error}
          title="Could not load converted objects"
          compact
          onRetry={() => void objects.refetch()}
        />
      ) : (
        <DataTable
          label="Converted objects"
          data={objects.data?.items}
          columns={columns}
          getRowId={(o) => `${o.object_type}:${o.name}`}
          loading={objects.isPending}
          onRowClick={setOpen}
          maxHeight="32rem"
          empty={<EmptyState compact title="No objects match" />}
        />
      )}
      <div className={s.toolbar} style={{ justifyContent: 'space-between' }}>
        <span className={`${s.muted} ${s.small}`} aria-live="polite">
          {total === 0
            ? 'No objects'
            : `${String(offset + 1)}–${String(Math.min(offset + OBJECT_PAGE, total))} of ${total.toLocaleString()}`}
        </span>
        <span className={s.row}>
          <Button
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - OBJECT_PAGE))}
          >
            Previous
          </Button>
          <Button
            size="sm"
            disabled={offset + OBJECT_PAGE >= total}
            onClick={() => setOffset(offset + OBJECT_PAGE)}
          >
            Next
          </Button>
        </span>
      </div>
      {open ? <ObjectSheet runId={runId} object={open} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

function ObjectSheet({
  runId,
  object,
  onClose,
}: {
  runId: string;
  object: ConvertedObject;
  onClose: () => void;
}) {
  const q = useConvertedObject(runId, { type: object.object_type, name: object.name });
  const st = objectStatus(object.status);
  return (
    <Sheet
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title={object.name}
      description={`${object.object_type} · ${st.label}`}
      size="lg"
    >
      {q.isPending ? (
        <Skeleton height="20rem" />
      ) : q.isError ? (
        <ApiErrorView
          error={q.error}
          title="Could not load the object"
          onRetry={() => void q.refetch()}
        />
      ) : (
        <ObjectDetail detail={q.data} />
      )}
    </Sheet>
  );
}

export function ObjectDetail({ detail: d }: { detail: ConvertedObjectDetail }) {
  const comp = d.compile;
  return (
    <div className={s.stack}>
      {d.review.length > 0 ? (
        <Callout tone="warning" title="Needs review">
          <ul className={styles.plainList}>
            {d.review.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
      {comp.ok === false ? (
        <Callout tone="danger" title="Does not compile on the workbench">
          {comp.error ?? 'No error text was returned.'}
        </Callout>
      ) : comp.ok === true ? (
        <Callout tone="success">Compiles on the workbench.</Callout>
      ) : null}
      {comp.unresolved && comp.unresolved.length > 0 ? (
        <section aria-label="Unresolved references">
          <h3 className={styles.sectionTitle}>Unresolved references</h3>
          <PlainText label="Unresolved references">{comp.unresolved.join('\n')}</PlainText>
        </section>
      ) : null}
      <div className={s.grid2}>
        <section aria-label="Source code" className={s.stackSm}>
          <h3 className={styles.sectionTitle}>Source</h3>
          <PlainText label={`Source code of ${d.name}`} lineNumbers>
            {d.source}
          </PlainText>
        </section>
        <section aria-label="Converted code" className={s.stackSm}>
          <h3 className={styles.sectionTitle}>Converted</h3>
          {d.converted ? (
            <PlainText label={`Converted code of ${d.name}`} lineNumbers>
              {d.converted}
            </PlainText>
          ) : (
            <p className={s.muted}>Not converted.</p>
          )}
        </section>
      </div>
      <div className={s.grid2}>
        <section aria-label="Rules applied">
          <h3 className={styles.sectionTitle}>Rules applied ({d.rules.length})</h3>
          {d.rules.length ? (
            <ul className={styles.plainList}>
              {d.rules.map((x) => (
                <li key={x} className={s.small}>
                  {x}
                </li>
              ))}
            </ul>
          ) : (
            <p className={s.muted}>None.</p>
          )}
        </section>
        <section aria-label="Warnings">
          <h3 className={styles.sectionTitle}>Warnings ({d.warnings.length})</h3>
          {d.warnings.length ? (
            <ul className={styles.plainList}>
              {d.warnings.map((x) => (
                <li key={x} className={s.small}>
                  {x}
                </li>
              ))}
            </ul>
          ) : (
            <p className={s.muted}>None.</p>
          )}
        </section>
      </div>
      <section aria-label="Test outcomes">
        <h3 className={styles.sectionTitle}>Recorded tests ({d.tests.length})</h3>
        {d.tests.length === 0 ? (
          <p className={s.muted}>
            {comp.ok === true
              ? 'No recorded tests for this object.'
              : 'Tests run only on objects that compile.'}
          </p>
        ) : (
          <ul className={styles.gapList}>
            {[...d.tests]
              .sort((a, b) => Number(a.passed) - Number(b.passed))
              .map((t) => (
                <TestOutcomeView key={t.test_id} t={t} />
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function TestOutcomeView({ t }: { t: TestOutcome }) {
  return (
    <li className={styles.gap} data-state={t.passed ? 'waived' : 'open-blocking'}>
      <span className={s.row}>
        <StatusPill tone={t.passed ? 'success' : 'danger'}>
          {t.passed ? 'Passed' : 'Failed'}
        </StatusPill>
        <strong>{t.name}</strong>
      </span>
      {t.error ? <span className={s.small}>Error: {t.error}</span> : null}
      {!t.passed ? (
        <div className={s.grid2} style={{ width: '100%' }}>
          <div>
            <h4 className={styles.sectionTitle}>Inputs</h4>
            <PlainText label={`Inputs of ${t.name}`}>{show(t.inputs)}</PlainText>
          </div>
          <div>
            <h4 className={styles.sectionTitle}>Differences</h4>
            {t.differences.length ? (
              <PlainText label={`Differences of ${t.name}`}>{t.differences.join('\n')}</PlainText>
            ) : (
              <p className={s.muted}>None listed.</p>
            )}
          </div>
        </div>
      ) : null}
      <KeyValueList
        items={[
          ...(t.passed
            ? [
                {
                  key: 'in',
                  label: 'Inputs',
                  value: <Mono className={s.xs}>{show(t.inputs)}</Mono>,
                },
              ]
            : []),
          {
            key: 'exp',
            label: 'Expected',
            value: <Mono className={s.xs}>{show(t.expected)}</Mono>,
          },
          { key: 'act', label: 'Actual', value: <Mono className={s.xs}>{show(t.actual)}</Mono> },
        ]}
      />
    </li>
  );
}
