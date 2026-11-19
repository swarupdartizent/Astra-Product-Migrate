import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { ReleaseDetail, ReleaseEvaluation, ReleaseIn, ReleaseList } from './releases-types';

export const releaseKeys = {
  all: ['releases'] as const,
  list: () => ['releases', 'list'] as const,
  one: (id: string) => ['releases', 'one', id] as const,
};

/** Release history, newest first (the API returns the latest 100), and whether the caller may record. */
export function useReleases() {
  return useQuery({
    queryKey: releaseKeys.list(),
    queryFn: ({ signal }) => api.get<ReleaseList>('/releases', { signal }),
  });
}

/** One release with its full scorecard. Records are append-only, so a loaded one never changes. */
export function useRelease(id: string | null) {
  return useQuery({
    queryKey: releaseKeys.one(id ?? ''),
    queryFn: ({ signal }) =>
      api.get<ReleaseDetail>(`/releases/${encodeURIComponent(id ?? '')}`, { signal }),
    enabled: id !== null,
    staleTime: Infinity,
  });
}

/**
 * Scores the golden suites now and compares with the latest released scorecard, without recording.
 * A mutation, not a query: each run executes the engines on the server and is started on purpose.
 */
export function useReleaseEvaluation() {
  return useMutation({
    mutationFn: () => api.get<ReleaseEvaluation>('/releases/evaluation'),
  });
}

/** Evaluates and records a release: released when nothing fell, blocked with each regression otherwise. */
export function useRecordRelease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReleaseIn) => api.post<ReleaseDetail>('/releases', body),
    onSuccess: (r) => {
      qc.setQueryData(releaseKeys.one(r.id), r);
      void qc.invalidateQueries({ queryKey: releaseKeys.list() });
    },
  });
}
