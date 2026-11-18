import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, withQuery } from './client';
import type {
  ActivityImport,
  ActivityIn,
  CoverageReport,
  DiscoveryRun,
  DiscoveryRunIn,
  GraphNodeDetail,
  GraphPage,
  GraphQuery,
  ResultSection,
  ResultSections,
} from './discovery-types';

export const discoveryKeys = {
  all: ['discovery'] as const,
  activity: (connectionId: string) => ['discovery', 'activity', connectionId] as const,
  runs: (projectId: string) => ['discovery', 'runs', projectId] as const,
  run: (runId: string) => ['discovery', 'run', runId] as const,
  section: (runId: string, section: ResultSection) =>
    ['discovery', 'section', runId, section] as const,
  graph: (runId: string, q: GraphQuery) => ['discovery', 'graph', runId, q] as const,
  node: (runId: string, nodeId: string) => ['discovery', 'node', runId, nodeId] as const,
  reports: (projectId: string) => ['discovery', 'reports', projectId] as const,
};

const enc = encodeURIComponent;
const ACTIVE = ['queued', 'running'];

// ---------- Activity imports ----------

export function useActivityImports(connectionId: string) {
  return useQuery({
    queryKey: discoveryKeys.activity(connectionId),
    queryFn: ({ signal }) =>
      api.get<ActivityImport[]>(`/source-connections/${enc(connectionId)}/activity`, { signal }),
  });
}

export function useUploadActivity(connectionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ActivityIn) =>
      api.post<ActivityImport>(`/source-connections/${enc(connectionId)}/activity`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: discoveryKeys.activity(connectionId) }),
  });
}

// ---------- Runs ----------

export function useDiscoveryRuns(projectId: string) {
  return useQuery({
    queryKey: discoveryKeys.runs(projectId),
    queryFn: ({ signal }) =>
      api.get<DiscoveryRun[]>(`/projects/${enc(projectId)}/discovery-runs`, { signal }),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((r) => ACTIVE.includes(r.status)) ? 4000 : false,
  });
}

export function useStartDiscovery(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DiscoveryRunIn) =>
      api.post<DiscoveryRun>(`/projects/${enc(projectId)}/discovery-runs`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: discoveryKeys.all }),
  });
}

export function useDiscoveryRun(runId: string) {
  return useQuery({
    queryKey: discoveryKeys.run(runId),
    queryFn: ({ signal }) => api.get<DiscoveryRun>(`/discovery-runs/${enc(runId)}`, { signal }),
    refetchInterval: (q) => (q.state.data && !ACTIVE.includes(q.state.data.status) ? false : 4000),
  });
}

/** One result section; only fetched for a succeeded run (the API answers 409 otherwise). */
export function useDiscoveryResult<K extends ResultSection>(
  runId: string,
  section: K,
  enabled = true,
) {
  return useQuery({
    queryKey: discoveryKeys.section(runId, section),
    queryFn: ({ signal }) =>
      api.get<ResultSections[K]>(`/discovery-runs/${enc(runId)}/results/${section}`, { signal }),
    enabled,
    staleTime: Infinity,
  });
}

// ---------- Knowledge graph ----------

export function useGraph(runId: string, q: GraphQuery) {
  return useQuery({
    queryKey: discoveryKeys.graph(runId, q),
    queryFn: ({ signal }) =>
      api.get<GraphPage>(
        withQuery(`/discovery-runs/${enc(runId)}/graph`, {
          kind: q.kind,
          stream: q.stream,
          q: q.q,
          unused: q.unused === undefined ? undefined : String(q.unused),
          offset: q.offset,
          limit: q.limit,
        }),
        { signal },
      ),
    placeholderData: keepPreviousData,
  });
}

export function useGraphNode(runId: string, nodeId: string | null) {
  return useQuery({
    queryKey: discoveryKeys.node(runId, nodeId ?? ''),
    queryFn: ({ signal }) =>
      api.get<GraphNodeDetail>(
        withQuery(`/discovery-runs/${enc(runId)}/graph/nodes`, { node_id: nodeId ?? '' }),
        { signal },
      ),
    enabled: nodeId !== null && nodeId !== '',
    staleTime: Infinity,
  });
}

// ---------- Coverage reports ----------

export function useCoverageReports(projectId: string) {
  return useQuery({
    queryKey: discoveryKeys.reports(projectId),
    queryFn: ({ signal }) =>
      api.get<CoverageReport[]>(`/projects/${enc(projectId)}/coverage-reports`, { signal }),
  });
}

export function useWaiveGap(projectId: string, reportId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { gap_id: string; reason: string }) =>
      api.post<CoverageReport>(`/coverage-reports/${enc(reportId)}/waivers`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: discoveryKeys.reports(projectId) }),
  });
}

export function useDecideReport(projectId: string, reportId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { accept: boolean; note: string }) =>
      api.post<CoverageReport>(`/coverage-reports/${enc(reportId)}/decision`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: discoveryKeys.reports(projectId) });
      // The discovery stage gate depends on the decision.
      void qc.invalidateQueries({ queryKey: ['runtime'] });
    },
  });
}
