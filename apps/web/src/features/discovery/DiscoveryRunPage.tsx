import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { discoveryKeys, useDiscoveryRun } from '@/api/discovery';
import type { DiscoveryRun } from '@/api/discovery-types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { JobProgress } from '@/app/JobProgress';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Callout,
  Card,
  CardBody,
  CardHeader,
  KeyValueList,
  Mono,
  PageHeader,
  Skeleton,
  StatusPill,
  Tab,
  TabPanel,
  Tabs,
  TabsList,
  Timestamp,
} from '@/ui';
import s from '../shared.module.css';
import { GraphExplorer } from './GraphExplorer';
import {
  countText,
  formatBytes,
  humanize,
  orderedPhases,
  PHASE_LABELS,
  phaseStatus,
  RUN_TAB_LABELS,
  RUN_TABS,
  runStatus,
  type RunTab,
} from './model';
import {
  ConfigurationResult,
  DictionaryResult,
  DocumentsResult,
  InterfacesResult,
  ProfileResult,
  RulesResult,
  UsageResult,
} from './ResultViews';
import styles from './Discovery.module.css';

export interface DiscoveryRunPageProps {
  runId: string;
  tab: RunTab;
  node: string | null;
  unused: boolean;
}

export function DiscoveryRunPage({ runId, tab, node, unused }: DiscoveryRunPageProps) {
  const run = useDiscoveryRun(runId);
  const navigate = useNavigate();
  const qc = useQueryClient();
  useDocumentTitle('Discovery run');
  const crumbs = [{ label: 'Discovery run' }];

  if (run.isPending) {
    return (
      <div aria-busy="true">
        <PageHeader breadcrumbs={crumbs} title={<Skeleton width="16rem" height="1.75rem" />} />
        <Skeleton height="16rem" />
      </div>
    );
  }
  if (run.isError) {
    return (
      <>
        <PageHeader breadcrumbs={crumbs} title="Discovery run" />
        <ApiErrorView
          error={run.error}
          title="Could not load this discovery run"
          onRetry={() => void run.refetch()}
        />
      </>
    );
  }
  const r = run.data;
  const st = runStatus(r.status);
  const done = r.status === 'succeeded';
  const current = RUN_TABS.includes(tab) ? tab : 'summary';
  const go = (next: RunTab) =>
    void navigate({
      to: '/discovery-runs/$runId',
      params: { runId },
      search: { tab: next },
      replace: true,
    });

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: 'Project', to: '/projects/$projectId', params: { projectId: r.project_id } },
          { label: 'Discovery run' },
        ]}
        title={`Discovery of ${r.connection_name ?? 'the source'}`}
        meta={<StatusPill tone={st.tone}>{st.label}</StatusPill>}
        description={
          <>
            <Mono>{r.adapter}</Mono> · {r.window_days}-day window ending{' '}
            <Timestamp value={r.as_of} /> · requested by {r.requested_by}
          </>
        }
      />
      <div className={s.stack}>
        {r.job_id && (r.status === 'queued' || r.status === 'running') ? (
          <JobProgress
            jobId={r.job_id}
            title="Discovery in progress"
            cancellable
            onFinished={() => void qc.invalidateQueries({ queryKey: discoveryKeys.all })}
          />
        ) : null}
        {r.status === 'blocked' ? (
          <Callout tone="warning" title="Blocked">
            {r.status_detail ?? 'Discovery could not start.'}
          </Callout>
        ) : r.status_detail ? (
          <Callout tone={done ? 'info' : 'danger'} title={st.label}>
            {r.status_detail}
          </Callout>
        ) : null}
        <Tabs value={current} onValueChange={(v) => go(v as RunTab)}>
          <TabsList aria-label="Discovery run sections">
            {RUN_TABS.map((t) => (
              <Tab key={t} value={t} disabled={t !== 'summary' && !done}>
                {RUN_TAB_LABELS[t]}
              </Tab>
            ))}
          </TabsList>
          <TabPanel value="summary">
            <SummaryView run={r} />
          </TabPanel>
          {done ? (
            <>
              <TabPanel value="graph">
                <GraphExplorer runId={runId} node={node} unused={unused} />
              </TabPanel>
              <TabPanel value="profile">
                <ProfileResult runId={runId} />
              </TabPanel>
              <TabPanel value="usage">
                <UsageResult runId={runId} />
              </TabPanel>
              <TabPanel value="rules">
                <RulesResult runId={runId} />
              </TabPanel>
              <TabPanel value="interfaces">
                <InterfacesResult runId={runId} />
              </TabPanel>
              <TabPanel value="configuration">
                <ConfigurationResult runId={runId} />
              </TabPanel>
              <TabPanel value="documents">
                <DocumentsResult runId={runId} />
              </TabPanel>
              <TabPanel value="dictionary">
                <DictionaryResult runId={runId} />
              </TabPanel>
            </>
          ) : null}
        </Tabs>
      </div>
    </>
  );
}

