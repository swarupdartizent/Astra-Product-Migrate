import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Download, GitCompare, Play, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSourceConnections } from '@/api/adapters';
import { saveBlob } from '@/api/client';
import { useBaselines } from '@/api/targets';
import type { Project } from '@/api/types';
import {
  upgradeKeys,
  useDeltaDifferences,
  useDeltaExport,
  useDeltaLists,
  useDeltaRuns,
  usePatternAdvice,
  useStartDelta,
} from '@/api/upgrade';
import { DELTA_GROUPS, ORIGINS, type DeltaDifference, type DeltaRun } from '@/api/upgrade-types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { FormError } from '@/app/FormError';
import { JobProgress } from '@/app/JobProgress';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { hasErrors, mergeFieldErrors, type FieldErrors } from '@/lib/forms';
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
  Skeleton,
  StatusPill,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import styles from '../discovery/Discovery.module.css';
import { runStatus } from '../discovery/model';
import {
  describeDifference,
  DIFF_PAGE,
  groupInfo,
  originInfo,
  parseObjectRef,
  patternLabel,
} from './model';

const ALL = '__all__';

export function DeltaTab({
  project,
  initialRun = null,
}: {
  project: Project;
  /** Open this run (an evidence link from the review workbench). */
  initialRun?: string | null;
}) {
  const runs = useDeltaRuns(project.id);
  const qc = useQueryClient();
  const canRun = project.permissions.includes('source:manage');
  const [starting, setStarting] = useState(false);
  const [selected, setSelected] = useState<string | null>(initialRun);
  const linkedMissing =
    initialRun !== null && runs.data !== undefined && !runs.data.some((r) => r.id === initialRun);
  const active = runs.data?.find((r) => r.status === 'queued' || r.status === 'running');
  const current = runs.data?.find((r) => r.id === selected) ?? runs.data?.[0] ?? null;

  return (
    <div className={s.stack}>
      <PatternAdviceCard project={project} />
      <Card aria-labelledby="delta-runs">
        <CardHeader
          titleId="delta-runs"
          title="Version delta"
          description="Compares every source object with the project's pinned target baseline and sorts it into unchanged, renamed or moved, changed behaviour, or removed in the target. The same inputs always give the same result and digest."
          actions={
            canRun ? (
              <Button
                variant="primary"
                leadingIcon={<Play aria-hidden="true" />}
                onClick={() => setStarting(true)}
                disabled={!!active}
              >
                Run version delta
              </Button>
            ) : null
          }
        />
        <CardBody className={s.stackSm}>
          {active?.job_id ? (
            <JobProgress
              jobId={active.job_id}
              title="Version delta"
              cancellable
              onFinished={() => void qc.invalidateQueries({ queryKey: upgradeKeys.all })}
            />
          ) : null}
          {linkedMissing ? (
            <Callout tone="warning">
              The linked version delta run is not among this project’s recent runs. The newest run
              is shown instead.
            </Callout>
          ) : null}
          {runs.isPending ? (
            <Skeleton height="4rem" />
          ) : runs.isError ? (
            <ApiErrorView
              error={runs.error}
              title="Could not load version delta runs"
              compact
              onRetry={() => void runs.refetch()}
            />
          ) : runs.data.length === 0 ? (
            <EmptyState
              compact
              icon={<GitCompare />}
              title="No version delta yet"
              body="Pin a target baseline on the Target baseline tab and pass a connection check on the tenant's Sources tab, then run the version delta."
            />
          ) : (
            <ul style={{ listStyle: 'none' }} className={s.stackSm} aria-label="Version delta runs">
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
                      {r.connection_name ?? 'Source'} against {r.baseline}
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
      {current ? <DeltaRunView run={current} /> : null}
      {starting ? <StartDeltaDialog project={project} onClose={() => setStarting(false)} /> : null}
    </div>
  );
}

function PatternAdviceCard({ project }: { project: Project }) {
  const q = usePatternAdvice(project.id);
  return (
    <Card aria-labelledby="delta-advice">
      <CardHeader
        titleId="delta-advice"
        title="Migration pattern: the planner's view"
        description="The pattern the blueprint chose, next to the one the newest successful version delta supports."
      />
      <CardBody className={s.stackSm}>
        {q.isPending ? (
          <Skeleton height="4rem" />
        ) : q.isError ? (
          <ApiErrorView error={q.error} title="Could not load the advice" compact />
        ) : (
          <>
            <KeyValueList
              items={[
                { key: 'chosen', label: 'Blueprint pattern', value: patternLabel(q.data.chosen) },
                {
                  key: 'rec',
                  label: 'Supported by the delta',
                  value: q.data.recommended ? patternLabel(q.data.recommended) : null,
                },
              ]}
            />
            {q.data.agrees === false ? (
              <Callout tone="warning" title="The evidence points to another pattern">
                A proposal went to the{' '}
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: project.id }}
                  search={{ tab: 'reviews' }}
                >
                  review queue
                </Link>{' '}
                for a person to keep the blueprint's pattern or change it.
              </Callout>
            ) : q.data.agrees === true ? (
              <Callout tone="success">The version delta supports the blueprint's pattern.</Callout>
            ) : null}
            <ul className={styles.plainList} aria-label="Reasons">
              {q.data.reasons.map((r) => (
                <li key={r} className={s.small}>
                  {r}
                </li>
              ))}
            </ul>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function StartDeltaDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const conns = useSourceConnections(project.tenant_id);
  const start = useStartDelta(project.id);
  const [connectionId, setConnectionId] = useState('');
  const [standard, setStandard] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const conn = conns.data?.find((c) => c.id === connectionId);
  const adapterName = conn ? (conn.adapter.split('@')[0] ?? '') : '';
  const baselines = useBaselines(adapterName);
  const standards = adapterName ? (baselines.data ?? []) : [];
  const client: FieldErrors<'connection_id' | 'standard_baseline_id'> = {};
  if (!connectionId) client.connection_id = 'Choose a source connection.';
  const errors = mergeFieldErrors(client, start.error, submitted);
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Run the version delta"
      description="Runs in the background against the project's pinned target baseline."
      submitLabel="Start version delta"
      pending={start.isPending}
      error={start.error}
      fields={['connection_id', 'standard_baseline_id']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(client)) return;
        start.mutate(
          { connection_id: connectionId, ...(standard ? { standard_baseline_id: standard } : {}) },
          {
            onSuccess: () => {
              toast.info('Version delta started');
              onClose();
            },
          },
        );
      }}
    >
      <Field
        label="Source connection"
        error={errors.connection_id}
        help="Only connections whose read-only check passed can be used."
        required
      >
        <Select
          options={(conns.data ?? []).map((c) => ({
            value: c.id,
            label: `${c.name} (${c.adapter})${c.last_check?.status === 'succeeded' ? '' : ' · not checked'}`,
          }))}
          value={connectionId}
          onValueChange={(v) => {
            setConnectionId(v);
            setStandard('');
          }}
          placeholder={conns.isPending ? 'Loading…' : 'Choose a connection'}
        />
      </Field>
      <Field
        label="Standard baseline of the source product (optional)"
        error={errors.standard_baseline_id}
        help="The source product's standard objects for the customer's version. With it, each object is marked standard, customized standard or customer-specific. Without it, the origin is reported as unknown unless the adapter's naming rules say an object is customer-specific."
      >
        <Select
          options={[
            { value: ALL, label: 'None' },
            ...standards.map((b) => ({
              value: b.id,
              label: `${b.name} (${b.product_version})${b.synthetic ? ' · synthetic' : ''}`,
            })),
          ]}
          value={standard || ALL}
          onValueChange={(v) => setStandard(v === ALL ? '' : v)}
          disabled={!adapterName}
          placeholder={adapterName ? 'None' : 'Choose a connection first'}
        />
      </Field>
      {adapterName && baselines.data && standards.length === 0 ? (
        <p className={`${s.muted} ${s.small}`}>
          No baseline is registered for <Mono>{adapterName}</Mono>. Add one on the Baselines page to
          tell standard objects from customized ones.
        </p>
      ) : null}
    </FormDialog>
  );
}

