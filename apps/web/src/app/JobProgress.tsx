import { useEffect, useRef } from 'react';
import { isJobFinished, useCancelJob, useJob } from '@/api/jobs';
import type { Job, JobRef } from '@/api/types';
import { Button, ProgressBar, StatusPill, Timestamp, toast } from '@/ui';
import { FormError } from './FormError';
import { jobStatus } from './job-status';
import styles from './JobProgress.module.css';

export interface JobProgressProps {
  jobId: string;
  /** Shown until the first poll answers (e.g. TenantOut.active_job). */
  initial?: JobRef | null;
  /** Visible title; defaults to the job's own title. */
  title?: string;
  /** Called once when the job reaches succeeded, failed or cancelled. */
  onFinished?: (job: Job) => void;
  /** Offer "Cancel" while the job is queued (the API refuses some kinds; its reason is shown). */
  cancellable?: boolean;
  compact?: boolean;
}

/**
 * Live progress of a background job: polls GET /jobs/{id} while it is queued or running,
 * announces changes politely, and reports the end exactly once.
 */
export function JobProgress({
  jobId,
  initial,
  title,
  onFinished,
  cancellable = false,
  compact = false,
}: JobProgressProps) {
  const job = useJob(jobId);
  const cancel = useCancelJob();
  const reported = useRef<string | null>(null);
  const onFinishedRef = useRef(onFinished);
  useEffect(() => {
    onFinishedRef.current = onFinished;
  }, [onFinished]);

  const data = job.data;
  useEffect(() => {
    if (data && isJobFinished(data.status) && reported.current !== data.id) {
      reported.current = data.id;
      onFinishedRef.current?.(data);
    }
  }, [data]);

  const status = data?.status ?? initial?.status ?? 'queued';
  const progress = data?.progress ?? initial?.progress ?? 0;
  const message = data?.progress_message ?? initial?.progress_message ?? null;
  const st = jobStatus(status);
  const finished = isJobFinished(status);
  const name = title ?? data?.title ?? 'Background job';

  return (
    <div className={compact ? styles.compact : styles.job} aria-busy={!finished || undefined}>
      <div className={styles.head}>
        <span className={styles.title}>{name}</span>
        <StatusPill tone={st.tone} pulse={status === 'running'}>
          {st.label}
        </StatusPill>
      </div>
      {status === 'failed' ? null : (
        <ProgressBar
          label={`${name} progress`}
          value={status === 'queued' && progress === 0 ? undefined : finished ? 100 : progress}
          valueText={`${finished ? 100 : progress}%${message ? `, ${message}` : ''}`}
          tone={status === 'succeeded' ? 'success' : 'accent'}
        />
      )}
      <p className={styles.message} role="status" aria-live="polite">
        {status === 'failed'
          ? (data?.error ?? 'The job failed.')
          : status === 'queued'
            ? (message ?? 'Waiting for a worker to pick this up.')
            : (message ?? (finished ? '' : `${progress}%`))}
      </p>
      {!compact && data ? (
        <p className={styles.meta}>
          Requested by {data.requested_by || 'unknown'} · <Timestamp value={data.created_at} />
          {data.attempts > 1 ? ` · attempt ${data.attempts} of ${data.max_attempts}` : ''}
        </p>
      ) : null}
      {job.isError && !data ? <FormError error={job.error} /> : null}
      {cancellable && status === 'queued' ? (
        <div>
          <Button
            size="sm"
            variant="secondary"
            loading={cancel.isPending}
            onClick={() =>
              cancel.mutate(jobId, {
                onSuccess: () => toast.success('Job cancelled'),
              })
            }
          >
            Cancel job
          </Button>
          {cancel.isError ? <FormError error={cancel.error} /> : null}
        </div>
      ) : null}
    </div>
  );
}
