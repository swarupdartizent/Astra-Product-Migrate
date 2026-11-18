import { useQueryClient } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useSourceConnections } from '@/api/adapters';
import { designKeys, useDesignOverview, useStartDesignRun } from '@/api/design';
import {
  DESIGN_STATUSES,
  DESIGN_STREAMS,
  type DesignOverview,
  type DesignRun,
  type TargetDesign,
} from '@/api/design-types';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { JobProgress } from '@/app/JobProgress';
import { hasErrors, mergeFieldErrors, type FieldErrors } from '@/lib/forms';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Field,
  KeyValueList,
  Mono,
  Select,
  Skeleton,
  StatusPill,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import { runStatus } from '../discovery/model';
import disc from '../discovery/Discovery.module.css';
import styles from './Design.module.css';
import {
  ACCESS_LABELS,
  CONFIDENCE_TONE,
  DESIGN_STATUS,
  MECHANISM_KIND,
  METHOD_LABELS,
  SECTION_LABELS,
  STREAM_INFO,
  type DesignSection,
} from './model';

const ACTIVE = ['queued', 'running'];

/** The Design tab's landing view: the latest run, the register's counts and the target's design. */
export function DesignOverviewView({
  project,
  sectionLink,
}: {
  project: Project;
  sectionLink: (s: DesignSection, children: ReactNode) => ReactNode;
}) {
  const q = useDesignOverview(project.id);
  if (q.isPending) return <Skeleton height="16rem" />;
  if (q.isError) {
    return (
      <ApiErrorView
        error={q.error}
        title="Could not load the design overview"
        onRetry={() => void q.refetch()}
      />
    );
  }
  const o = q.data;
  return (
    <div className={s.stack}>
      {o.target_design_missing ? (
        <Callout tone="warning" title="The target’s design section is missing">
          {o.target_design_missing} Streams that need it are shown as blocked with the reason;
          nothing is guessed.
        </Callout>
      ) : null}
      <RunCard project={project} overview={o} sectionLink={sectionLink} />
      <RegisterCard overview={o} sectionLink={sectionLink} />
      <BuildCountsCard overview={o} sectionLink={sectionLink} />
      {o.target_design ? <TargetDesignCard design={o.target_design} /> : null}
    </div>
  );
}

function RunCard({
  project,
  overview: o,
  sectionLink,
}: {
  project: Project;
  overview: DesignOverview;
  sectionLink: (s: DesignSection, children: ReactNode) => ReactNode;
}) {
  const qc = useQueryClient();
  const [starting, setStarting] = useState(false);
  const run = o.latest_run;
  const active = run !== null && ACTIVE.includes(run.status);
  const why = !o.can_run
    ? 'Starting a design run needs stage management on this project and permission to read the tenant’s sources.'
    : active
      ? 'A design run is already running for this project.'
      : null;
  return (
    <Card aria-labelledby="design-run-head">
      <CardHeader
        titleId="design-run-head"
        title="Design run"
        description="Reads the source live through its adapter, uses the newest discovery, version delta, scope register, code conversion and the pinned target baseline, and proposes every stream. A new run keeps people’s decisions on items whose source has not changed."
        actions={
          <Button
            variant="primary"
            leadingIcon={<Play aria-hidden="true" />}
            disabled={why !== null}
            aria-describedby={why ? 'design-run-why' : undefined}
            onClick={() => setStarting(true)}
          >
            Start design run
          </Button>
        }
      />
      <CardBody className={s.stack}>
        {why ? (
          <p id="design-run-why" className={`${s.muted} ${s.small}`}>
            {why}
          </p>
        ) : null}
        {active && run.job_id ? (
          <JobProgress
            jobId={run.job_id}
            title="Design run"
            cancellable
            onFinished={() =>
              void qc.invalidateQueries({ queryKey: designKeys.project(project.id) })
            }
          />
        ) : null}
        {run === null ? (
          <p className={s.muted}>No design run yet. Start one to propose the design.</p>
        ) : (
          <RunSummary run={run} sectionLink={sectionLink} />
        )}
      </CardBody>
      {starting ? <StartRunDialog project={project} onClose={() => setStarting(false)} /> : null}
    </Card>
  );
}

