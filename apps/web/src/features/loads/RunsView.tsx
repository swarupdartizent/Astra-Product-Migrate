import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Play, Repeat } from 'lucide-react';
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { useAdapterRuns, useSourceConnections } from '@/api/adapters';
import { isApiError } from '@/api/errors';
import { loadKeys, useLoadRun, useStartLoadRun } from '@/api/loads';
import { START_KINDS, type LoadRun, type LoadRunDetail, type StartKind } from '@/api/loads-types';
import { useTargetConnections } from '@/api/targets';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { JobProgress } from '@/app/JobProgress';
import { formatAbsolute } from '@/lib/time';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  KeyValueList,
  Mono,
  RadioCards,
  Select,
  Skeleton,
  StatusPill,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import styles from './Loads.module.css';
import {
  acceptedOf,
  decimalDiff,
  failedOf,
  formatAmount,
  formatDifference,
  formatPercent,
  isRunActive,
  isZero,
  KIND_HELP,
  KIND_LABELS,
  kindLabel,
  recordStatus,
  runStatus,
  splitValues,
  startErrors,
  type LoadsSection,
  type StartForm,
} from './model';
import { DiffMark, Why } from './Parts';

type LinkFn = (section: LoadsSection, run: string | null, children: ReactNode) => ReactNode;

/** "Same result as run 2" or "Different result from run 2", or nothing for a first run. */
export function RepeatBadge({ run }: { run: Pick<LoadRun, 'summary'> }) {
  const r = run.summary.repeat_of;
  if (!r) return null;
  return r.same_result ? (
    <Badge tone="success" icon={<Repeat aria-hidden="true" />}>
      Same result as run {r.run}
    </Badge>
  ) : (
    <Badge tone="danger" icon={<Repeat aria-hidden="true" />}>
      Different result from run {r.run}
    </Badge>
  );
}

/**
 * Load runs (E13.F1): start a rehearsal, load or delta load with the approved code, packs and
 * extract pinned; list the numbered runs; show a run's pinned inputs, reconciliation to the
 * cent, data quality before and after, and why records were blocked.
 */
export function RunsView({
  project,
  runs,
  selected,
  onSelect,
  link,
}: {
  project: Project;
  runs: UseQueryResult<LoadRun[]>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  link: LinkFn;
}) {
  const [open, setOpen] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const canStart = project.permissions.includes('stage:manage');
  const active = (runs.data ?? []).find((r) => isRunActive(r.status));
  const why = !canStart
    ? 'Starting a run needs stage management on this project.'
    : active
      ? `Run ${String(active.number)} is still in progress; one run at a time.`
      : null;
  const select = (id: string) => {
    onSelect(id);
    window.setTimeout(() => headingRef.current?.focus(), 0);
  };
  return (
    <div className={s.stack}>
      <Card aria-labelledby="loads-head">
        <CardHeader
          titleId="loads-head"
          title="Load runs"
          description="Every run is numbered and pins the approved transformation code, the pack versions, the extract and the segment. A rerun with the same inputs shows whether it gave the same result."
          actions={
            <Button
              variant="primary"
              leadingIcon={<Play aria-hidden="true" />}
              disabled={!!why}
              aria-describedby={why ? 'start-load-why' : undefined}
              onClick={() => setOpen(true)}
            >
              Start a run
            </Button>
          }
        />
        {why ? (
          <CardBody>
            <Why id="start-load-why">{why}</Why>
          </CardBody>
        ) : null}
      </Card>
      <div className={styles.layout}>
        <Card flush aria-labelledby="runs-list-head">
          <CardHeader titleId="runs-list-head" title="Runs" />
          <div className={styles.bar}>
            <span className={s.muted} aria-live="polite">
              {runs.data ? `${runs.data.length.toLocaleString()} run(s)` : 'Loading…'}
            </span>
          </div>
          {runs.isError ? (
            <div style={{ padding: 'var(--space-4)' }}>
              <ApiErrorView
                error={runs.error}
                title="Could not load the runs"
                compact
                onRetry={() => void runs.refetch()}
              />
            </div>
          ) : runs.isPending ? (
            <div style={{ padding: 'var(--space-4)' }} className={s.stackSm}>
              <Skeleton height="3.5rem" />
              <Skeleton height="3.5rem" />
            </div>
          ) : runs.data.length === 0 ? (
            <EmptyState
              compact
              title="No load runs"
              body="Approve transformation code, extract the source, then start a rehearsal."
            />
          ) : (
            <ul className={styles.list} aria-label="Load runs" aria-busy={runs.isFetching}>
              {runs.data.map((r) => (
                <RunRow
                  key={r.id}
                  run={r}
                  current={r.id === selected}
                  onSelect={() => select(r.id)}
                />
              ))}
            </ul>
          )}
        </Card>
        <RunPanel
          key={selected ?? ''}
          project={project}
          id={selected}
          headingRef={headingRef}
          link={link}
        />
      </div>
      {open ? (
        <StartLoadDialog
          project={project}
          onClose={() => setOpen(false)}
          onStarted={(r) => {
            setOpen(false);
            select(r.id);
          }}
        />
      ) : null}
    </div>
  );
}

