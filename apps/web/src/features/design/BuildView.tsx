import { useQueryClient } from '@tanstack/react-query';
import { Hammer, ShieldCheck } from 'lucide-react';
import { useRef, useState, type RefObject } from 'react';
import {
  designKeys,
  useApproveArtifact,
  useBuildArtifact,
  useBuildArtifacts,
  useDesignOverview,
  useStartBuild,
} from '@/api/design';
import type {
  ArtifactKind,
  ArtifactResult,
  BuildArtifact,
  BuildArtifactDetail,
} from '@/api/design-types';
import { isJobFinished, useJobs } from '@/api/jobs';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormError } from '@/app/FormError';
import { JobProgress } from '@/app/JobProgress';
import { reasonError } from '@/lib/forms';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  KeyValueList,
  Mono,
  PlainText,
  Select,
  Skeleton,
  StatusPill,
  Switch,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import styles from './Design.module.css';
import { ARTIFACT_KIND, artifactStatus } from './model';

const ALL = '__all__';

/** A seed row value as text: NULL, scalars as they are, structures as JSON. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/**
 * Build (E12.F4.S1): generate code from the register's decisions and test it on the workbench;
 * list the versioned artifacts and approve a version whose tests passed. Only approved versions
 * can run.
 */
export function BuildView({
  project,
  selected,
  onSelect,
}: {
  project: Project;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const qc = useQueryClient();
  const overview = useDesignOverview(project.id);
  const start = useStartBuild(project.id);
  const jobs = useJobs({ project_id: project.id });
  const [startedJob, setStartedJob] = useState<string | null>(null);
  const running = (jobs.data ?? []).find(
    (j) => j.kind === 'design.build' && !isJobFinished(j.status),
  );
  const jobId = startedJob ?? running?.id ?? null;
  const [kind, setKind] = useState<ArtifactKind | ''>('');
  const [all, setAll] = useState(false);
  const list = useBuildArtifacts(project.id, {
    ...(kind ? { kind } : {}),
    ...(all ? { all_versions: true } : {}),
  });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const canBuild = overview.data?.can_build ?? false;
  const why = !overview.data
    ? null
    : !canBuild
      ? 'Building needs stage management on this project.'
      : running
        ? 'A build is already running.'
        : null;
  const select = (id: string) => {
    onSelect(id);
    window.setTimeout(() => headingRef.current?.focus(), 0);
  };

  return (
    <div className={s.stack}>
      <Card aria-labelledby="build-head">
        <CardHeader
          titleId="build-head"
          title="Build and test"
          description="Generates transformation code from approved mappings, customer code renamed to the target’s rules, and report procedures, then tests each on the SQL Server workbench in a rolled-back transaction. Unchanged code keeps its version; a change makes a new version and supersedes earlier unapproved ones."
          actions={
            <Button
              variant="primary"
              leadingIcon={<Hammer aria-hidden="true" />}
              disabled={!!why || !overview.data}
              loading={start.isPending}
              aria-describedby={why ? 'build-why' : undefined}
              onClick={() =>
                start.mutate(undefined, {
                  onSuccess: (r) => {
                    setStartedJob(r.job_id);
                    toast.info('Build started');
                  },
                })
              }
            >
              Start build
            </Button>
          }
        />
        <CardBody className={s.stackSm}>
          {why ? (
            <p id="build-why" className={`${s.muted} ${s.small}`}>
              {why}
            </p>
          ) : null}
          <FormError error={start.error} />
          {jobId ? (
            <JobProgress
              jobId={jobId}
              title="Build and test"
              onFinished={() => {
                void qc.invalidateQueries({ queryKey: designKeys.project(project.id) });
              }}
            />
          ) : null}
          <Callout tone="info" title="Only approved versions can run">
            A person other than the one who generated it approves exactly one version whose tests
            passed. The database refuses approval of untested or failed code, any change to an
            approved version’s code, and approvals by agents. Loads (I10) run only approved
            artifacts.
          </Callout>
        </CardBody>
      </Card>
      <div className={styles.layout}>
        <Card flush aria-labelledby="artifacts-head">
          <CardHeader titleId="artifacts-head" title="Artifacts" />
          <div className={styles.filters} role="group" aria-label="Filter artifacts">
            <Field label="Kind">
              <Select
                size="sm"
                options={[
                  { value: ALL, label: 'All' },
                  {
                    value: 'transformation',
                    label: ARTIFACT_KIND.transformation ?? 'Transformation',
                  },
                  { value: 'code_object', label: ARTIFACT_KIND.code_object ?? 'Code' },
                ]}
                value={kind || ALL}
                onValueChange={(v) => setKind(v === ALL ? '' : (v as ArtifactKind))}
              />
            </Field>
            <Field label="Include superseded versions" inline>
              <Switch checked={all} onCheckedChange={setAll} />
            </Field>
          </div>
          <div className={styles.bar}>
            <span className={s.muted} aria-live="polite">
              {list.data ? `${list.data.length.toLocaleString()} artifact version(s)` : 'Loading…'}
            </span>
          </div>
          {list.isError ? (
            <div style={{ padding: 'var(--space-4)' }}>
              <ApiErrorView
                error={list.error}
                title="Could not load build artifacts"
                compact
                onRetry={() => void list.refetch()}
              />
            </div>
          ) : list.isPending ? (
            <div style={{ padding: 'var(--space-4)' }} className={s.stackSm}>
              <Skeleton height="3.5rem" />
              <Skeleton height="3.5rem" />
            </div>
          ) : list.data.length === 0 ? (
            <EmptyState
              compact
              title="No artifacts"
              body="Approve mappings, customer code and reports, then start a build."
            />
          ) : (
            <ul className={styles.list} aria-label="Build artifacts" aria-busy={list.isFetching}>
              {list.data.map((a) => (
                <ArtifactRow
                  key={a.id}
                  artifact={a}
                  current={a.id === selected}
                  onSelect={() => select(a.id)}
                />
              ))}
            </ul>
          )}
        </Card>
        <ArtifactPanel
          key={selected ?? ''}
          project={project}
          id={selected}
          headingRef={headingRef}
        />
      </div>
    </div>
  );
}

function testSummaryText(a: BuildArtifact): string {
  const t = a.test_summary;
  if (t.tests === undefined) return 'Not tested yet';
  return `${String(t.passed ?? 0)} of ${String(t.tests)} test(s) passed`;
}

function ArtifactRow({
  artifact: a,
  current,
  onSelect,
}: {
  artifact: BuildArtifact;
  current: boolean;
  onSelect: () => void;
}) {
  const st = artifactStatus(a.status);
  const failed = a.test_summary.failed?.length ?? 0;
  return (
    <li className={styles.row}>
      <button
        type="button"
        className={styles.rowButton}
        aria-current={current ? 'true' : undefined}
        onClick={onSelect}
      >
        <span className={s.badges}>
          <StatusPill tone={st.tone}>{st.label}</StatusPill>
          {a.runnable ? (
            <Badge tone="success" icon={<ShieldCheck aria-hidden="true" />}>
              Runnable
            </Badge>
          ) : (
            <Badge>Not runnable</Badge>
          )}
          <Badge>Version {a.version}</Badge>
        </span>
        <span className={styles.rowTitle}>
          <Mono className={s.small}>{a.name}</Mono>
        </span>
        <span className={styles.rowMeta}>
          <span>{ARTIFACT_KIND[a.kind] ?? a.kind}</span>
          <span>{testSummaryText(a)}</span>
          {failed ? <span>Failed: {a.test_summary.failed?.slice(0, 3).join(', ')}</span> : null}
        </span>
      </button>
    </li>
  );
}

function ArtifactPanel({
  project,
  id,
  headingRef,
}: {
  project: Project;
  id: string | null;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const q = useBuildArtifact(project.id, id);
  const a = q.data;
  const st = a ? artifactStatus(a.status) : null;
  return (
    <Card aria-labelledby="artifact-detail-head">
      <CardHeader
        titleId="artifact-detail-head"
        title={
          <span ref={headingRef} tabIndex={-1} className={styles.panelHeading}>
            {id === null
              ? 'Artifact detail'
              : a
                ? `${a.name}, version ${String(a.version)}`
                : 'Loading the artifact…'}
          </span>
        }
        description={
          a && st ? (
            <span className={s.badges}>
              <StatusPill tone={st.tone}>{st.label}</StatusPill>
              {a.runnable ? <Badge tone="success">Runnable</Badge> : <Badge>Not runnable</Badge>}
            </span>
          ) : undefined
        }
      />
      <CardBody className={s.stack}>
        {id === null ? (
          <EmptyState
            compact
            title="Select an artifact"
            body="Choose an artifact to see its code, tests and results, the inputs it was generated from, and to approve it."
          />
        ) : q.isPending ? (
          <Skeleton height="18rem" />
        ) : q.isError ? (
          <ApiErrorView
            error={q.error}
            title="Could not load the artifact"
            compact
            onRetry={() => void q.refetch()}
          />
        ) : (
          <ArtifactBody project={project} artifact={q.data} />
        )}
      </CardBody>
    </Card>
  );
}

function ArtifactBody({
  project,
  artifact: a,
}: {
  project: Project;
  artifact: BuildArtifactDetail;
}) {
  // Results by test name; the API adds requirement rows that are not among the defined tests.
  const results = new Map<string, ArtifactResult[]>();
  for (const r of a.results) results.set(r.name, [...(results.get(r.name) ?? []), r]);
  const defined = new Set(a.tests.map((t) => t.name));
  const extra = a.results.filter(
    (r) => !defined.has(r.name) && !r.name.startsWith('recorded case: '),
  );
  return (
    <>
      <KeyValueList
        items={[
          { key: 'k', label: 'Kind', value: ARTIFACT_KIND[a.kind] ?? a.kind },
          { key: 'v', label: 'Version', value: String(a.version) },
          {
            key: 'd',
            label: 'Digest',
            value: <Mono className={s.xs}>{a.digest.slice(0, 16)}…</Mono>,
          },
          {
            key: 'c',
            label: 'Generated',
            value: (
              <>
                {a.created_by ?? 'unknown'}
                {a.created_at ? (
                  <>
                    {' '}
                    <Timestamp value={a.created_at} />
                  </>
                ) : null}
              </>
            ),
          },
          { key: 't', label: 'Tests', value: testSummaryText(a) },
        ]}
      />
      {a.status === 'approved' ? (
        <Callout tone="success" title="Approved: this version can run">
          {a.approved_at ? (
            <>
              Approved <Timestamp value={a.approved_at} />
              {a.approval_note ? `: “${a.approval_note}”` : '.'}
            </>
          ) : null}
        </Callout>
      ) : a.status === 'superseded' ? (
        <Callout tone="info" title="Superseded">
          A newer version replaced this one. Superseded versions never run.
        </Callout>
      ) : (
        <Callout tone="warning" title="Not runnable">
          Only an approved version can run.
        </Callout>
      )}
      <section className={styles.section} aria-labelledby="art-code">
        <h3 id="art-code" className={styles.sectionTitle}>
          Code
        </h3>
        <PlainText
          label={`Code of ${a.name}`}
          lineNumbers
          className={styles.code}
          empty={<p className={s.muted}>No code was stored for this artifact.</p>}
        >
          {a.code}
        </PlainText>
      </section>
      <section className={styles.section} aria-labelledby="art-tests">
        <h3 id="art-tests" className={styles.sectionTitle}>
          Tests and results ({a.tests.length} test(s), {a.results.length} result(s))
        </h3>
        {a.results.length === 0 ? (
          <p className={`${s.muted} ${s.small}`}>The tests have not run yet.</p>
        ) : null}
        <ol className={styles.plainList} aria-label="Test results">
          {a.tests.map((t, i) => {
            const rs =
              t.kind === 'case'
                ? (results.get(`recorded case: ${t.name}`) ?? [])
                : (results.get(t.name) ?? []);
            const r = rs[0];
            return (
              <li
                key={`${String(i)}:${t.name}`}
                className={styles.result}
                data-passed={r ? r.passed : undefined}
              >
                <span className={s.row}>
                  {r ? (
                    <StatusPill tone={r.passed ? 'success' : 'danger'}>
                      {r.passed ? 'Passed' : 'Failed'}
                    </StatusPill>
                  ) : (
                    <StatusPill tone="neutral">Not run</StatusPill>
                  )}
                  <strong>{t.name}</strong>
                  <Badge>{t.kind}</Badge>
                </span>
                {r?.detail ? <span className={s.small}>{r.detail}</span> : null}
                {t.check ? (
                  <details>
                    <summary className={s.xs}>Check (expects {String(t.expect ?? '')})</summary>
                    <PlainText label={`Check of ${t.name}`}>{t.check}</PlainText>
                  </details>
                ) : null}
              </li>
            );
          })}
          {extra.map((r, i) => (
            <li key={`extra:${String(i)}`} className={styles.result} data-passed={r.passed}>
              <span className={s.row}>
                <StatusPill tone={r.passed ? 'success' : 'danger'}>
                  {r.passed ? 'Passed' : 'Failed'}
                </StatusPill>
                <strong>{r.name}</strong>
              </span>
              {r.detail ? <span className={s.small}>{r.detail}</span> : null}
            </li>
          ))}
        </ol>
      </section>
      <Inputs artifact={a} />
      <Approve project={project} artifact={a} />
    </>
  );
}

function Inputs({ artifact: a }: { artifact: BuildArtifactDetail }) {
  const i = a.inputs;
  const seeds = i.seed_rows ?? [];
  const real = i.real_sample_rows ?? 0;
  const cols = [...new Set(seeds.flatMap((r) => Object.keys(r)))];
  return (
    <section className={styles.section} aria-labelledby="art-inputs">
      <h3 id="art-inputs" className={styles.sectionTitle}>
        Inputs
      </h3>
      {a.kind === 'transformation' ? (
        <>
          <KeyValueList
            items={[
              {
                key: 's',
                label: 'Source table',
                value: <Mono className={s.xs}>{i.source_table}</Mono>,
              },
              {
                key: 't',
                label: 'Target table',
                value: <Mono className={s.xs}>{i.target_table}</Mono>,
              },
              {
                key: 'seed',
                label: 'Seed rows',
                value: `${String(seeds.length)} (${String(real)} real sample row(s) from the newest extract, ${String(Math.max(0, seeds.length - real))} generated typical and edge rows)`,
              },
            ]}
          />
          {real === 0 ? (
            <p className={`${s.muted} ${s.small}`}>
              No extract matched this table, so only generated rows were tested.
            </p>
          ) : null}
          <h4 className={styles.subTitle}>Mappings used ({i.mappings?.length ?? 0})</h4>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="sr-only">
                Approved mappings the transformation was generated from
              </caption>
              <thead>
                <tr>
                  <th scope="col">Source column</th>
                  <th scope="col">Target column</th>
                  <th scope="col">Decided by</th>
                </tr>
              </thead>
              <tbody>
                {(i.mappings ?? []).map((m) => (
                  <tr key={`${m.source}->${m.target}`}>
                    <td>
                      <Mono className={s.xs}>{m.source}</Mono>
                    </td>
                    <td>
                      <Mono className={s.xs}>{m.target}</Mono>
                    </td>
                    <td>{m.decided_by ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {seeds.length > 0 ? (
            <details>
              <summary className={s.small}>Seed rows ({seeds.length})</summary>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <caption className="sr-only">
                    Rows seeded into the staged source for the tests
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Row</th>
                      {cols.map((c) => (
                        <th key={c} scope="col">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {seeds.map((r, n) => (
                      <tr key={n}>
                        <th scope="row">
                          {n < real
                            ? `Real ${String(n + 1)}`
                            : n === seeds.length - 1
                              ? 'Edge'
                              : 'Typical'}
                        </th>
                        {cols.map((c) => (
                          <td key={c}>
                            <Mono className={s.xs}>{cellText(r[c])}</Mono>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </>
      ) : (
        <PlainText label={`Inputs of ${a.name}`}>{JSON.stringify(i, null, 2)}</PlainText>
      )}
    </section>
  );
}

function Approve({ project, artifact: a }: { project: Project; artifact: BuildArtifactDetail }) {
  const approve = useApproveArtifact(project.id);
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const err = reasonError(note);
  if (a.status === 'approved' || a.status === 'superseded') return null;
  return (
    <section className={styles.section} aria-labelledby="art-approve">
      <h3 id="art-approve" className={styles.sectionTitle}>
        Approve this version
      </h3>
      {!a.can_approve ? (
        <Callout tone="warning" title="This version cannot be approved by you">
          {a.cannot_approve_reason ?? 'Approval is not available.'}
        </Callout>
      ) : (
        <p className={`${s.muted} ${s.small}`}>
          Approves exactly version {a.version} (digest{' '}
          <Mono className={s.xs}>{a.digest.slice(0, 12)}</Mono>). The previously approved version of
          this artifact is superseded.
        </p>
      )}
      <Field
        label="Approval note"
        required
        help="At least 10 characters. It is recorded with the approval."
        error={submitted ? err : undefined}
        disabled={!a.can_approve}
      >
        <Textarea
          rows={3}
          value={note}
          maxLength={2000}
          disabled={!a.can_approve}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <div className={s.row}>
        <Button
          variant="primary"
          leadingIcon={<ShieldCheck aria-hidden="true" />}
          disabled={!a.can_approve}
          loading={approve.isPending}
          onClick={() => {
            setSubmitted(true);
            if (err) return;
            approve.mutate(
              { id: a.id, note: note.trim() },
              {
                onSuccess: () => toast.success(`Version ${String(a.version)} approved: it can run`),
              },
            );
          }}
        >
          Approve version {a.version}
        </Button>
      </div>
      <FormError error={approve.error} fields={['note']} />
    </section>
  );
}