function RunSummary({
  run,
  sectionLink,
}: {
  run: DesignRun;
  sectionLink: (s: DesignSection, children: ReactNode) => ReactNode;
}) {
  const st = runStatus(run.status);
  const sm = run.summary;
  const blocked = Object.entries(sm.blocked ?? {});
  const problems = sm.problems ?? [];
  const streams = DESIGN_STREAMS.filter((x) => sm.streams?.[x]);
  const gaps = sm.mapping?.required_unmapped ?? [];
  return (
    <div className={s.stack}>
      <span className={s.row}>
        <StatusPill tone={st.tone} pulse={run.status === 'running'}>
          {st.label}
        </StatusPill>
        <span className={`${s.muted} ${s.small}`}>
          Requested by {run.requested_by ?? 'unknown'}
          {run.created_at ? (
            <>
              {' '}
              · <Timestamp value={run.created_at} />
            </>
          ) : null}
          {run.finished_at ? (
            <>
              {' '}
              · finished <Timestamp value={run.finished_at} />
            </>
          ) : null}
        </span>
      </span>
      {run.status_detail ? (
        <Callout tone={run.status === 'succeeded' ? 'info' : 'danger'} title={st.label}>
          {run.status_detail}
        </Callout>
      ) : null}
      {run.status === 'succeeded' ? (
        <p className={s.small}>
          <strong>{(sm.review_items ?? 0).toLocaleString()}</strong> review item(s) were created for
          decisions that need an expert.
        </p>
      ) : null}
      {blocked.length > 0 ? (
        <Callout tone="warning" title="Blocked streams">
          <ul className={styles.bullets}>
            {blocked.map(([k, why]) => (
              <li key={k}>
                <strong>
                  {k === 'target'
                    ? 'Target'
                    : ((SECTION_LABELS as Record<string, string | undefined>)[k] ?? k)}
                  :
                </strong>{' '}
                {why}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
      {streams.length > 0 ? (
        <section className={styles.section} aria-labelledby="run-streams">
          <h3 id="run-streams" className={styles.sectionTitle}>
            What the run proposed
          </h3>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="sr-only">Items proposed per stream by the latest run</caption>
              <thead>
                <tr>
                  <th scope="col">Stream</th>
                  <th scope="col" className={styles.num}>
                    Items
                  </th>
                  {DESIGN_STATUSES.filter((x) => x !== 'approved' && x !== 'rejected').map((x) => (
                    <th key={x} scope="col" className={styles.num}>
                      {DESIGN_STATUS[x].label}
                    </th>
                  ))}
                  <th scope="col" className={styles.num}>
                    Decisions kept
                  </th>
                </tr>
              </thead>
              <tbody>
                {streams.map((x) => {
                  const r = sm.streams?.[x];
                  return (
                    <tr key={x}>
                      <th scope="row">{sectionLink(x, STREAM_INFO[x].label)}</th>
                      <td className={styles.num}>{(r?.items ?? 0).toLocaleString()}</td>
                      <td className={styles.num}>{(r?.proposed ?? 0).toLocaleString()}</td>
                      <td className={styles.num}>{(r?.in_review ?? 0).toLocaleString()}</td>
                      <td className={styles.num}>{(r?.blocked ?? 0).toLocaleString()}</td>
                      <td className={styles.num}>{(r?.kept_decisions ?? 0).toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {gaps.length > 0 ? <RequiredUnmapped gaps={gaps} /> : null}
      {problems.length > 0 ? (
        <Callout tone="warning" title={`${String(problems.length)} problem(s) reading the source`}>
          <ul className={styles.bullets}>
            {problems.map((p, i) => (
              <li key={`${String(i)}:${p}`}>{p}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
    </div>
  );
}

/** Required target columns that no source column maps to (from the run summary). */
export function RequiredUnmapped({
  gaps,
}: {
  gaps: { source_table: string; target_table: string; required_unmapped: string[] }[];
}) {
  return (
    <Callout tone="warning" title="Required target columns nothing maps to">
      <p className={s.small}>
        Build fails a transformation’s tests while a required target column is unmapped. Change a
        mapping’s target to one of these, or decide how the target fills it.
      </p>
      <ul className={styles.bullets}>
        {gaps.map((g) => (
          <li key={`${g.source_table}->${g.target_table}`}>
            <Mono className={s.xs}>{g.source_table}</Mono> →{' '}
            <Mono className={s.xs}>{g.target_table}</Mono>:{' '}
            {g.required_unmapped.map((c, i) => (
              <span key={c}>
                {i > 0 ? ', ' : ''}
                <Mono className={s.xs}>{c}</Mono>
              </span>
            ))}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

function StartRunDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const conns = useSourceConnections(project.tenant_id);
  const start = useStartDesignRun(project.id);
  const [connectionId, setConnectionId] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const client: FieldErrors<'connection_id'> = {};
  if (!connectionId) client.connection_id = 'Choose a checked source connection.';
  const errors = mergeFieldErrors(client, start.error, submitted);
  const checked = (c: { last_check: Record<string, unknown> | null }) =>
    c.last_check?.status === 'succeeded';
  const list = conns.data ?? [];
  const unchecked = list.filter((c) => !checked(c)).length;
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Start a design run"
      description="Runs in the background. Needs a source connection whose check has passed (proving the account is read-only) and a pinned target baseline."
      submitLabel="Start design run"
      pending={start.isPending}
      error={start.error}
      fields={['connection_id']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(client)) return;
        start.mutate(
          { connection_id: connectionId },
          {
            onSuccess: () => {
              toast.info('Design run started');
              onClose();
            },
          },
        );
      }}
    >
      {conns.isError ? (
        <ApiErrorView error={conns.error} title="Could not list source connections" compact />
      ) : null}
      <Field
        label="Source connection"
        error={errors.connection_id}
        required
        help={
          unchecked > 0
            ? `${String(unchecked)} connection(s) are not checked and cannot be chosen; run a connection check on the Sources screen first.`
            : undefined
        }
      >
        <Select
          options={list.map((c) => ({
            value: c.id,
            label: `${c.name} (${c.engine})${checked(c) ? '' : ' · not checked'}`,
            disabled: !checked(c),
          }))}
          value={connectionId}
          onValueChange={setConnectionId}
          placeholder={
            conns.isPending
              ? 'Loading…'
              : list.length === 0
                ? 'No source connections'
                : 'Choose a connection'
          }
        />
      </Field>
    </FormDialog>
  );
}

function RegisterCard({
  overview: o,
  sectionLink,
}: {
  overview: DesignOverview;
  sectionLink: (s: DesignSection, children: ReactNode) => ReactNode;
}) {
  const total = DESIGN_STREAMS.reduce(
    (n, x) => n + Object.values(o.counts[x] ?? {}).reduce((a, b) => a + b, 0),
    0,
  );
  return (
    <Card aria-labelledby="design-register-head">
      <CardHeader
        titleId="design-register-head"
        title="Design register"
        description="Items per stream and status now, and who decides each stream. Proposals are never decisions: a person approves, rejects or changes each one."
      />
      <CardBody>
        {total === 0 ? <p className={s.muted}>The register is empty. Start a design run.</p> : null}
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Design register items per stream and status</caption>
            <thead>
              <tr>
                <th scope="col">Stream</th>
                {DESIGN_STATUSES.map((x) => (
                  <th key={x} scope="col" className={styles.num}>
                    {DESIGN_STATUS[x].label}
                  </th>
                ))}
                <th scope="col">Decided by</th>
              </tr>
            </thead>
            <tbody>
              {DESIGN_STREAMS.map((x) => (
                <tr key={x}>
                  <th scope="row">{sectionLink(x, STREAM_INFO[x].label)}</th>
                  {DESIGN_STATUSES.map((st) => (
                    <td key={st} className={styles.num}>
                      {(o.counts[x]?.[st] ?? 0).toLocaleString()}
                    </td>
                  ))}
                  <td>
                    <span className={s.row}>
                      <span className={s.small}>{STREAM_INFO[x].owner}</span>
                      {o.can_decide[x] ? <Badge tone="success">You decide</Badge> : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  );
}

function BuildCountsCard({
  overview: o,
  sectionLink,
}: {
  overview: DesignOverview;
  sectionLink: (s: DesignSection, children: ReactNode) => ReactNode;
}) {
  const b = o.build;
  return (
    <Card aria-labelledby="design-build-head">
      <CardHeader
        titleId="design-build-head"
        title="Build"
        description="Code generated from the register’s decisions and tested on the SQL Server workbench. Only approved versions can run."
        actions={sectionLink('build', 'Open build')}
      />
      <CardBody>
        <dl className={disc.metrics}>
          {(
            [
              ['Generated, not tested', b.generated],
              ['Tests failed', b.tests_failed],
              ['Tests passed, awaiting approval', b.tests_passed],
              ['Approved (runnable)', b.approved],
            ] as const
          ).map(([label, n]) => (
            <div key={label} className={disc.metric}>
              <dt className={disc.metricLabel}>{label}</dt>
              <dd className={disc.metricValue}>{n.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      </CardBody>
    </Card>
  );
}

function SourceNote({
  source,
  confidence,
}: {
  source: { reference: string; url: string | null };
  confidence: string;
}) {
  return (
    <span className={`${s.muted} ${s.xs}`}>
      Source:{' '}
      {source.url ? (
        <a href={source.url} rel="noreferrer noopener" target="_blank">
          {source.reference}
        </a>
      ) : (
        source.reference
      )}{' '}
      <Badge tone={CONFIDENCE_TONE[confidence] ?? 'neutral'}>{confidence}</Badge>
    </span>
  );
}

function TargetDesignCard({ design: d }: { design: TargetDesign }) {
  return (
    <Card aria-labelledby="target-design-head">
      <CardHeader
        titleId="target-design-head"
        title="Target design section"
        description="What the pinned target’s adapter records for design and build. A missing part blocks the streams that need it."
      />
      <CardBody className={s.stack}>
        <section className={styles.section} aria-labelledby="td-mech">
          <h3 id="td-mech" className={styles.sectionTitle}>
            Mechanisms ({d.mechanisms.length})
          </h3>
          {d.mechanisms.length === 0 ? (
            <p className={s.muted}>None recorded: integrations and reports are blocked.</p>
          ) : (
            <ul className={styles.plainList}>
              {d.mechanisms.map((m) => (
                <li key={m.key} className={styles.pairSide}>
                  <span className={s.row}>
                    <strong>{m.label}</strong>
                    <Badge>{MECHANISM_KIND[m.kind] ?? m.kind}</Badge>
                    {m.directions.map((dir) => (
                      <Badge key={dir} tone="info">
                        {dir}
                      </Badge>
                    ))}
                    {d.report_access === m.key ? <Badge tone="accent">Report access</Badge> : null}
                  </span>
                  {m.notes ? <span className={s.small}>{m.notes}</span> : null}
                  <SourceNote source={m.source} confidence={m.confidence} />
                </li>
              ))}
            </ul>
          )}
          {!d.report_access ? (
            <p className={`${s.muted} ${s.small}`}>
              No report access mechanism: reports are blocked.
            </p>
          ) : null}
        </section>
        <section className={styles.section} aria-labelledby="td-naming">
          <h3 id="td-naming" className={styles.sectionTitle}>
            Naming rules
          </h3>
          {d.naming ? (
            <>
              <KeyValueList
                items={[
                  { key: 'schema', label: 'Owning schema', value: <Mono>{d.naming.schema}</Mono> },
                  {
                    key: 'prefix',
                    label: 'Prefix',
                    value: d.naming.prefix ? <Mono>{d.naming.prefix}</Mono> : 'None',
                  },
                  { key: 'case', label: 'Case', value: d.naming.case.replace(/_/g, ' ') },
                  { key: 'max', label: 'Maximum length', value: String(d.naming.max_length) },
                ]}
              />
              <SourceNote source={d.naming.source} confidence={d.naming.confidence} />
            </>
          ) : (
            <p className={s.muted}>None recorded: customer code and reports are blocked.</p>
          )}
        </section>
        <section className={styles.section} aria-labelledby="td-ret">
          <h3 id="td-ret" className={styles.sectionTitle}>
            Retirements ({d.retirements.length})
          </h3>
          {d.retirements.length === 0 ? (
            <p className={s.muted}>None recorded.</p>
          ) : (
            <ul className={styles.plainList}>
              {d.retirements.map((r, i) => (
                <li
                  key={`${r.object_type}:${String(i)}`}
                  className={styles.pairSide}
                  data-retire="true"
                >
                  <span className={s.row}>
                    <Mono>{r.object_type}</Mono>
                    {r.name_pattern ? (
                      <span className={s.xs}>
                        names matching <Mono>{r.name_pattern}</Mono>
                      </span>
                    ) : null}
                    {Object.keys(r.when).length > 0 ? (
                      <span className={s.xs}>
                        when <Mono>{JSON.stringify(r.when)}</Mono>
                      </span>
                    ) : null}
                  </span>
                  <span className={s.small}>Replacement: {r.replacement}</span>
                  <SourceNote source={r.source} confidence={r.confidence} />
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className={styles.section} aria-labelledby="td-areas">
          <h3 id="td-areas" className={styles.sectionTitle}>
            Configuration areas ({d.configuration_areas.length})
          </h3>
          {d.configuration_areas.length === 0 ? (
            <p className={s.muted}>None recorded: configuration is blocked.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className="sr-only">Configuration areas</caption>
                <thead>
                  <tr>
                    <th scope="col">Area</th>
                    <th scope="col">Source kinds</th>
                    <th scope="col">Method</th>
                    <th scope="col">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {d.configuration_areas.map((a) => (
                    <tr key={a.key}>
                      <th scope="row">{a.label}</th>
                      <td>
                        <span className={s.badges}>
                          {a.source_kinds.map((k) => (
                            <Mono key={k} className={s.xs}>
                              {k}
                            </Mono>
                          ))}
                        </span>
                      </td>
                      <td>{METHOD_LABELS[a.method] ?? a.method}</td>
                      <td>{a.notes || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <div className={s.grid2}>
          <section className={styles.section} aria-labelledby="td-forms">
            <h3 id="td-forms" className={styles.sectionTitle}>
              Forms
            </h3>
            {d.forms ? (
              <>
                <KeyValueList
                  items={[
                    { key: 'f', label: 'Format', value: d.forms.format.toUpperCase() },
                    {
                      key: 'k',
                      label: 'Form kinds',
                      value: d.forms.source_kinds.join(', '),
                    },
                    {
                      key: 'a',
                      label: 'Already in the format when',
                      value: Object.keys(d.forms.already_when).length ? (
                        <Mono className={s.xs}>{JSON.stringify(d.forms.already_when)}</Mono>
                      ) : (
                        'Not recorded'
                      ),
                    },
                  ]}
                />
                {d.forms.notes ? <p className={s.small}>{d.forms.notes}</p> : null}
                <SourceNote source={d.forms.source} confidence={d.forms.confidence} />
              </>
            ) : (
              <p className={s.muted}>None recorded: no form items are proposed.</p>
            )}
          </section>
          <section className={styles.section} aria-labelledby="td-pages">
            <h3 id="td-pages" className={styles.sectionTitle}>
              Pages
            </h3>
            {d.pages ? (
              <>
                <KeyValueList items={[{ key: 'n', label: 'Page builder', value: d.pages.name }]} />
                {d.pages.notes ? <p className={s.small}>{d.pages.notes}</p> : null}
                <SourceNote source={d.pages.source} confidence={d.pages.confidence} />
              </>
            ) : (
              <p className={s.muted}>None recorded: no page drafts are proposed.</p>
            )}
            <p className={`${s.muted} ${s.xs}`}>
              Security profiles give each new page and report one of:{' '}
              {Object.values(ACCESS_LABELS).join(', ')}.
            </p>
          </section>
        </div>
      </CardBody>
    </Card>
  );
}
