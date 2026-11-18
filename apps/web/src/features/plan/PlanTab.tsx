import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { usePlanOverview } from '@/api/planning';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import {
  Badge,
  Callout,
  Card,
  CardBody,
  CardHeader,
  KeyValueList,
  Mono,
  Skeleton,
  StatusPill,
  Tab,
  TabPanel,
  Tabs,
  TabsList,
  Timestamp,
} from '@/ui';
import s from '../shared.module.css';
import styles from '../discovery/Discovery.module.css';
import { BaselinesView } from './BaselinesView';
import { ControlsView } from './ControlsView';
import { CutoverView } from './CutoverView';
import { DependenciesView } from './DependenciesView';
import { GapsView } from './GapsView';
import {
  baselineStatus,
  cutoverLabel,
  formatRange,
  humanize,
  PLAN_SECTIONS,
  SECTION_LABELS,
  type PlanSection,
} from './model';
import { RisksView } from './RisksView';
import { ScopeView } from './ScopeView';
import { TasksView } from './TasksView';
import { WavesView } from './WavesView';
import { WorkbenchView } from './WorkbenchView';

/**
 * The project's plan: overview, the planning workbench, scope, dependencies, tasks, controls,
 * waves, risks, cutover, baselines, gaps. The workbench comes second: the overview stays the
 * landing summary for every reader, and the workbench is where the plan is worked on day to day.
 * The section is in the URL when the page passes `section` and `onSection`.
 */
export function PlanTab({
  project,
  section: controlled,
  onSection,
}: {
  project: Project;
  section?: PlanSection;
  onSection?: (s: PlanSection) => void;
}) {
  const [local, setLocal] = useState<PlanSection>('overview');
  const section = controlled ?? local;
  const setSection = onSection ?? setLocal;
  const overview = usePlanOverview(project.id);
  const canManage = overview.data?.can_manage ?? false;
  const canApprove = overview.data?.ready ? overview.data.can_approve : false;
  return (
    <Tabs value={section} onValueChange={(v) => setSection(v as PlanSection)}>
      <TabsList aria-label="Plan sections">
        {PLAN_SECTIONS.map((p) => (
          <Tab key={p} value={p}>
            {SECTION_LABELS[p]}
          </Tab>
        ))}
      </TabsList>
      <TabPanel value="overview">
        <OverviewView project={project} onSection={setSection} />
      </TabPanel>
      <TabPanel value="workbench">
        <WorkbenchView project={project} />
      </TabPanel>
      <TabPanel value="scope">
        <ScopeView project={project} canManage={canManage} />
      </TabPanel>
      <TabPanel value="dependencies">
        <DependenciesView project={project} canManage={canManage} />
      </TabPanel>
      <TabPanel value="tasks">
        <TasksView project={project} canManage={canManage} />
      </TabPanel>
      <TabPanel value="controls">
        <ControlsView project={project} />
      </TabPanel>
      <TabPanel value="waves">
        <WavesView project={project} canManage={canManage} />
      </TabPanel>
      <TabPanel value="risks">
        <RisksView project={project} canManage={canManage} />
      </TabPanel>
      <TabPanel value="cutover">
        <CutoverView project={project} canManage={canManage} />
      </TabPanel>
      <TabPanel value="baselines">
        <BaselinesView project={project} canManage={canManage} canApprove={canApprove} />
      </TabPanel>
      <TabPanel value="gaps">
        <GapsView project={project} />
      </TabPanel>
    </Tabs>
  );
}