function RunRow({
  run: r,
  current,
  onSelect,
}: {
  run: LoadRun;
  current: boolean;
  onSelect: () => void;
}) {
  const st = runStatus(r.status);
  const counts = r.summary.counts;
  const failed = failedOf(counts);
  const breaks = r.summary.breaks ?? 0;
  return (
    <li className={styles.row}>
      <button
        type="button"
        className={styles.rowButton}
        aria-current={current ? 'true' : undefined}
        onClick={onSelect}
      >
        <span className={styles.rowTitle}>
          Run {r.number} · {kindLabel(r.kind)}
        </span>
        <span className={s.badges}>
          <StatusPill tone={st.tone} pulse={r.status === 'running'}>
            {st.label}
          </StatusPill>
          <RepeatBadge run={r} />
          {breaks > 0 ? <Badge tone="warning">{breaks} break(s)</Badge> : null}
        </span>
        <span className={styles.rowMeta}>
          {counts ? (
            <>
              <span>{acceptedOf(counts).toLocaleString()} accepted</span>
              <span>{failed.toLocaleString()} failed</span>
            </>
          ) : (
            <span>No counts yet</span>
          )}
          {r.segment ? (
            <span>
              Segment {r.segment.column}: {r.segment.values.join(', ')}
            </span>
          ) : null}
          {r.created_at ? <Timestamp value={r.created_at} /> : null}
        </span>
      </button>
    </li>
  );
}

function RunPanel({
  project,
  id,
  headingRef,
  link,
}: {
  project: Project;
  id: string | null;
  headingRef: RefObject<HTMLHeadingElement | null>;
  link: LinkFn;
}) {
  const q = useLoadRun(project.id, id);
  const r = q.data;
  const st = r ? runStatus(r.status) : null;
  return (
    <Card aria-labelledby="run-detail-head">
      <CardHeader
        titleId="run-detail-head"
        title={
          <span ref={headingRef} tabIndex={-1} className={styles.panelHeading}>
            {id === null
              ? 'Run detail'
              : r
                ? `Run ${String(r.number)}: ${kindLabel(r.kind).toLowerCase()}`
                : 'Loading the run…'}
          </span>
        }
        description={
          r && st ? (
            <span className={s.badges}>
              <StatusPill tone={st.tone}>{st.label}</StatusPill>
              <RepeatBadge run={r} />
            </span>
          ) : undefined
        }
      />
      <CardBody className={s.stack}>
        {id === null ? (
          <EmptyState
            compact
            title="Select a run"
            body="Choose a run to see its pinned inputs, reconciliation, data quality and errors."
          />
        ) : q.isPending ? (
          <Skeleton height="18rem" />
        ) : q.isError ? (
          <ApiErrorView
            error={q.error}
            title="Could not load the run"
            compact
            onRetry={() => void q.refetch()}
          />
        ) : (
          <RunBody project={project} run={q.data} link={link} />
        )}
      </CardBody>
    </Card>
  );
}

