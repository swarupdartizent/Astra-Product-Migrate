import { ListChecks } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { isJobFinished, useJobs, type JobFilters } from '@/api/jobs';
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Mono,
  Skeleton,
  StatusPill,
  Timestamp,
} from '@/ui';
import { ApiErrorView } from './ApiErrorView';
import { JobProgress } from './JobProgress';
import { jobStatus } from './job-status';
import styles from './JobProgress.module.css';

export interface JobsCardProps {
  filters: JobFilters;
  title?: string;
  description?: string;
  /** Query keys to refresh when a job finishes. */
  refreshOnFinish?: readonly (readonly unknown[])[];
}

/** Recent background jobs for a tenant or project: live progress for active ones, history below. */
export function JobsCard({
  filters,
  title = 'Background jobs',
  description = 'Work that runs outside the request, such as provisioning and region moves.',
  refreshOnFinish = [],
}: JobsCardProps) {
  const jobs = useJobs(filters);
  const qc = useQueryClient();
  const active = (jobs.data ?? []).filter((j) => !isJobFinished(j.status));
  const finished = (jobs.data ?? []).filter((j) => isJobFinished(j.status)).slice(0, 10);

  return (
    <Card aria-labelledby="jobs-title">
      <CardHeader titleId="jobs-title" title={title} description={description} />
      <CardBody>
        {jobs.isPending ? (
          <Skeleton height="4rem" />
        ) : jobs.isError ? (
          <ApiErrorView
            error={jobs.error}
            title="Could not load jobs"
            compact
            onRetry={() => void jobs.refetch()}
          />
        ) : jobs.data.length === 0 ? (
          <EmptyState compact icon={<ListChecks />} title="No background jobs" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {active.map((j) => (
              <JobProgress
                key={j.id}
                jobId={j.id}
                initial={j}
                cancellable
                onFinished={() => {
                  for (const key of refreshOnFinish) void qc.invalidateQueries({ queryKey: key });
                }}
              />
            ))}
            {finished.length > 0 ? (
              <ul style={{ listStyle: 'none' }} aria-label="Finished jobs">
                {finished.map((j) => {
                  const st = jobStatus(j.status);
                  return (
                    <li
                      key={j.id}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 'var(--space-0-5)',
                        padding: 'var(--space-2) 0',
                        borderBottom: '1px solid var(--color-border-subtle)',
                      }}
                    >
                      <span
                        style={{
                          display: 'flex',
                          gap: 'var(--space-2)',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                        }}
                      >
                        <StatusPill tone={st.tone}>{st.label}</StatusPill>
                        <span>{j.title}</span>
                      </span>
                      <span className={styles.meta}>
                        <Mono>{j.kind}</Mono> · {j.requested_by || 'unknown'} ·{' '}
                        <Timestamp value={j.finished_at ?? j.created_at} />
                      </span>
                      {j.error ? <span className={styles.message}>{j.error}</span> : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
