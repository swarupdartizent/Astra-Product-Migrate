import { useNavigate } from '@tanstack/react-router';
import { FlaskConical, Play } from 'lucide-react';
import { useMemo, useState } from 'react';
import { usePublishedPacks } from '@/api/packs';
import {
  targetKeys,
  useGoldenDatasets,
  useGoldenFiles,
  useGoldenRun,
  useGoldenRuns,
  useStartGoldenRun,
} from '@/api/targets';
import type { GoldenDataset, GoldenMeasure, GoldenRun } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { JobProgress } from '@/app/JobProgress';
import { usePermissions } from '@/app/permissions';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CheckboxGroup,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Field,
  Mono,
  PageHeader,
  PlainText,
  Skeleton,
  StatusPill,
  Switch,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import { packRef } from '../packs/model';
import {
  formatRatio,
  formatValue,
  goldenStatus,
  orderMeasures,
  parseDataset,
  sectionTitle,
} from './model';

export function GoldenPage({ dataset }: { dataset: string | null }) {
  useDocumentTitle('Golden datasets');
  const datasets = useGoldenDatasets();
  const navigate = useNavigate();
  const selected = datasets.data?.find((d) => d.dataset === dataset) ?? null;
  const columns = useMemo(() => {
    const col = createDataTableColumns<GoldenDataset>();
    return col.columns([
      col.accessor('name', {
        header: 'Dataset',
        size: 260,
        cell: (info) => (
          <span className={s.cellStack} style={{ whiteSpace: 'normal' }}>
            <span className={s.cellPrimary}>{info.getValue()}</span>
            <Mono className={`${s.muted} ${s.xs}`}>{info.row.original.adapter}</Mono>
            {info.row.original.description ? (
              <span className={`${s.muted} ${s.xs}`}>{info.row.original.description}</span>
            ) : null}
          </span>
        ),
      }),
      col.accessor('engine', { header: 'Engine', size: 110, meta: { mono: true } }),
      col.accessor('adapter_status', { header: 'Adapter', size: 110 }),
      col.display({
        id: 'last',
        header: 'Last run',
        size: 200,
        cell: (info) => {
          const r = info.row.original.last_run;
          if (!r) return <span className={s.muted}>Never run</span>;
          const st = goldenStatus(r.status);
          return (
            <span className={s.row}>
              <StatusPill tone={st.tone}>{st.label}</StatusPill>
              <Timestamp value={r.started_at} />
            </span>
          );
        },
      }),
    ]);
  }, []);

  return (
    <>
      <PageHeader
        title="Golden datasets"
        description="Synthetic estates shipped with source adapters, with known answers. A golden run builds the estate on a test engine, proves the adapter's login is read-only, and scores every operation against the expected answers. These are test assets, never customer data."
      />
      <div className={s.stack}>
        <Card flush aria-label="Golden datasets">
          <CardBody>
            {datasets.isError ? (
              <ApiErrorView
                error={datasets.error}
                title="Could not load golden datasets"
                onRetry={() => void datasets.refetch()}
              />
            ) : (
              <DataTable
                label="Golden datasets"
                data={datasets.data}
                columns={columns}
                getRowId={(d) => d.dataset}
                loading={datasets.isPending}
                onRowClick={(d) =>
                  void navigate({ to: '/golden', search: { dataset: d.dataset }, replace: true })
                }
                empty={
                  <EmptyState
                    compact
                    icon={<FlaskConical />}
                    title="No golden datasets"
                    body="Source adapter packs ship them."
                  />
                }
              />
            )}
          </CardBody>
        </Card>
        {selected ? <DatasetPanel key={selected.dataset} dataset={selected} /> : null}
      </div>
    </>
  );
}

