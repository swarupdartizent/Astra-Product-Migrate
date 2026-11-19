import { Rocket, ScanSearch } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRelease, useReleaseEvaluation, useReleases } from '@/api/releases';
import type { Release, ReleaseDetail, ReleaseEvaluation } from '@/api/releases-types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { RequirePermission } from '@/app/RequirePermission';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CodeBlock,
  createDataTableColumns,
  DataTable,
  EmptyState,
  KeyValueList,
  Mono,
  PageHeader,
  Skeleton,
  StatusPill,
  Timestamp,
} from '@/ui';
import s from '../shared.module.css';
import { compareScorecards, GATE_COMMANDS, releaseStatus, RELEASES_PERMISSION } from './model';
import { RecordReleaseDialog } from './RecordReleaseDialog';
import styles from './Releases.module.css';
import {
  ComparisonTables,
  Digest,
  ImprovementsTable,
  RegressionsTable,
  SuiteScorecards,
} from './Scorecards';

const NO_PERMISSION_WHY = 'Only people with the golden run permission on the platform can do this.';

/**
 * Release gate (I13, E22.F1.S2): the release history, a preview of whether a release would pass
 * now, and recording a release as Released or Blocked.
 */
export interface ReleasesPageProps {
  /** The selected release, when the URL holds it; local state otherwise. */
  releaseId?: string | null;
  onSelectRelease?: (id: string) => void;
}

export function ReleasesPage(props: ReleasesPageProps) {
  return (
    <RequirePermission permission={RELEASES_PERMISSION}>
      <ReleasesView {...props} />
    </RequirePermission>
  );
}

function ReleasesView({ releaseId: fromUrl, onSelectRelease }: ReleasesPageProps) {
  useDocumentTitle('Releases');
  const q = useReleases();
  const [local, setLocal] = useState<string | null>(null);
  const releaseId = fromUrl !== undefined ? fromUrl : local;
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState<ReleaseDetail | null>(null);
  const [focusDetail, setFocusDetail] = useState(false);

  const select = (id: string, focus: boolean) => {
    setFocusDetail(focus);
    if (onSelectRelease) onSelectRelease(id);
    else setLocal(id);
  };

  const columns = useMemo(() => {
    const col = createDataTableColumns<Release>();
    const wrap = { whiteSpace: 'normal' } as const;
    return col.columns([
      col.accessor('name', {
        header: 'Release',
        size: 150,
        cell: (info) => <span className={s.cellPrimary}>{info.getValue()}</span>,
      }),
      col.accessor('status', {
        header: 'Status',
        size: 110,
        cell: (info) => {
          const st = releaseStatus(info.getValue());
          return <StatusPill tone={st.tone}>{st.label}</StatusPill>;
        },
      }),
      col.accessor('baseline_release', {
        header: 'Compared with',
        size: 140,
        cell: (info) => info.getValue() ?? <span className={s.muted}>First release</span>,
      }),
      col.display({
        id: 'regressions',
        header: 'Regressions',
        size: 110,
        meta: { align: 'end' },
        cell: (info) => info.row.original.regressions.length,
      }),
      col.display({
        id: 'improved',
        header: 'Improvements',
        size: 120,
        meta: { align: 'end' },
        cell: (info) => info.row.original.improved.length,
      }),
      col.display({
        id: 'recorded',
        header: 'Recorded',
        size: 190,
        cell: (info) => (
          <span className={s.cellStack}>
            <span>{info.row.original.recorded_by ?? 'Unknown user'}</span>
            {info.row.original.created_at ? (
              <Timestamp value={info.row.original.created_at} />
            ) : null}
          </span>
        ),
      }),
      col.accessor('reason', {
        header: 'Reason',
        size: 320,
        cell: (info) => <span style={wrap}>{info.getValue()}</span>,
      }),
    ]);
  }, []);

  if (q.isError) {
    return (
      <>
        <PageHeader title="Releases" />
        <ApiErrorView
          error={q.error}
          title="Could not load releases"
          onRetry={() => void q.refetch()}
          retrying={q.isFetching}
          headingLevel={2}
        />
      </>
    );
  }

  const list = q.data;
  const canRecord = list?.can_record ?? false;
  const latestReleased = list?.releases.find((r) => r.status === 'released') ?? null;
  const why = list && !canRecord ? NO_PERMISSION_WHY : null;

  return (
    <>
      <PageHeader
        title="Releases"
        description="Each release is scored on the golden suites and compared with the previous released scorecard. A release in which any measure fell is recorded as Blocked."
        actions={
          list ? (
            <span className={s.stackSm}>
              <Button
                variant="primary"
                leadingIcon={<Rocket aria-hidden="true" />}
                disabled={!canRecord}
                aria-describedby={why ? 'releases-record-why' : undefined}
                onClick={() => setRecording(true)}
              >
                Record release
              </Button>
              {why ? (
                <span id="releases-record-why" className={`${s.xs} ${s.muted}`}>
                  {why}
                </span>
              ) : null}
            </span>
          ) : null
        }
      />
      <div className={s.stack}>
        <div role="status" aria-live="polite">
          {recorded ? <RecordedResult release={recorded} /> : null}
        </div>

        <CheckNowCard
          canRecord={canRecord}
          loaded={list !== undefined}
          releases={list?.releases ?? []}
        />

        <Card flush aria-labelledby="releases-history">
          <CardHeader
            titleId="releases-history"
            title="Release history"
            description="Newest first. Records are append-only. Select a release to see its regressions, improvements and full scorecard."
          />
          <CardBody>
            <DataTable
              label="Release history"
              data={list?.releases}
              columns={columns}
              getRowId={(r) => r.id}
              loading={q.isPending}
              onRowClick={(r) => select(r.id, true)}
              empty={
                <EmptyState
                  compact
                  icon={<Rocket />}
                  title="No releases recorded"
                  body="Record the first release to make its scorecard the baseline later releases are compared with."
                />
              }
            />
          </CardBody>
        </Card>

        {releaseId ? (
          <ReleaseDetailPanel
            key={releaseId}
            id={releaseId}
            focusOnLoad={focusDetail}
            onFocused={() => setFocusDetail(false)}
          />
        ) : null}

        <GateExplanation />
      </div>

      {recording ? (
        <RecordReleaseDialog
          baselineName={latestReleased?.name ?? null}
          onClose={() => setRecording(false)}
          onRecorded={(r) => {
            setRecording(false);
            setRecorded(r);
            select(r.id, false);
          }}
        />
      ) : null}
    </>
  );
}

