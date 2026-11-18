import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiDownload, withQuery } from './client';
import type {
  Checklist,
  ChecklistItem,
  ChecklistPatch,
  ConversionIn,
  ConversionObjectQuery,
  ConversionRun,
  ConversionTest,
  ConversionTestIn,
  ConvertedObjectDetail,
  ConvertedObjectPage,
  DeltaDifferencePage,
  DeltaIn,
  DeltaLists,
  DeltaRun,
  DifferenceQuery,
  ProjectPatternAdvice,
} from './upgrade-types';

export const upgradeKeys = {
  all: ['upgrade'] as const,
  deltaRuns: (projectId: string) => ['upgrade', 'delta-runs', projectId] as const,
  deltaRun: (id: string) => ['upgrade', 'delta-run', id] as const,
  differences: (id: string, q: DifferenceQuery) => ['upgrade', 'differences', id, q] as const,
  lists: (id: string) => ['upgrade', 'lists', id] as const,
  advice: (projectId: string) => ['upgrade', 'advice', projectId] as const,
  convRuns: (projectId: string) => ['upgrade', 'conversion-runs', projectId] as const,
  convRun: (id: string) => ['upgrade', 'conversion-run', id] as const,
  convObjects: (id: string, q: ConversionObjectQuery) =>
    ['upgrade', 'conversion-objects', id, q] as const,
  convObject: (id: string, type: string, name: string) =>
    ['upgrade', 'conversion-object', id, type, name] as const,
  tests: (projectId: string) => ['upgrade', 'tests', projectId] as const,
  checklist: (projectId: string) => ['upgrade', 'checklist', projectId] as const,
};

const enc = encodeURIComponent;
const ACTIVE = ['queued', 'running'];

// ---------- Version delta ----------

export function useDeltaRuns(projectId: string) {
  return useQuery({
    queryKey: upgradeKeys.deltaRuns(projectId),
    queryFn: ({ signal }) =>
      api.get<DeltaRun[]>(`/projects/${enc(projectId)}/delta-runs`, { signal }),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((r) => ACTIVE.includes(r.status)) ? 4000 : false,
  });
}

export function useStartDelta(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DeltaIn) =>
      api.post<DeltaRun>(`/projects/${enc(projectId)}/delta-runs`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: upgradeKeys.all }),
  });
}

export function useDeltaRun(id: string | null) {
  return useQuery({
    queryKey: upgradeKeys.deltaRun(id ?? ''),
    queryFn: ({ signal }) => api.get<DeltaRun>(`/delta-runs/${enc(id ?? '')}`, { signal }),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && !ACTIVE.includes(q.state.data.status) ? false : 4000),
  });
}

export function useDeltaDifferences(id: string, q: DifferenceQuery, enabled = true) {
  return useQuery({
    queryKey: upgradeKeys.differences(id, q),
    queryFn: ({ signal }) =>
      api.get<DeltaDifferencePage>(withQuery(`/delta-runs/${enc(id)}/differences`, { ...q }), {
        signal,
      }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useDeltaLists(id: string, enabled = true) {
  return useQuery({
    queryKey: upgradeKeys.lists(id),
    queryFn: ({ signal }) => api.get<DeltaLists>(`/delta-runs/${enc(id)}/lists`, { signal }),
    enabled,
    staleTime: Infinity,
  });
}

export function useDeltaExport(id: string) {
  return useMutation({
    mutationFn: (format: 'csv' | 'json') =>
      apiDownload(
        withQuery(`/delta-runs/${enc(id)}/export`, { format }),
        `version-delta-${id}.${format}`,
      ),
  });
}

export function usePatternAdvice(projectId: string) {
  return useQuery({
    queryKey: upgradeKeys.advice(projectId),
    queryFn: ({ signal }) =>
      api.get<ProjectPatternAdvice>(`/projects/${enc(projectId)}/pattern-advice`, { signal }),
  });
}

// ---------- Conversion ----------

export function useConversionRuns(projectId: string) {
  return useQuery({
    queryKey: upgradeKeys.convRuns(projectId),
    queryFn: ({ signal }) =>
      api.get<ConversionRun[]>(`/projects/${enc(projectId)}/conversion-runs`, { signal }),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((r) => ACTIVE.includes(r.status)) ? 4000 : false,
  });
}

export function useStartConversion(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ConversionIn) =>
      api.post<ConversionRun>(`/projects/${enc(projectId)}/conversion-runs`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: upgradeKeys.all }),
  });
}

export function useConversionRun(id: string | null) {
  return useQuery({
    queryKey: upgradeKeys.convRun(id ?? ''),
    queryFn: ({ signal }) =>
      api.get<ConversionRun>(`/conversion-runs/${enc(id ?? '')}`, { signal }),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && !ACTIVE.includes(q.state.data.status) ? false : 4000),
  });
}

export function useConvertedObjects(id: string, q: ConversionObjectQuery, enabled = true) {
  return useQuery({
    queryKey: upgradeKeys.convObjects(id, q),
    queryFn: ({ signal }) =>
      api.get<ConvertedObjectPage>(withQuery(`/conversion-runs/${enc(id)}/objects`, { ...q }), {
        signal,
      }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useConvertedObject(id: string, ref: { type: string; name: string } | null) {
  return useQuery({
    queryKey: upgradeKeys.convObject(id, ref?.type ?? '', ref?.name ?? ''),
    queryFn: ({ signal }) =>
      api.get<ConvertedObjectDetail>(
        withQuery(`/conversion-runs/${enc(id)}/object`, {
          object_type: ref?.type ?? '',
          name: ref?.name ?? '',
        }),
        { signal },
      ),
    enabled: ref !== null,
    staleTime: Infinity,
  });
}

export function useConversionTests(projectId: string) {
  return useQuery({
    queryKey: upgradeKeys.tests(projectId),
    queryFn: ({ signal }) =>
      api.get<ConversionTest[]>(`/projects/${enc(projectId)}/conversion-tests`, { signal }),
  });
}

export function useAddConversionTest(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ConversionTestIn) =>
      api.post<ConversionTest>(`/projects/${enc(projectId)}/conversion-tests`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: upgradeKeys.tests(projectId) }),
  });
}

export function useDeleteConversionTest(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (testId: string) =>
      api.delete<undefined>(`/projects/${enc(projectId)}/conversion-tests/${enc(testId)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: upgradeKeys.tests(projectId) }),
  });
}

// ---------- Hosting checklist ----------

export function useChecklist(projectId: string) {
  return useQuery({
    queryKey: upgradeKeys.checklist(projectId),
    queryFn: ({ signal }) =>
      api.get<Checklist>(`/projects/${enc(projectId)}/checklist`, { signal }),
  });
}

export function useSyncChecklist(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<Checklist>(`/projects/${enc(projectId)}/checklist/sync`),
    onSuccess: (data) => qc.setQueryData(upgradeKeys.checklist(projectId), data),
  });
}

export function useUpdateChecklistItem(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ChecklistPatch }) =>
      api.patch<ChecklistItem>(`/checklist-items/${enc(id)}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: upgradeKeys.checklist(projectId) }),
  });
}