function RunBody({
  project,
  run: r,
  link,
}: {
  project: Project;
  run: LoadRunDetail;
  link: LinkFn;
}) {
  const qc = useQueryClient();
  const targets = useTargetConnections(project.tenant_id);
  const target = targets.data?.find((t) => t.id === r.target_connection_id);
  const failed = failedOf(r.summary.counts);
  return (
    <>
      {isRunActive(r.status) && r.job_id ? (
        <JobProgress
          jobId={r.job_id}
          title={`Run ${String(r.number)}`}
          onFinished={() => void qc.invalidateQueries({ queryKey: loadKeys.project(project.id) })}
        />
      ) : null}
      {r.status_detail ? (
        <Callout
          tone={r.status === 'succeeded' ? 'warning' : 'danger'}
          title={r.status === 'succeeded' ? 'Finished with problems' : `The run ${r.status}`}
        >
          {r.status_detail}
        </Callout>
      ) : null}
      {r.summary.repeat_of ? (
        <Callout
          tone={r.summary.repeat_of.same_result ? 'success' : 'danger'}
          title={
            r.summary.repeat_of.same_result
              ? `Repeatable: same inputs and same result as run ${String(r.summary.repeat_of.run)}`
              : `Same inputs as run ${String(r.summary.repeat_of.run)}, but a different result`
          }
        >
          {r.summary.repeat_of.same_result
            ? 'The input and result digests match the earlier run.'
            : 'The input digest matches but the result digest does not: the target or the data answered differently. Compare the two runs before loading again.'}
        </Callout>
      ) : null}
      <div className={s.row}>
        {link('errors', r.id, <>Error queue ({failed.toLocaleString()} failed)</>)}
        <span aria-hidden="true">·</span>
        {link('documents', r.id, 'Document checks')}
        <span aria-hidden="true">·</span>
        {link('breaks', r.id, <>Breaks ({(r.summary.breaks ?? 0).toLocaleString()})</>)}
      </div>
      <PinnedInputs run={r} targetName={target?.name ?? null} />
      <Reconciliation run={r} />
      <Measures run={r} />
      <Quality run={r} />
      <Problems run={r} />
    </>
  );
}