function SummaryView({ run: r }: { run: DiscoveryRun }) {
  const sm = r.summary;
  const metrics: [string, string][] = [
    ['Streams covered', typeof sm.coverage_pct === 'number' ? `${String(sm.coverage_pct)}%` : '—'],
    ['Graph nodes', countText(sm.nodes)],
    ['Graph edges', countText(sm.edges)],
    ['Data quality score', typeof sm.estate_score === 'number' ? sm.estate_score.toFixed(1) : '—'],
    ['Business rules', countText(sm.rules)],
    ['Interfaces', countText(sm.interfaces)],
    ['Unused elements', countText(sm.unused)],
    ['Days of activity evidence', countText(sm.evidence_days)],
    ['Configuration items', countText(sm.configuration_items)],
    ['Documents', countText(sm.documents)],
    ['Document storage', formatBytes(sm.document_bytes)],
  ];
  const phases = orderedPhases(r.phases);
  return (
    <div className={s.stack}>
      {Object.keys(sm).length > 0 ? (
        <Card aria-labelledby="disc-summary">
          <CardHeader
            titleId="disc-summary"
            title="Summary"
            actions={
              r.coverage_report_id ? (
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: r.project_id }}
                  search={{ tab: 'discovery' }}
                >
                  Coverage report
                </Link>
              ) : null
            }
          />
          <CardBody className={s.stack}>
            <dl className={styles.metrics}>
              {metrics.map(([label, value]) => (
                <div key={label} className={styles.metric}>
                  <dt className={styles.metricLabel}>{label}</dt>
                  <dd className={styles.metricValue}>{value}</dd>
                </div>
              ))}
            </dl>
            {sm.by_stream ? (
              <KeyValueList
                items={Object.entries(sm.by_stream).map(([k, v]) => ({
                  key: k,
                  label: humanize(k),
                  value: `${v.toLocaleString()} node${v === 1 ? '' : 's'}`,
                }))}
              />
            ) : null}
          </CardBody>
        </Card>
      ) : null}
      <Card aria-labelledby="disc-phases">
        <CardHeader
          titleId="disc-phases"
          title="Phases"
          description="Partial and failed phases say why. A partial phase still produced results; read them with that in mind."
        />
        <CardBody>
          {phases.length === 0 ? (
            <p className={s.muted}>No phase has finished yet.</p>
          ) : (
            <ul className={styles.phaseGrid} aria-label="Discovery phases">
              {phases.map(([key, p]) => {
                const ps = phaseStatus(p.status);
                const counts = Object.entries(p.counts).filter(([, v]) => v !== null);
                return (
                  <li key={key} className={styles.phaseCell} data-status={p.status}>
                    <span className={styles.streamHead}>
                      <strong>{PHASE_LABELS[key] ?? humanize(key)}</strong>
                      <StatusPill tone={ps.tone}>{ps.label}</StatusPill>
                    </span>
                    {p.detail ? <span className={s.small}>{p.detail}</span> : null}
                    {counts.length > 0 ? (
                      <span className={`${s.muted} ${s.xs}`}>
                        {counts.map(([k, v]) => `${humanize(k)}: ${countText(v)}`).join(' · ')}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