function DeltaRunView({ run: r }: { run: DeltaRun }) {
  const done = r.status === 'succeeded';
  const exp = useDeltaExport(r.id);
  const st = runStatus(r.status);
  return (
    <Card aria-labelledby={`delta-${r.id}`}>
      <CardHeader
        titleId={`delta-${r.id}`}
        title={`${r.connection_name ?? 'Source'} against ${r.baseline}`}
        description={
          r.standard_baseline
            ? `Origins compared with the standard baseline ${r.standard_baseline}.`
            : 'No standard baseline was given.'
        }
        actions={
          done ? (
            <span className={s.row}>
              {(['csv', 'json'] as const).map((f) => (
                <Button
                  key={f}
                  size="sm"
                  leadingIcon={<Download aria-hidden="true" />}
                  loading={exp.isPending && exp.variables === f}
                  onClick={() =>
                    exp.mutate(f, {
                      onSuccess: (res) => saveBlob(res),
                    })
                  }
                >
                  Download {f.toUpperCase()}
                </Button>
              ))}
            </span>
          ) : (
            <StatusPill tone={st.tone}>{st.label}</StatusPill>
          )
        }
      />
      <CardBody className={s.stack}>
        <FormError error={exp.error} />
        {r.status === 'blocked' ? (
          <Callout tone="warning" title="Blocked">
            {r.status_detail ?? 'The version delta could not start.'}
          </Callout>
        ) : r.status_detail ? (
          <Callout
            tone={done ? 'warning' : 'danger'}
            title={done ? 'Read with problems' : st.label}
          >
            {r.status_detail}
          </Callout>
        ) : null}
        {done ? <DeltaResult run={r} /> : null}
      </CardBody>
    </Card>
  );
}