function PinnedInputs({ run: r, targetName }: { run: LoadRunDetail; targetName: string | null }) {
  return (
    <section className={styles.section} aria-labelledby="run-inputs">
      <h3 id="run-inputs" className={styles.sectionTitle}>
        Pinned inputs
      </h3>
      <KeyValueList
        items={[
          {
            key: 'by',
            label: 'Requested',
            value: (
              <>
                {r.requested_by ?? 'unknown'}
                {r.created_at ? (
                  <>
                    {' '}
                    <Timestamp value={r.created_at} />
                  </>
                ) : null}
              </>
            ),
          },
          {
            key: 'fin',
            label: 'Finished',
            value: r.finished_at ? <Timestamp value={r.finished_at} /> : 'Not yet',
          },
          {
            key: 'ex',
            label: 'Extract run',
            value: r.extract_run_id ? <Mono className={s.xs}>{r.extract_run_id}</Mono> : 'None',
          },
          {
            key: 'tc',
            label: 'Target connection',
            value: r.target_connection_id
              ? (targetName ?? <Mono className={s.xs}>{r.target_connection_id}</Mono>)
              : 'None: nothing is sent',
          },
          {
            key: 'seg',
            label: 'Segment',
            value: r.segment ? `${r.segment.column} in ${r.segment.values.join(', ')}` : 'All rows',
          },
          {
            key: 'in',
            label: 'Input digest',
            value: <Mono className={s.xs}>{r.input_digest}</Mono>,
          },
          {
            key: 'out',
            label: 'Result digest',
            value: r.result_digest ? (
              <Mono className={s.xs}>{r.result_digest}</Mono>
            ) : (
              'Not finished'
            ),
          },
          {
            key: 'packs',
            label: 'Packs',
            value: (
              <span className={s.cellStack}>
                <span>
                  Source adapter <Mono className={s.xs}>{r.packs.source ?? '—'}</Mono>, target
                  adapter <Mono className={s.xs}>{r.packs.target ?? '—'}</Mono>
                </span>
                <span>
                  {r.packs.blueprint.length ? (
                    r.packs.blueprint.map((p, i) => (
                      <span key={p}>
                        {i ? ', ' : ''}
                        <Mono className={s.xs}>{p}</Mono>
                      </span>
                    ))
                  ) : (
                    <span className={s.muted}>No blueprint packs</span>
                  )}
                </span>
              </span>
            ),
          },
        ]}
      />
      <div
        className={styles.tableWrap}
        // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        role="region"
        aria-label="Pinned code"
      >
        <table className={styles.table}>
          <caption className="sr-only">Approved transformation code pinned by this run</caption>
          <thead>
            <tr>
              <th scope="col">Artifact</th>
              <th scope="col" className={styles.num}>
                Version
              </th>
              <th scope="col">Digest</th>
            </tr>
          </thead>
          <tbody>
            {r.artifacts.map((a) => (
              <tr key={a.id}>
                <th scope="row">
                  <Mono className={s.xs}>{a.name}</Mono>
                </th>
                <td className={styles.num}>{a.version}</td>
                <td>
                  <Mono className={s.xs} title={a.digest}>
                    {a.digest.slice(0, 16)}…
                  </Mono>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Reconciliation({ run: r }: { run: LoadRunDetail }) {
  const tables = Object.entries(r.summary.tables ?? {});
  const statuses = [
    ...new Set(
      tables.flatMap(([, t]) =>
        Object.keys(t).filter((k) => !['source', 'transformed', 'accepted'].includes(k)),
      ),
    ),
  ].sort();
  return (
    <section className={styles.section} aria-labelledby="run-recon">
      <h3 id="run-recon" className={styles.sectionTitle}>
        Reconciliation per table
      </h3>
      {tables.length === 0 ? (
        <p className={`${s.muted} ${s.small}`}>No reconciliation yet.</p>
      ) : (
        <div
          className={styles.tableWrap}
          // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label="Record counts per table"
        >
          <table className={styles.table}>
            <caption className="sr-only">
              Record counts per target table at source, after transformation and accepted by the
              target, with each record status
            </caption>
            <thead>
              <tr>
                <th scope="col">Target table</th>
                <th scope="col" className={styles.num}>
                  Source
                </th>
                <th scope="col" className={styles.num}>
                  Transformed
                </th>
                <th scope="col" className={styles.num}>
                  Accepted
                </th>
                {statuses.map((st) => (
                  <th key={st} scope="col" className={styles.num}>
                    {recordStatus(st).label}
                  </th>
                ))}
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {tables.map(([name, t]) => {
                // A reload has no source rows: only transformed vs accepted is compared then.
                const srcDiff = t.source > 0 && t.source !== t.transformed;
                const accDiff = t.transformed !== t.accepted;
                const diff = srcDiff || accDiff;
                return (
                  <tr key={name} data-diff={diff || undefined}>
                    <th scope="row">
                      <Mono className={s.xs}>{name}</Mono>
                    </th>
                    <td className={styles.num}>{t.source.toLocaleString()}</td>
                    <td className={styles.num}>{t.transformed.toLocaleString()}</td>
                    <td className={styles.num}>{t.accepted.toLocaleString()}</td>
                    {statuses.map((st) => (
                      <td key={st} className={styles.num}>
                        {(t[st] ?? 0).toLocaleString()}
                      </td>
                    ))}
                    <td>{diff ? <DiffMark>Counts differ</DiffMark> : 'Reconciled'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Measures({ run: r }: { run: LoadRunDetail }) {
  const ms = r.summary.measures ?? [];
  return (
    <section className={styles.section} aria-labelledby="run-measures">
      <h3 id="run-measures" className={styles.sectionTitle}>
        Measured amounts (to the cent)
      </h3>
      {ms.length === 0 ? (
        <p className={`${s.muted} ${s.small}`}>
          No measured amounts: the blueprint lists no measures and no mapped column is a decimal or
          money type.
        </p>
      ) : (
        <div
          className={styles.tableWrap}
          // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label="Measured amounts"
        >
          <table className={styles.table}>
            <caption className="sr-only">
              Totals of each measured amount at source, after transformation and accepted by the
              target, with the differences
            </caption>
            <thead>
              <tr>
                <th scope="col">Measure</th>
                <th scope="col" className={styles.num}>
                  Source
                </th>
                <th scope="col" className={styles.num}>
                  Transformed
                </th>
                <th scope="col" className={styles.num}>
                  Accepted
                </th>
                <th scope="col" className={styles.num}>
                  Transformed − source
                </th>
                <th scope="col" className={styles.num}>
                  Accepted − transformed
                </th>
              </tr>
            </thead>
            <tbody>
              {ms.map((m) => {
                const d1 = decimalDiff(m.source, m.transformed);
                const d2 = decimalDiff(m.transformed, m.accepted);
                const bad1 = !isZero(d1);
                const bad2 = !isZero(d2);
                return (
                  <tr key={`${m.table}.${m.column}`} data-diff={bad1 || bad2 || undefined}>
                    <th scope="row">
                      <span className={s.cellStack}>
                        <span>{m.label}</span>
                        <Mono className={s.xs}>
                          {m.table}.{m.column}
                        </Mono>
                      </span>
                    </th>
                    <td className={styles.num}>{formatAmount(m.source)}</td>
                    <td className={styles.num}>{formatAmount(m.transformed)}</td>
                    <td className={styles.num}>{formatAmount(m.accepted)}</td>
                    <td className={styles.num} data-diff={bad1 || undefined}>
                      {d1 === null ? '—' : formatDifference(d1)}
                      {bad1 ? (
                        <>
                          {' '}
                          <DiffMark />
                        </>
                      ) : null}
                    </td>
                    <td className={styles.num} data-diff={bad2 || undefined}>
                      {formatDifference(d2)}
                      {bad2 ? (
                        <>
                          {' '}
                          <DiffMark />
                        </>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Quality({ run: r }: { run: LoadRunDetail }) {
  const dq = Object.entries(r.summary.dq ?? {});
  const segs = [...new Set(dq.flatMap(([, d]) => Object.keys(d.segments)))].sort();
  return (
    <section className={styles.section} aria-labelledby="run-dq">
      <h3 id="run-dq" className={styles.sectionTitle}>
        Data quality before and after
      </h3>
      <p className={`${s.muted} ${s.small}`}>
        Before is discovery’s profile score of the source table; after is the share of transformed
        records with no validation failure.
      </p>
      {dq.length === 0 ? (
        <p className={`${s.muted} ${s.small}`}>No data quality yet.</p>
      ) : (
        <div
          className={styles.tableWrap}
          // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label="Data quality"
        >
          <table className={styles.table}>
            <caption className="sr-only">
              Data quality per object before and after the transformation
              {segs.length ? ', and after per segment' : ''}
            </caption>
            <thead>
              <tr>
                <th scope="col">Object</th>
                <th scope="col">Source table</th>
                <th scope="col" className={styles.num}>
                  Before
                </th>
                <th scope="col" className={styles.num}>
                  After
                </th>
                {segs.map((g) => (
                  <th key={g} scope="col" className={styles.num}>
                    Segment {g}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dq.map(([name, d]) => (
                <tr key={name}>
                  <th scope="row">
                    <Mono className={s.xs}>{name}</Mono>
                  </th>
                  <td>
                    <Mono className={s.xs}>{d.source_table}</Mono>
                  </td>
                  <td className={styles.num}>
                    {d.before === null ? 'Not profiled' : formatPercent(d.before)}
                  </td>
                  <td className={styles.num}>{formatPercent(d.after)}</td>
                  {segs.map((g) => (
                    <td key={g} className={styles.num}>
                      {formatPercent(d.segments[g])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Problems({ run: r }: { run: LoadRunDetail }) {
  const errors = r.summary.errors ?? [];
  const blocked = Object.entries(r.summary.blocked ?? {});
  if (!errors.length && !blocked.length) return null;
  return (
    <section className={styles.section} aria-labelledby="run-problems">
      <h3 id="run-problems" className={styles.sectionTitle}>
        Errors and blocked tables
      </h3>
      {errors.length ? (
        <Callout tone="danger" title={`${String(errors.length)} transformation error(s)`}>
          <ul className={styles.bullets}>
            {errors.map((e) => (
              <li key={e.artifact}>
                <Mono className={s.xs}>{e.artifact}</Mono>: {e.error}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
      {blocked.length ? (
        <Callout tone="warning" title={`${String(blocked.length)} table(s) could not be sent`}>
          <ul className={styles.bullets}>
            {blocked.map(([t, why]) => (
              <li key={t}>
                <Mono className={s.xs}>{t}</Mono>: {why}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- start dialog

const EMPTY: StartForm = {
  kind: '',
  connection: '',
  extract: '',
  target: '',
  segmentColumn: '',
  segmentValues: '',
};

function StartLoadDialog({
  project,
  onClose,
  onStarted,
}: {
  project: Project;
  onClose: () => void;
  onStarted: (r: LoadRun) => void;
}) {
  const start = useStartLoadRun(project.id);
  const conns = useSourceConnections(project.tenant_id);
  const targets = useTargetConnections(project.tenant_id);
  const [f, setF] = useState<StartForm>(EMPTY);
  const [submitted, setSubmitted] = useState(false);
  const extracts = useAdapterRuns(f.connection, f.connection !== '');
  const canLoad = project.permissions.includes('target:load');
  const set = (patch: Partial<StartForm>) => setF((x) => ({ ...x, ...patch }));
  const client = startErrors(f);
  const server = isApiError(start.error) ? start.error.fieldErrors : {};
  const err = (k: keyof typeof client, ...fields: string[]) =>
    (submitted ? client[k] : undefined) ?? fields.map((x) => server[x]).find(Boolean);
  const sendsToTarget = f.kind === 'load' || f.kind === 'delta';
  const options = (extracts.data ?? [])
    .filter((r) => r.kind === 'extract' && r.status === 'succeeded')
    .filter((r) => f.kind !== 'delta' || r.mode === 'delta')
    .map((r) => {
      const rows =
        typeof r.summary.rows === 'number' ? `, ${r.summary.rows.toLocaleString()} rows` : '';
      const when = r.finished_at ?? r.created_at;
      return {
        value: r.id,
        label: `${r.mode === 'delta' ? 'Delta' : 'Full'} extract, ${formatAbsolute(new Date(when))}${rows}`,
      };
    });
  const kindOptions = START_KINDS.map((k: StartKind) => ({
    value: k,
    label: KIND_LABELS[k],
    description:
      k !== 'rehearsal' && !canLoad
        ? `${KIND_HELP[k]} Needs permission to load into this tenant’s target.`
        : KIND_HELP[k],
    disabled: k !== 'rehearsal' && !canLoad,
  }));
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Start a load run"
      description="The approved transformation code and the blueprint’s pack versions are pinned with the extract you choose."
      submitLabel={f.kind === 'rehearsal' ? 'Start rehearsal' : 'Start run'}
      size="lg"
      pending={start.isPending}
      error={start.error}
      fields={[
        'kind',
        'extract_run_id',
        'target_connection_id',
        'segment.column',
        'segment.values',
        'segment',
      ]}
      onSubmit={() => {
        setSubmitted(true);
        if (Object.keys(client).length) return;
        const values = splitValues(f.segmentValues);
        start.mutate(
          {
            kind: f.kind as StartKind,
            extract_run_id: f.extract,
            ...(sendsToTarget ? { target_connection_id: f.target } : {}),
            ...(f.segmentColumn.trim()
              ? { segment: { column: f.segmentColumn.trim(), values } }
              : {}),
          },
          {
            onSuccess: (r) => {
              toast.info(`Run ${String(r.number)} started`);
              onStarted(r);
            },
          },
        );
      }}
    >
      <RadioCards
        legend="Kind of run"
        options={kindOptions}
        value={f.kind}
        onValueChange={(k) =>
          set({
            kind: k,
            ...(k === 'rehearsal' ? { target: '' } : {}),
            ...(k === 'delta' ? { extract: '' } : {}),
          })
        }
        error={err('kind', 'kind')}
      />
      <Field label="Source connection" required error={err('connection')}>
        <Select
          options={(conns.data ?? []).map((c) => ({
            value: c.id,
            label: `${c.name} (${c.adapter})`,
          }))}
          value={f.connection}
          onValueChange={(v) => set({ connection: v, extract: '' })}
          placeholder={conns.isPending ? 'Loading…' : 'Choose a source connection'}
        />
      </Field>
      {conns.isError ? (
        <ApiErrorView error={conns.error} title="Could not list source connections" compact />
      ) : null}
      <Field
        label="Extract run"
        required
        help={
          f.kind === 'delta'
            ? 'Only successful delta extracts (rows changed since the previous extract).'
            : 'Only successful extracts are listed.'
        }
        error={err('extract', 'extract_run_id')}
      >
        <Select
          options={options}
          value={f.extract}
          onValueChange={(v) => set({ extract: v })}
          disabled={!f.connection}
          placeholder={
            !f.connection
              ? 'Choose a source connection first'
              : extracts.isPending
                ? 'Loading…'
                : options.length
                  ? 'Choose an extract'
                  : 'No successful extract on this connection'
          }
        />
      </Field>
      {sendsToTarget ? (
        <Field
          label="Target connection"
          required
          help="Records that pass validation are sent through the target adapter’s load endpoints."
          error={err('target', 'target_connection_id')}
        >
          <Select
            options={(targets.data ?? []).map((t) => ({
              value: t.id,
              label: `${t.name} (${t.adapter})`,
            }))}
            value={f.target}
            onValueChange={(v) => set({ target: v })}
            placeholder={targets.isPending ? 'Loading…' : 'Choose a target connection'}
          />
        </Field>
      ) : f.kind === 'rehearsal' ? (
        <p className={`${s.muted} ${s.small}`}>
          A rehearsal sends nothing, so it has no target connection.
        </p>
      ) : null}
      <fieldset className={s.stackSm} style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className={styles.subTitle}>Segment (optional)</legend>
        <p className={`${s.muted} ${s.small}`}>
          Load one line of business or region at a time: only rows whose column has one of the
          values.
        </p>
        <Field label="Segment column" error={err('column', 'segment.column')}>
          <Input
            mono
            value={f.segmentColumn}
            maxLength={128}
            onChange={(e) => set({ segmentColumn: e.target.value })}
          />
        </Field>
        <Field
          label="Segment values"
          help="One per line or separated by commas; up to 100."
          error={err('values', 'segment.values')}
        >
          <Textarea
            rows={2}
            value={f.segmentValues}
            onChange={(e) => set({ segmentValues: e.target.value })}
          />
        </Field>
      </fieldset>
    </FormDialog>
  );
}
