import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Play, Radar } from 'lucide-react';
import { useState } from 'react';
import { useSourceConnections } from '@/api/adapters';
import {
  discoveryKeys,
  useCoverageReports,
  useDiscoveryRuns,
  useStartDiscovery,
} from '@/api/discovery';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { JobProgress } from '@/app/JobProgress';
import { hasErrors, mergeFieldErrors, type FieldErrors } from '@/lib/forms';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
  StatusPill,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import { CoverageReportView } from './CoverageReportView';
import { reportStatus, runStatus } from './model';

export function DiscoveryTab({ project }: { project: Project }) {
  const runs = useDiscoveryRuns(project.id);
  const reports = useCoverageReports(project.id);
  const qc = useQueryClient();
  const canRun = project.permissions.includes('source:manage');
  const [starting, setStarting] = useState(false);
  const active = runs.data?.find((r) => r.status === 'queued' || r.status === 'running');
  const current = reports.data?.find((r) => r.status === 'draft' || r.status === 'accepted');
  const older = (reports.data ?? []).filter((r) => r !== current);

  return (
    <div className={s.stack}>
      <Card aria-labelledby="disc-runs">
        <CardHeader
          titleId="disc-runs"
          title="Discovery runs"
          description="Discovery reads the source through a read-only connection: inventory, dictionary, data profile, usage from imported activity, code, interfaces, configuration and documents. It builds the knowledge graph and a coverage report."
          actions={
            canRun ? (
              <Button
                variant="primary"
                leadingIcon={<Play aria-hidden="true" />}
                onClick={() => setStarting(true)}
                disabled={!!active}
              >
                Run discovery
              </Button>
            ) : null
          }
        />
        <CardBody className={s.stackSm}>
          {active?.job_id ? (
            <JobProgress
              jobId={active.job_id}
              title="Discovery"
              cancellable
              onFinished={() => void qc.invalidateQueries({ queryKey: discoveryKeys.all })}
            />
          ) : null}
          {runs.isPending ? (
            <Skeleton height="4rem" />
          ) : runs.isError ? (
            <ApiErrorView
              error={runs.error}
              title="Could not load discovery runs"
              compact
              onRetry={() => void runs.refetch()}
            />
          ) : runs.data.length === 0 ? (
            <EmptyState
              compact
              icon={<Radar />}
              title="No discovery yet"
              body="Add a source connection on the tenant's Sources tab, pass its connection check, then run discovery."
            />
          ) : (
            <ul style={{ listStyle: 'none' }} className={s.stackSm} aria-label="Discovery runs">
              {runs.data.map((r) => {
                const st = runStatus(r.status);
                return (
                  <li key={r.id} className={s.cellStack}>
                    <span className={s.row}>
                      <StatusPill tone={st.tone}>{st.label}</StatusPill>
                      <Link to="/discovery-runs/$runId" params={{ runId: r.id }}>
                        {r.connection_name ?? 'Source'}, {r.window_days}-day window
                      </Link>
                      {typeof r.summary.coverage_pct === 'number' ? (
                        <span className={s.small}>{r.summary.coverage_pct}% covered</span>
                      ) : null}
                      <span className={`${s.muted} ${s.xs}`}>
                        <Timestamp value={r.created_at} /> · {r.requested_by}
                      </span>
                    </span>
                    {r.status_detail ? <span className={s.small}>{r.status_detail}</span> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      {reports.isPending ? (
        <Skeleton height="10rem" />
      ) : reports.isError ? (
        <ApiErrorView
          error={reports.error}
          title="Could not load coverage reports"
          onRetry={() => void reports.refetch()}
        />
      ) : current ? (
        <CoverageReportView report={current} />
      ) : (
        <Card aria-labelledby="disc-report-none">
          <CardHeader titleId="disc-report-none" title="Coverage report" />
          <CardBody>
            <p className={s.muted}>
              A coverage report is built by each successful discovery run. The discovery stage can
              be marked done only when a report is accepted.
            </p>
          </CardBody>
        </Card>
      )}

      {older.length > 0 ? (
        <Card aria-labelledby="disc-older">
          <CardHeader titleId="disc-older" title="Earlier coverage reports" />
          <CardBody>
            <ul style={{ listStyle: 'none' }} className={s.stackSm}>
              {older.map((r) => {
                const st = reportStatus(r.status);
                return (
                  <li key={r.id} className={s.row}>
                    <StatusPill tone={st.tone}>{st.label}</StatusPill>
                    <span>{r.coverage_pct}% covered</span>
                    <Link to="/discovery-runs/$runId" params={{ runId: r.discovery_run_id }}>
                      Run
                    </Link>
                    <span className={`${s.muted} ${s.xs}`}>
                      <Timestamp value={r.created_at} />
                      {r.decided_by ? ` · decided by ${r.decided_by}` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      {starting ? <StartDialog project={project} onClose={() => setStarting(false)} /> : null}
    </div>
  );
}

function StartDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const conns = useSourceConnections(project.tenant_id);
  const start = useStartDiscovery(project.id);
  const [connectionId, setConnectionId] = useState('');
  const [windowDays, setWindowDays] = useState('90');
  const [asOf, setAsOf] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const client: FieldErrors<'connection_id' | 'window_days' | 'as_of'> = {};
  if (!connectionId) client.connection_id = 'Choose a source connection.';
  const days = Number(windowDays);
  if (!Number.isInteger(days) || days < 7 || days > 730) {
    client.window_days = 'Use a whole number of days between 7 and 730.';
  }
  if (asOf && Number.isNaN(new Date(asOf).getTime())) client.as_of = 'Enter a valid date and time.';
  const errors = mergeFieldErrors(client, start.error, submitted);
  const options = (conns.data ?? []).map((c) => ({
    value: c.id,
    label: `${c.name} (${c.adapter})${c.last_check?.status === 'succeeded' ? '' : ' · not checked'}`,
  }));
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Run discovery"
      description="Runs in the background. Usage is measured from the activity records imported for the connection over the window that ends at the chosen time."
      submitLabel="Start discovery"
      pending={start.isPending}
      error={start.error}
      fields={['connection_id', 'window_days', 'as_of']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(client)) return;
        start.mutate(
          {
            connection_id: connectionId,
            window_days: days,
            ...(asOf ? { as_of: new Date(asOf).toISOString() } : {}),
          },
          {
            onSuccess: () => {
              toast.info('Discovery started');
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
          options={options}
          value={connectionId}
          onValueChange={setConnectionId}
          placeholder={conns.isPending ? 'Loading…' : 'Choose a connection'}
        />
      </Field>
      <Field
        label="Usage window (days)"
        error={errors.window_days}
        help="7 to 730 days. Elements with no use in the window are flagged for retirement review."
        required
      >
        <Input
          type="number"
          inputMode="numeric"
          min={7}
          max={730}
          value={windowDays}
          onChange={(e) => setWindowDays(e.target.value)}
        />
      </Field>
      <Field
        label="Window ends at"
        error={errors.as_of}
        help="Optional; defaults to now. Use the end of the imported activity when it is older."
      >
        <Input type="datetime-local" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
      </Field>
    </FormDialog>
  );
}