function DeltaResult({ run: r }: { run: DeltaRun }) {
  const lists = useDeltaLists(r.id);
  return (
    <>
      <section aria-labelledby={`groups-${r.id}`}>
        <h3 id={`groups-${r.id}`} className={styles.sectionTitle}>
          Groups
        </h3>
        <dl className={styles.metrics}>
          {DELTA_GROUPS.map((g) => (
            <div key={g} className={styles.metric} title={groupInfo(g).meaning}>
              <dt className={styles.metricLabel}>{groupInfo(g).label}</dt>
              <dd className={styles.metricValue}>{(r.counts[g] ?? 0).toLocaleString()}</dd>
            </div>
          ))}
          <div className={styles.metric}>
            <dt className={styles.metricLabel}>Not in scope</dt>
            <dd className={styles.metricValue}>{r.not_in_scope.toLocaleString()}</dd>
          </div>
          <div className={styles.metric}>
            <dt className={styles.metricLabel}>New in target</dt>
            <dd className={styles.metricValue}>{r.new_in_target.toLocaleString()}</dd>
          </div>
        </dl>
      </section>
      <section aria-labelledby={`origins-${r.id}`}>
        <h3 id={`origins-${r.id}`} className={styles.sectionTitle}>
          Origin
        </h3>
        <KeyValueList
          items={ORIGINS.map((o) => ({
            key: o,
            label: `${originInfo(o).label}: ${(r.origin_counts[o] ?? 0).toLocaleString()}`,
            value: originInfo(o).meaning,
          }))}
        />
      </section>
      <KeyValueList
        items={[
          {
            key: 'in',
            label: 'Input digest',
            value: r.input_digest ? <Mono className={s.xs}>{r.input_digest}</Mono> : null,
          },
          {
            key: 'out',
            label: 'Result digest',
            value: r.result_digest ? <Mono className={s.xs}>{r.result_digest}</Mono> : null,
          },
        ]}
      />
      <DifferencesTable runId={r.id} />
      {lists.isError ? (
        <ApiErrorView error={lists.error} title="Could not load the lists" compact />
      ) : lists.data ? (
        <div className={s.stackSm}>
          {lists.data.problems.length > 0 ? (
            <Callout tone="warning" title="Problems reading the source">
              <ul className={styles.plainList}>
                {lists.data.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Callout>
          ) : null}
          <RefList
            title={`Not in scope (${String(lists.data.not_in_scope.length)})`}
            help="The target baseline does not describe these object types, so they are listed rather than compared or guessed."
            refs={lists.data.not_in_scope}
          />
          <RefList
            title={`New in target (${String(lists.data.new_in_target.length)})`}
            help="Target objects with no source counterpart."
            refs={lists.data.new_in_target}
          />
        </div>
      ) : (
        <Skeleton height="3rem" />
      )}
    </>
  );
}

function RefList({ title, help, refs }: { title: string; help: string; refs: string[] }) {
  return (
    <details>
      <summary className={s.cellPrimary}>{title}</summary>
      <p className={`${s.muted} ${s.small}`}>{help}</p>
      {refs.length ? (
        <PlainText label={title}>
          {refs
            .map(parseObjectRef)
            .map((x) => `${x.type.padEnd(18)} ${x.name}`)
            .join('\n')}
        </PlainText>
      ) : (
        <p className={s.muted}>None.</p>
      )}
    </details>
  );
}

function DifferencesTable({ runId }: { runId: string }) {
  const [group, setGroup] = useState('');
  const [origin, setOrigin] = useState('');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q.trim(), 300);
  const dtype = useDebouncedValue(type.trim(), 300);
  const [offset, setOffset] = useState(0);
  const query = {
    ...(group ? { group } : {}),
    ...(origin ? { origin } : {}),
    ...(dtype ? { type: dtype } : {}),
    ...(dq ? { q: dq } : {}),
    offset,
    limit: DIFF_PAGE,
  };
  const diffs = useDeltaDifferences(runId, query);
  const columns = useMemo(() => {
    const col = createDataTableColumns<DeltaDifference>();
    return col.columns([
      col.accessor('group', {
        header: 'Group',
        size: 150,
        cell: (info) => (
          <Badge tone={groupInfo(info.getValue()).tone}>{groupInfo(info.getValue()).label}</Badge>
        ),
      }),
      col.accessor('type', { header: 'Type', size: 110 }),
      col.accessor('source', {
        header: 'Source',
        size: 200,
        cell: (info) => <Mono className={s.small}>{info.getValue()}</Mono>,
      }),
      col.accessor((d) => d.target ?? '', {
        id: 'target',
        header: 'Target',
        size: 200,
        cell: (info) =>
          info.row.original.target ? (
            <Mono className={s.small}>{info.row.original.target}</Mono>
          ) : (
            '—'
          ),
      }),
      col.accessor('origin', {
        header: 'Origin',
        size: 150,
        cell: (info) => (
          <Badge tone={originInfo(info.getValue()).tone}>{originInfo(info.getValue()).label}</Badge>
        ),
      }),
      col.display({
        id: 'details',
        header: 'Details',
        size: 320,
        cell: (info) => (
          <span className={s.xs} style={{ whiteSpace: 'normal' }}>
            {describeDifference(info.row.original).join(' ') || '—'}
          </span>
        ),
      }),
    ]);
  }, []);
  const reset = (fn: () => void) => {
    fn();
    setOffset(0);
  };
  const total = diffs.data?.total ?? 0;
  return (
    <section aria-labelledby={`diffs-${runId}`}>
      <h3 id={`diffs-${runId}`} className={styles.sectionTitle}>
        Differences
      </h3>
      <div className={s.filters} style={{ marginBottom: 'var(--space-2)' }}>
        <Field label="Group">
          <Select
            size="sm"
            options={[
              { value: ALL, label: 'All groups' },
              ...DELTA_GROUPS.map((g) => ({ value: g, label: groupInfo(g).label })),
            ]}
            value={group || ALL}
            onValueChange={(v) => reset(() => setGroup(v === ALL ? '' : v))}
          />
        </Field>
        <Field label="Origin">
          <Select
            size="sm"
            options={[
              { value: ALL, label: 'All origins' },
              ...ORIGINS.map((o) => ({ value: o, label: originInfo(o).label })),
            ]}
            value={origin || ALL}
            onValueChange={(v) => reset(() => setOrigin(v === ALL ? '' : v))}
          />
        </Field>
        <Field label="Object type">
          <Input
            size="sm"
            placeholder="for example table"
            value={type}
            onChange={(e) => reset(() => setType(e.target.value))}
          />
        </Field>
        <Field label="Name contains">
          <Input
            size="sm"
            type="search"
            startAdornment={<Search />}
            value={q}
            onChange={(e) => reset(() => setQ(e.target.value))}
          />
        </Field>
      </div>
      {diffs.isError ? (
        <ApiErrorView
          error={diffs.error}
          title="Could not load differences"
          compact
          onRetry={() => void diffs.refetch()}
        />
      ) : (
        <DataTable
          label="Version delta differences"
          data={diffs.data?.items}
          columns={columns}
          getRowId={(d) => `${d.group}:${d.type}:${d.source}`}
          loading={diffs.isPending}
          maxHeight="32rem"
          empty={<EmptyState compact title="No differences match" />}
        />
      )}
      <div className={s.toolbar} style={{ justifyContent: 'space-between' }}>
        <span className={`${s.muted} ${s.small}`} aria-live="polite">
          {total === 0
            ? 'No rows'
            : `${String(offset + 1)}–${String(Math.min(offset + DIFF_PAGE, total))} of ${total.toLocaleString()}`}
        </span>
        <span className={s.row}>
          <Button
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - DIFF_PAGE))}
          >
            Previous
          </Button>
          <Button
            size="sm"
            disabled={offset + DIFF_PAGE >= total}
            onClick={() => setOffset(offset + DIFF_PAGE)}
          >
            Next
          </Button>
        </span>
      </div>
    </section>
  );
}