function OverviewView({
  project,
  onSection,
}: {
  project: Project;
  onSection: (s: PlanSection) => void;
}) {
  const q = usePlanOverview(project.id);
  if (q.isPending) return <Skeleton height="12rem" />;
  if (q.isError) {
    return (
      <ApiErrorView
        error={q.error}
        title="Could not load the plan"
        onRetry={() => void q.refetch()}
      />
    );
  }
  const o = q.data;
  if (!o.ready) {
    return (
      <Callout tone="warning" title="The plan cannot be produced yet">
        {o.problem}
      </Callout>
    );
  }
  const counts = Object.entries(o.counts);
  return (
    <div className={s.stack}>
      {o.baseline_awaiting_approval ? (
        <Callout
          tone="warning"
          title={`Baseline ${String(o.latest_baseline?.number ?? '')} is waiting for approval`}
          action={
            o.can_approve_waiting ? (
              <Link
                to="/projects/$projectId"
                params={{ projectId: project.id }}
                search={{ tab: 'plan', section: 'baselines' }}
                onClick={(e) => {
                  // Inside the project page, switch section in place (the link stays shareable).
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  onSection('baselines');
                }}
              >
                Review and approve it
              </Link>
            ) : null
          }
        >
          {o.latest_baseline?.proposed_by ? `${o.latest_baseline.proposed_by} proposed it. ` : ''}
          {o.can_approve_waiting
            ? 'You can approve it.'
            : 'A person with plan approval, other than its proposer, approves it.'}
        </Callout>
      ) : null}
      {o.notes.length > 0 || o.missing_packs.length > 0 ? (
        <Callout tone="warning" title="Read the plan with this in mind">
          <ul className={styles.plainList}>
            {o.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
            {o.missing_packs.map((m) => (
              <li key={m}>
                Pack <Mono>{m}</Mono> named by the blueprint cannot be found.
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
      <Card aria-labelledby="plan-status">
        <CardHeader titleId="plan-status" title="Where the plan stands" />
        <CardBody>
          <dl className={styles.metrics}>
            <div className={styles.metric}>
              <dt className={styles.metricLabel}>Total estimate</dt>
              <dd className={styles.metricValue} style={{ fontSize: 'var(--text-md)' }}>
                {formatRange(o.estimate)}
              </dd>
            </div>
            <div className={styles.metric}>
              <dt className={styles.metricLabel}>Scope decisions approved</dt>
              <dd className={styles.metricValue}>
                {o.scope_approved.toLocaleString()} of {(o.counts.scope ?? 0).toLocaleString()}
              </dd>
            </div>
            <div className={styles.metric}>
              <dt className={styles.metricLabel}>Waves fit</dt>
              <dd className={styles.metricValue}>
                {o.waves_fit === null ? 'Not solved' : o.waves_fit ? 'Yes' : 'No'}
              </dd>
            </div>
            <div className={styles.metric}>
              <dt className={styles.metricLabel}>Cutover</dt>
              <dd className={styles.metricValue} style={{ fontSize: 'var(--text-md)' }}>
                {o.cutover_choice ? cutoverLabel(o.cutover_choice.option) : 'Not chosen'}
              </dd>
            </div>
          </dl>
        </CardBody>
      </Card>
      <div className={s.grid2}>
        <Card aria-labelledby="plan-inputs">
          <CardHeader titleId="plan-inputs" title="Inputs" />
          <CardBody>
            <KeyValueList
              items={[
                {
                  key: 'bp',
                  label: 'Blueprint version',
                  value:
                    o.blueprint_version !== null ? `Version ${String(o.blueprint_version)}` : null,
                },
                {
                  key: 'disc',
                  label: 'Discovery run',
                  value: o.discovery_run_id ? (
                    <Link to="/discovery-runs/$runId" params={{ runId: o.discovery_run_id }}>
                      Newest successful run
                    </Link>
                  ) : (
                    'None yet'
                  ),
                },
                {
                  key: 'delta',
                  label: 'Version delta run',
                  value: o.delta_run_id ? (
                    <Mono className={s.xs}>{o.delta_run_id}</Mono>
                  ) : (
                    'None yet'
                  ),
                },
                {
                  key: 'target',
                  label: 'Target adapter',
                  value: o.target_adapter ? <Mono>{o.target_adapter}</Mono> : null,
                },
                {
                  key: 'max',
                  label: 'Largest task',
                  value: `${String(o.max_task_hours)} hours`,
                },
                {
                  key: 'comp',
                  label: 'Compliance packs',
                  value: o.compliance_packs.length ? (
                    <span className={s.badges}>
                      {o.compliance_packs.map((p) => (
                        <Mono key={p} className={s.xs}>
                          {p}
                        </Mono>
                      ))}
                    </span>
                  ) : (
                    'None'
                  ),
                },
              ]}
            />
          </CardBody>
        </Card>
        <Card aria-labelledby="plan-est">
          <CardHeader
            titleId="plan-est"
            title="Estimation packs"
            description="Where the numbers come from. Uncalibrated packs have not been checked against delivered work."
          />
          <CardBody>
            {o.estimation.length === 0 ? (
              <p className={s.muted}>No estimation pack.</p>
            ) : (
              <ul className={styles.plainList}>
                {o.estimation.map((e) => (
                  <li key={e.pack} className={s.cellStack}>
                    <span className={s.row}>
                      <Mono>{e.pack}</Mono>
                      {e.calibrated ? (
                        <Badge tone="success">Calibrated</Badge>
                      ) : (
                        <Badge tone="warning">UNCALIBRATED</Badge>
                      )}
                      {e.rules !== undefined ? (
                        <span className={`${s.muted} ${s.xs}`}>{e.rules} rule(s)</span>
                      ) : null}
                    </span>
                    <span className={`${s.muted} ${s.small}`}>{e.basis}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
      <div className={s.grid2}>
        <Card aria-labelledby="plan-counts">
          <CardHeader titleId="plan-counts" title="Plan contents" />
          <CardBody>
            {counts.length === 0 ? (
              <p className={s.muted}>Nothing generated yet. Start with the scope register.</p>
            ) : (
              <KeyValueList
                items={counts.map(([k, v]) => ({
                  key: k,
                  label: humanize(k),
                  value: v.toLocaleString(),
                }))}
              />
            )}
          </CardBody>
        </Card>
        <Card aria-labelledby="plan-bl">
          <CardHeader titleId="plan-bl" title="Baseline" />
          <CardBody className={s.stackSm}>
            {o.latest_baseline ? (
              <span className={s.row}>
                <StatusPill tone={baselineStatus(o.latest_baseline.status).tone}>
                  {baselineStatus(o.latest_baseline.status).label}
                </StatusPill>
                <span>Baseline {o.latest_baseline.number}</span>
                <span className={`${s.muted} ${s.xs}`}>
                  <Timestamp value={o.latest_baseline.created_at} />
                </span>
              </span>
            ) : (
              <p className={s.muted}>No baseline yet.</p>
            )}
            <p className={`${s.muted} ${s.small}`}>
              {o.approved_baseline_id
                ? 'An approved baseline exists.'
                : 'No baseline is approved yet.'}{' '}
              {o.can_manage ? 'You can change the plan.' : 'You can read the plan.'}{' '}
              {o.can_approve ? 'You can approve baselines proposed by someone else.' : ''}
            </p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
