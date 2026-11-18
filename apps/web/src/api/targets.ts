import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, withQuery } from './client';
import type {
  Baseline,
  BaselineDetail,
  BaselineIn,
  GoldenDataset,
  GoldenFiles,
  GoldenRun,
  GoldenRunIn,
  LoadCall,
  LoadIn,
  ProjectBaselinePin,
  TargetConnection,
  TargetConnectionIn,
} from './types';

export const targetKeys = {
  all: ['targets'] as const,
  baselines: (adapter: string) => ['targets', 'baselines', adapter] as const,
  baseline: (id: string, params: BaselineQuery) => ['targets', 'baseline', id, params] as const,
  projectBaseline: (projectId: string) => ['targets', 'project-baseline', projectId] as const,
  connections: (tenantId: string) => ['targets', 'connections', tenantId] as const,
  calls: (connectionId: string) => ['targets', 'calls', connectionId] as const,
  golden: ['targets', 'golden'] as const,
  goldenFiles: (adapter: string, version: string, name: string) =>
    ['targets', 'golden-files', adapter, version, name] as const,
  goldenRuns: (dataset: string) => ['targets', 'golden-runs', dataset] as const,
  goldenRun: (id: string) => ['targets', 'golden-run', id] as const,
};

export interface BaselineQuery {
  object_type?: string;
  offset: number;
  limit: number;
}

const enc = encodeURIComponent;
const ACTIVE = ['queued', 'running'];

// ---------- Baselines ----------

export function useBaselines(adapter = '') {
  return useQuery({
    queryKey: targetKeys.baselines(adapter),
    queryFn: ({ signal }) =>
      api.get<Baseline[]>(withQuery('/target-baselines', { adapter }), { signal }),
  });
}

export function useBaseline(id: string, params: BaselineQuery) {
  return useQuery({
    queryKey: targetKeys.baseline(id, params),
    queryFn: ({ signal }) =>
      api.get<BaselineDetail>(withQuery(`/target-baselines/${enc(id)}`, { ...params }), { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useCreateBaseline() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BaselineIn) => api.post<Baseline>('/target-baselines', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: targetKeys.all }),
  });
}

export function useProjectBaseline(projectId: string) {
  return useQuery({
    queryKey: targetKeys.projectBaseline(projectId),
    queryFn: ({ signal }) =>
      api.get<ProjectBaselinePin>(`/projects/${enc(projectId)}/baseline`, { signal }),
  });
}

export function usePinBaseline(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { baseline_id: string; reason: string }) =>
      api.put<ProjectBaselinePin>(`/projects/${enc(projectId)}/baseline`, body),
    onSuccess: (pin) => {
      qc.setQueryData(targetKeys.projectBaseline(projectId), pin);
      return qc.invalidateQueries({ queryKey: ['targets', 'baselines'] });
    },
  });
}

// ---------- Target connections and loads ----------

export function useTargetConnections(tenantId: string) {
  return useQuery({
    queryKey: targetKeys.connections(tenantId),
    queryFn: ({ signal }) =>
      api.get<TargetConnection[]>(`/tenants/${enc(tenantId)}/target-connections`, { signal }),
  });
}

export function useCreateTargetConnection(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TargetConnectionIn) =>
      api.post<TargetConnection>(`/tenants/${enc(tenantId)}/target-connections`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: targetKeys.connections(tenantId) }),
  });
}

export function useStartLoad(connectionId: string) {
  return useMutation({
    mutationFn: (body: LoadIn) =>
      api.post<{ job_id: string }>(`/target-connections/${enc(connectionId)}/loads`, body),
  });
}

export function useLoadCalls(connectionId: string) {
  return useQuery({
    queryKey: targetKeys.calls(connectionId),
    queryFn: ({ signal }) =>
      api.get<LoadCall[]>(`/target-connections/${enc(connectionId)}/calls`, { signal }),
  });
}

// ---------- Golden datasets ----------

export function useGoldenDatasets() {
  return useQuery({
    queryKey: targetKeys.golden,
    queryFn: ({ signal }) => api.get<GoldenDataset[]>('/golden-datasets', { signal }),
  });
}

export function useGoldenFiles(adapter: string, version: string, name: string, enabled = true) {
  return useQuery({
    queryKey: targetKeys.goldenFiles(adapter, version, name),
    queryFn: ({ signal }) =>
      api.get<GoldenFiles>(`/golden-datasets/${enc(adapter)}/${enc(version)}/${enc(name)}/files`, {
        signal,
      }),
    enabled,
    staleTime: Infinity,
  });
}

export function useGoldenRuns(dataset: string) {
  return useQuery({
    queryKey: targetKeys.goldenRuns(dataset),
    queryFn: ({ signal }) =>
      api.get<GoldenRun[]>(withQuery('/golden-runs', { dataset }), { signal }),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((r) => ACTIVE.includes(r.status)) ? 3000 : false,
  });
}

export function useGoldenRun(id: string | null) {
  return useQuery({
    queryKey: targetKeys.goldenRun(id ?? ''),
    queryFn: ({ signal }) => api.get<GoldenRun>(`/golden-runs/${enc(id ?? '')}`, { signal }),
    enabled: id !== null,
    refetchInterval: (q) => (q.state.data && !ACTIVE.includes(q.state.data.status) ? false : 3000),
  });
}

export function useStartGoldenRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GoldenRunIn) => api.post<GoldenRun>('/golden-runs', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: targetKeys.all }),
  });
}
