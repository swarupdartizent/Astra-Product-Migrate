import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, withQuery } from './client';
import type { Job, JobStatus } from './types';

export const jobKeys = {
  all: ['jobs'] as const,
  detail: (id: string) => ['jobs', 'detail', id] as const,
  list: (filters: JobFilters) => ['jobs', 'list', filters] as const,
};

export interface JobFilters {
  tenant_id?: string;
  project_id?: string;
  status?: string;
}

/** Statuses after which a job never changes again. */
export const FINISHED_JOB_STATUSES: readonly string[] = ['succeeded', 'failed', 'cancelled'];

export function isJobFinished(status: JobStatus): boolean {
  return FINISHED_JOB_STATUSES.includes(status);
}

export const JOB_POLL_MS = 1500;

/** One job, polled while it is queued or running. */
export function useJob(id: string | null) {
  return useQuery({
    queryKey: jobKeys.detail(id ?? ''),
    queryFn: ({ signal }) => api.get<Job>(`/jobs/${encodeURIComponent(id ?? '')}`, { signal }),
    enabled: id !== null,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && isJobFinished(data.status) ? false : JOB_POLL_MS;
    },
    refetchIntervalInBackground: false,
  });
}

export function useJobs(filters: JobFilters, enabled = true) {
  return useQuery({
    queryKey: jobKeys.list(filters),
    queryFn: ({ signal }) =>
      api.get<Job[]>(withQuery('/jobs', { ...filters, limit: 50 }), { signal }),
    enabled,
    // Keep the list fresh while anything in it is still moving.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((j) => !isJobFinished(j.status)) ? 3000 : false,
  });
}

export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Job>(`/jobs/${encodeURIComponent(id)}/cancel`),
    onSuccess: (job) => {
      qc.setQueryData(jobKeys.detail(job.id), job);
      return qc.invalidateQueries({ queryKey: jobKeys.all });
    },
  });
}