function DatasetPanel({ dataset }: { dataset: GoldenDataset }) {
  const parts = parseDataset(dataset.dataset);
  const files = useGoldenFiles(
    parts?.adapter ?? '',
    parts?.version ?? '',
    parts?.name ?? '',
    parts !== null,
  );
  const runs = useGoldenRuns(dataset.dataset);
  const { can } = usePermissions();
  const [running, setRunning] = useState(false);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const runId = selectedRun ?? runs.data?.[0]?.id ?? null;
  const expected = files.data?.expected ?? null;

  return (
    <div className={s.stack}>
      <Card aria-labelledby="golden-expected">
        <CardHeader
          titleId="golden-expected"
          title={`Expected answers: ${dataset.name}`}
          description={
            typeof files.data?.dataset.description === 'string'
              ? files.data.dataset.description
              : dataset.description || undefined
          }
          actions={
            can('golden:run') ? (
              <Button
                variant="primary"
                leadingIcon={<Play aria-hidden="true" />}
                onClick={() => setRunning(true)}
              >
                Run dataset
              </Button>
            ) : null
          }
        />
        <CardBody className={s.stackSm}>
          {files.isPending ? (
            <Skeleton height="8rem" />
          ) : files.isError ? (
            <ApiErrorView
              error={files.error}
              title="Could not load the expected answers"
              compact
              onRetry={() => void files.refetch()}
            />
          ) : expected && Object.keys(expected).length > 0 ? (
            Object.entries(expected).map(([key, value]) => (
              <section key={key} aria-label={sectionTitle(key)}>
                <h3 className={s.cellPrimary} style={{ marginBottom: 'var(--space-1)' }}>
                  {sectionTitle(key)}
                </h3>
                <PlainText label={`Expected ${sectionTitle(key)}`}>{formatValue(value)}</PlainText>
              </section>
            ))
          ) : (
            <p className={s.muted}>This dataset has no expected answers file.</p>
          )}
          {files.data ? (
            <p className={`${s.muted} ${s.xs}`}>Files: {files.data.files.join(', ')}</p>
          ) : null}
        </CardBody>
      </Card>
      <Card aria-labelledby="golden-runs">
        <CardHeader titleId="golden-runs" title="Runs" />
        <CardBody className={s.stackSm}>
          {runs.isPending ? (
            <Skeleton height="4rem" />
          ) : runs.isError ? (
            <ApiErrorView
              error={runs.error}
              title="Could not load runs"
              compact
              onRetry={() => void runs.refetch()}
            />
          ) : runs.data.length === 0 ? (
            <EmptyState compact title="Never run" />
          ) : (
            <ul style={{ listStyle: 'none' }} className={s.badges} aria-label="Run history">
              {runs.data.map((r) => {
                const st = goldenStatus(r.status);
                return (
                  <li key={r.id}>
                    <Button
                      size="sm"
                      variant={r.id === runId ? 'secondary' : 'ghost'}
                      aria-pressed={r.id === runId}
                      onClick={() => setSelectedRun(r.id)}
                    >
                      <StatusPill tone={st.tone}>{st.label}</StatusPill>
                      <Timestamp value={r.started_at} />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>
      {runId ? <RunView runId={runId} /> : null}
      {running ? (
        <RunDialog
          dataset={dataset}
          onClose={() => setRunning(false)}
          onStarted={(id) => {
            setRunning(false);
            setSelectedRun(id);
          }}
        />
      ) : null}
    </div>
  );
}

function RunView({ runId }: { runId: string }) {
  const run = useGoldenRun(runId);
  const qc = useQueryClient();
  if (run.isPending) return <Skeleton height="10rem" />;
  if (run.isError)
    return (
      <ApiErrorView
        error={run.error}
        title="Could not load the run"
        onRetry={() => void run.refetch()}
      />
    );
  const r = run.data;
  const st = goldenStatus(r.status);
  return (
    <Card aria-labelledby="golden-run">
      <CardHeader
        titleId="golden-run"
        title="Scorecard"
        description={
          <>
            Started <Timestamp value={r.started_at} />
            {r.started_by ? ` by ${r.started_by}` : ''} · packs {Object.keys(r.packs).join(', ')}
            {r.keep ? ' · estate kept as a demonstration source' : ''}
          </>
        }
        actions={<StatusPill tone={st.tone}>{st.label}</StatusPill>}
      />
      <CardBody className={s.stackSm}>
        {r.job_id && (r.status === 'queued' || r.status === 'running') ? (
          <JobProgress
            jobId={r.job_id}
            title="Golden run"
            compact
            onFinished={() => void qc.invalidateQueries({ queryKey: targetKeys.all })}
          />
        ) : null}
        {r.status === 'blocked' ? (
          <Callout tone="warning" title="Blocked">
            {r.status_detail ?? 'The run could not start.'}
          </Callout>
        ) : r.status_detail ? (
          <Callout tone={r.status === 'passed' ? 'success' : 'danger'} title={st.label}>
            {r.status_detail}
          </Callout>
        ) : null}
        {r.scorecard ? (
          <Scorecard measures={r.scorecard.measures} database={r.scorecard.database} />
        ) : null}
      </CardBody>
    </Card>
  );
}

export function Scorecard({ measures, database }: { measures: GoldenMeasure[]; database: string }) {
  const ordered = useMemo(() => orderMeasures(measures), [measures]);
  const failed = measures.filter((m) => !m.passed).length;
  const columns = useMemo(() => {
    const col = createDataTableColumns<GoldenMeasure>();
    const wrap = { whiteSpace: 'normal' } as const;
    return col.columns([
      col.accessor('name', {
        header: 'Measure',
        size: 220,
        cell: (info) => <span style={wrap}>{info.getValue()}</span>,
      }),
      col.accessor('passed', {
        header: 'Result',
        size: 100,
        cell: (info) => (
          <StatusPill tone={info.getValue() ? 'success' : 'danger'}>
            {info.getValue() ? 'Pass' : 'Fail'}
          </StatusPill>
        ),
      }),
      col.display({
        id: 'expected',
        header: 'Expected',
        size: 200,
        cell: (info) => <PlainText>{formatValue(info.row.original.expected)}</PlainText>,
      }),
      col.display({
        id: 'actual',
        header: 'Actual',
        size: 200,
        cell: (info) => <PlainText>{formatValue(info.row.original.actual)}</PlainText>,
      }),
      col.display({
        id: 'pr',
        header: 'Precision / recall',
        size: 140,
        cell: (info) =>
          info.row.original.precision === null && info.row.original.recall === null
            ? '—'
            : `${formatRatio(info.row.original.precision)} / ${formatRatio(info.row.original.recall)}`,
      }),
      col.accessor('detail', {
        header: 'Detail',
        size: 260,
        cell: (info) => <span style={wrap}>{info.getValue() || '—'}</span>,
      }),
    ]);
  }, []);
  return (
    <div className={s.stackSm}>
      <p className={s.small}>
        {measures.length - failed} of {measures.length} measures passed on <Mono>{database}</Mono>.
      </p>
      <DataTable
        label="Golden run scorecard"
        data={ordered}
        columns={columns}
        getRowId={(m) => m.name}
      />
    </div>
  );
}

function RunDialog({
  dataset,
  onClose,
  onStarted,
}: {
  dataset: GoldenDataset;
  onClose: () => void;
  onStarted: (id: string) => void;
}) {
  const packs = usePublishedPacks();
  const start = useStartGoldenRun();
  const [chosen, setChosen] = useState<string[]>([]);
  const [keep, setKeep] = useState(false);
  const domain = (packs.data ?? []).filter((p) => p.type === 'domain');
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Run ${dataset.name}`}
      description="Builds the synthetic estate on the test engine, runs every adapter operation against it, and scores the results. It needs a SQL Server administrator configured for the test engine; without one the run is Blocked."
      submitLabel="Start run"
      pending={start.isPending}
      error={start.error}
      fields={['packs', 'dataset', 'keep']}
      onSubmit={() =>
        start.mutate(
          { dataset: dataset.dataset, packs: chosen, keep },
          {
            onSuccess: (r: GoldenRun) => {
              toast.info('Golden run started');
              onStarted(r.id);
            },
          },
        )
      }
    >
      <CheckboxGroup
        legend="Domain packs whose rules are checked"
        help="Their executable rules must find the violations seeded in the dataset."
        options={domain.map((p) => ({
          value: packRef(p),
          label: p.title,
          description: packRef(p),
        }))}
        value={chosen}
        onValueChange={setChosen}
        maxHeight="12rem"
        emptyText={packs.isPending ? 'Loading packs…' : 'No published domain packs.'}
      />
      <Field label="Keep the estate afterwards as a demonstration source" inline>
        <Switch checked={keep} onCheckedChange={setKeep} />
      </Field>
    </FormDialog>
  );
}