function RecordedResult({ release }: { release: ReleaseDetail }) {
  if (release.status === 'released') {
    return (
      <Callout tone="success" title={`${release.name} released`}>
        {release.baseline_release
          ? `No measure fell below ${release.baseline_release}. ${String(release.improved.length)} measure(s) improved. Its scorecard is now the baseline.`
          : 'This is the first release. Its scorecard is now the baseline.'}
      </Callout>
    );
  }
  return (
    <Callout tone="danger" title={`${release.name} blocked`}>
      <p>
        {release.regressions.length} regression(s) against{' '}
        {release.baseline_release ?? 'the baseline'}.{' '}
        {release.baseline_release ?? 'The previous release'} stays the baseline.
      </p>
      <ul className={styles.list}>
        {release.regressions.map((r) => (
          <li key={`${r.suite}|${r.measure ?? ''}`}>
            {r.suite} · {r.measure ?? 'whole suite'}: {r.detail}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

// ---------- Check now ----------

function CheckNowCard({
  canRecord,
  loaded,
  releases,
}: {
  canRecord: boolean;
  loaded: boolean;
  releases: readonly Release[];
}) {
  const check = useReleaseEvaluation();
  const why = loaded && !canRecord ? NO_PERMISSION_WHY : null;
  return (
    <Card aria-labelledby="releases-check">
      <CardHeader
        titleId="releases-check"
        title="Check now"
        description="Score the golden suites now and see whether a release would pass against the latest released one. Nothing is recorded."
        actions={
          <Button
            leadingIcon={<ScanSearch aria-hidden="true" />}
            loading={check.isPending}
            disabled={!canRecord}
            aria-describedby={why ? 'releases-check-why' : undefined}
            onClick={() => check.mutate()}
          >
            {check.data ? 'Check again' : 'Check now'}
          </Button>
        }
      />
      <CardBody className={s.stackSm}>
        {why ? (
          <p id="releases-check-why" className={`${s.small} ${s.muted}`}>
            {why}
          </p>
        ) : null}
        <div role="status" aria-live="polite">
          {check.isPending ? (
            <p className={s.small}>Scoring the golden suites…</p>
          ) : check.data ? (
            <CheckSummary evaluation={check.data} />
          ) : null}
        </div>
        {check.isError ? (
          <ApiErrorView error={check.error} title="Could not run the evaluation" compact />
        ) : null}
        {check.data ? <CheckDetail evaluation={check.data} releases={releases} /> : null}
      </CardBody>
    </Card>
  );
}

function CheckSummary({ evaluation: e }: { evaluation: ReleaseEvaluation }) {
  if (e.baseline_release === null) {
    return (
      <Callout tone="success" title="Would be released">
        No release has been recorded yet, so there is nothing to compare with. The first release
        becomes the baseline.
      </Callout>
    );
  }
  if (e.passed) {
    return (
      <Callout tone="success" title="Would be released">
        No measure fell below {e.baseline_release}. {e.improved.length} measure(s) improved.
      </Callout>
    );
  }
  return (
    <Callout tone="danger" title="Would be blocked">
      {e.regressions.length} regression(s) against {e.baseline_release}. Recording now would record
      a Blocked release.
    </Callout>
  );
}

function CheckDetail({
  evaluation: e,
  releases,
}: {
  evaluation: ReleaseEvaluation;
  releases: readonly Release[];
}) {
  // The baseline's full scorecard, for the side-by-side table: the released record of that name.
  const baselineId =
    e.baseline_release !== null
      ? (releases.find((r) => r.name === e.baseline_release && r.status === 'released')?.id ?? null)
      : null;
  const base = useRelease(baselineId);
  const baselineKnown = e.baseline_release === null || base.data !== undefined;
  const comparisons = useMemo(
    () => compareScorecards(e, base.data?.suites ?? null),
    [e, base.data],
  );
  return (
    <div className={s.stack}>
      <KeyValueList
        items={[
          { key: 'base', label: 'Compared with', value: e.baseline_release ?? 'No release yet' },
          {
            key: 'changed',
            label: 'Suites changed since then',
            value: e.changed_suites.length > 0 ? e.changed_suites.join(', ') : 'None',
          },
          {
            key: 'engine',
            label: 'Engine digest',
            value: <Digest value={e.engine_digest} label="engine digest" />,
          },
        ]}
      />
      {e.regressions.length > 0 ? (
        <section aria-labelledby="check-regressions">
          <h3 id="check-regressions" className={styles.suiteHead}>
            What fell
          </h3>
          <RegressionsTable regressions={e.regressions} label="Regressions found now" />
        </section>
      ) : null}
      <section aria-labelledby="check-compare">
        <h3 id="check-compare" className={styles.suiteHead}>
          Baseline and now
        </h3>
        {baselineId !== null && base.isPending ? (
          <Skeleton height="10rem" />
        ) : (
          <>
            {base.isError ? (
              <Callout tone="warning" title="Could not load the baseline scorecard">
                Baseline values are shown only for measures that changed.
              </Callout>
            ) : null}
            {e.baseline_release !== null && baselineId === null ? (
              <p className={`${s.small} ${s.muted}`}>
                {e.baseline_release} is not among the latest 100 releases, so baseline values are
                shown only for measures that changed.
              </p>
            ) : null}
            <ComparisonTables
              comparisons={comparisons}
              baselineName={e.baseline_release}
              baselineKnown={baselineKnown}
            />
          </>
        )}
      </section>
    </div>
  );
}

// ---------- Release detail ----------

function ReleaseDetailPanel({
  id,
  focusOnLoad,
  onFocused,
}: {
  id: string;
  focusOnLoad: boolean;
  onFocused: () => void;
}) {
  const q = useRelease(id);
  const headingRef = useRef<HTMLSpanElement>(null);
  const loaded = q.data !== undefined;
  useEffect(() => {
    if (loaded && focusOnLoad) {
      headingRef.current?.focus();
      onFocused();
    }
  }, [loaded, focusOnLoad, onFocused]);

  if (q.isPending) return <Skeleton height="16rem" />;
  if (q.isError) {
    return (
      <ApiErrorView
        error={q.error}
        title="Could not load the release"
        onRetry={() => void q.refetch()}
        retrying={q.isFetching}
        headingLevel={2}
      />
    );
  }
  const r = q.data;
  const st = releaseStatus(r.status);
  return (
    <Card aria-labelledby="release-detail">
      <CardHeader
        titleId="release-detail"
        title={
          <span ref={headingRef} tabIndex={-1}>
            Release {r.name}
          </span>
        }
        description={
          r.baseline_release
            ? `Compared with ${r.baseline_release}.`
            : 'The first release: nothing to compare with.'
        }
        actions={<StatusPill tone={st.tone}>{st.label}</StatusPill>}
      />
      <CardBody className={s.stack}>
        <KeyValueList
          items={[
            { key: 'status', label: 'Status', value: st.label },
            {
              key: 'baseline',
              label: 'Compared with',
              value: r.baseline_release ?? 'First release',
            },
            {
              key: 'recorded',
              label: 'Recorded',
              value: (
                <>
                  {r.recorded_by ?? 'Unknown user'}
                  {r.created_at ? (
                    <>
                      {', '}
                      <Timestamp value={r.created_at} format="absolute" />
                    </>
                  ) : null}
                </>
              ),
            },
            { key: 'reason', label: 'Reason', value: r.reason },
            {
              key: 'engine',
              label: 'Engine digest',
              value: r.engine_digest ? (
                <Digest value={r.engine_digest} label="engine digest" />
              ) : null,
            },
          ]}
        />
        <section aria-labelledby="release-regressions">
          <h3 id="release-regressions" className={styles.suiteHead}>
            Regressions ({r.regressions.length})
          </h3>
          {r.regressions.length > 0 ? (
            <RegressionsTable
              regressions={r.regressions}
              label={`Regressions of release ${r.name}`}
            />
          ) : (
            <p className={`${s.small} ${s.muted}`}>
              {r.baseline_release
                ? `No measure fell below ${r.baseline_release}.`
                : 'None: the first release has nothing to fall below.'}
            </p>
          )}
        </section>
        <section aria-labelledby="release-improved">
          <h3 id="release-improved" className={styles.suiteHead}>
            Improvements ({r.improved.length})
          </h3>
          {r.improved.length > 0 ? (
            <ImprovementsTable improved={r.improved} label={`Improvements of release ${r.name}`} />
          ) : (
            <p className={`${s.small} ${s.muted}`}>No measure rose.</p>
          )}
        </section>
        <section aria-labelledby="release-measures">
          <h3 id="release-measures" className={styles.suiteHead}>
            Scorecard
          </h3>
          <p className={`${s.small} ${s.muted}`}>
            Every measure is a ratio from 0 to 1; higher is better.
          </p>
          <SuiteScorecards suites={r.suites} regressions={r.regressions} />
        </section>
      </CardBody>
    </Card>
  );
}

// ---------- Explanation ----------

function GateExplanation() {
  return (
    <Card aria-labelledby="releases-how">
      <CardHeader titleId="releases-how" title="How the release gate works" />
      <CardBody className={s.stackSm}>
        <p className={s.small}>
          Each golden suite is a synthetic estate with the answers a careful migration team would
          give: a test asset, never customer data. The platform&rsquo;s own engines score it in six
          areas (mapping, configuration, code, planning, compliance and review), and every measure
          is a ratio from 0 to 1.
        </p>
        <p className={s.small}>
          A release is blocked when any measure falls below the previous release, a measure
          disappears, or a suite disappears. Improvements and suites that changed are reported. CI
          runs the gate on every change and fails the build when anything fell, so a regression
          cannot be released unnoticed.
        </p>
        <p className={s.small}>
          From the command line, <Mono>gate</Mono> compares the current scorecard with the recorded
          baseline, <Mono>run</Mono> writes the scorecard, and <Mono>record</Mono> makes it the next
          baseline:
        </p>
        <CodeBlock code={GATE_COMMANDS} label="Shell" className={styles.commands} />
      </CardBody>
    </Card>
  );
}
