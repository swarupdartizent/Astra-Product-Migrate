import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, withQuery } from './client';
import type {
  ArtifactQuery,
  BuildArtifact,
  BuildArtifactDetail,
  CodeKeyIn,
  DecisionIn,
  DecisionOut,
  DesignItemDetail,
  DesignItemPage,
  DesignItemQuery,
  DesignOverview,
  DesignRun,
  DesignRunIn,
  DesignStream,
  FormFileIn,
  IntegrationTestIn,
  IntegrationTestRun,
  IntegrationTestRunIn,
  SecurityIn,
} from './design-types';

const enc = encodeURIComponent;
const ACTIVE = ['queued', 'running'];

export const designKeys = {
  all: ['design'] as const,
  project: (projectId: string) => ['design', projectId] as const,
  overview: (projectId: string) => ['design', projectId, 'overview'] as const,
  items: (projectId: string, q: DesignItemQuery) => ['design', projectId, 'items', q] as const,
  item: (projectId: string, stream: DesignStream, key: string) =>
    ['design', projectId, 'item', stream, key] as const,
  artifacts: (projectId: string, q: ArtifactQuery) =>
    ['design', projectId, 'artifacts', q] as const,
  artifact: (projectId: string, id: string) => ['design', projectId, 'artifact', id] as const,
};

const base = (projectId: string) => `/projects/${enc(projectId)}`;

/** Every design change can move counts, readiness and other streams' proposals. */
function useInvalidateProject(projectId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: designKeys.project(projectId) });
}

// ---------- Runs and overview ----------

export function useDesignOverview(projectId: string) {
  return useQuery({
    queryKey: designKeys.overview(projectId),
    queryFn: ({ signal }) => api.get<DesignOverview>(`${base(projectId)}/design`, { signal }),
    refetchInterval: (q) =>
      q.state.data?.latest_run && ACTIVE.includes(q.state.data.latest_run.status) ? 4000 : false,
  });
}

export function useStartDesignRun(projectId: string) {
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: (body: DesignRunIn) => api.post<DesignRun>(`${base(projectId)}/design-runs`, body),
    onSuccess: invalidate,
  });
}

// ---------- Register ----------

export function useDesignItems(projectId: string, q: DesignItemQuery) {
  return useQuery({
    queryKey: designKeys.items(projectId, q),
    queryFn: ({ signal }) =>
      api.get<DesignItemPage>(withQuery(`${base(projectId)}/design/items`, { ...q }), { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useDesignItem(projectId: string, stream: DesignStream, key: string | null) {
  return useQuery({
    queryKey: designKeys.item(projectId, stream, key ?? ''),
    queryFn: ({ signal }) =>
      api.get<DesignItemDetail>(
        withQuery(`${base(projectId)}/design/item`, { stream, key: key ?? '' }),
        { signal },
      ),
    enabled: key !== null,
  });
}

export function useDesignDecision(projectId: string) {
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: (body: DecisionIn) =>
      api.post<DecisionOut>(`${base(projectId)}/design/decisions`, body),
    onSuccess: invalidate,
  });
}

export function useSetSecurity(projectId: string) {
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: (body: SecurityIn) =>
      api.put<DesignItemDetail>(`${base(projectId)}/design/security`, body),
    onSuccess: invalidate,
  });
}

export function useSetCodeKey(projectId: string) {
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: (body: CodeKeyIn) =>
      api.put<DesignItemDetail>(`${base(projectId)}/design/code-key`, body),
    onSuccess: invalidate,
  });
}

export function useSetIntegrationTest(projectId: string) {
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: (body: IntegrationTestIn) =>
      api.put<DesignItemDetail>(`${base(projectId)}/design/integration-test`, body),
    onSuccess: invalidate,
  });
}

export function useRunIntegrationTest(projectId: string) {
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: (body: IntegrationTestRunIn) =>
      api.post<IntegrationTestRun>(`${base(projectId)}/design/integration-test-runs`, body),
    onSuccess: invalidate,
  });
}

export function useUploadFormFile(projectId: string) {
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: (body: FormFileIn) =>
      api.put<DesignItemDetail>(`${base(projectId)}/design/form-files`, body),
    onSuccess: invalidate,
  });
}

export function useFormParity(projectId: string) {
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: (key: string) =>
      api.post<DesignItemDetail>(`${base(projectId)}/design/form-parity`, { key }),
    onSuccess: invalidate,
  });
}

export function useApproveFormLayout(projectId: string) {
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: (body: { key: string; note: string }) =>
      api.post<DesignItemDetail>(`${base(projectId)}/design/form-layout-approval`, body),
    onSuccess: invalidate,
  });
}

// ---------- Build ----------

export function useStartBuild(projectId: string) {
  return useMutation({
    mutationFn: () => api.post<{ job_id: string }>(`${base(projectId)}/build`),
  });
}

export function useBuildArtifacts(projectId: string, q: ArtifactQuery) {
  return useQuery({
    queryKey: designKeys.artifacts(projectId, q),
    queryFn: ({ signal }) =>
      api.get<BuildArtifact[]>(withQuery(`${base(projectId)}/build-artifacts`, { ...q }), {
        signal,
      }),
    placeholderData: keepPreviousData,
  });
}

export function useBuildArtifact(projectId: string, id: string | null) {
  return useQuery({
    queryKey: designKeys.artifact(projectId, id ?? ''),
    queryFn: ({ signal }) =>
      api.get<BuildArtifactDetail>(`/build-artifacts/${enc(id ?? '')}`, { signal }),
    enabled: id !== null,
  });
}

export function useApproveArtifact(projectId: string) {
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      api.post<BuildArtifact>(`/build-artifacts/${enc(id)}/approve`, { note }),
    onSuccess: invalidate,
  });
}
