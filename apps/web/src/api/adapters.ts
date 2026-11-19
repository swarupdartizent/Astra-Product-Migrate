import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, withQuery } from './client';
import type {
  AdapterContract,
  AdapterRun,
  AdapterRunDetail,
  AdapterRunKind,
  AdapterSummary,
  AdapterTrap,
  AdapterTrapDef,
  SourceConnection,
  SourceConnectionIn,
  SourceObjectDetail,
  SourceObjectPage,
  TargetConstraints,
} from './types';

export const adapterKeys = {
  all: ['adapters'] as const,
  list: ['adapters', 'list'] as const,
  contract: ['adapters', 'contract'] as const,
  traps: (name: string, version?: string) => ['adapters', 'traps', name, version ?? ''] as const,
  constraints: (name: string, version: string) =>
    ['adapters', 'constraints', name, version] as const,
  connections: (tenantId: string) => ['adapters', 'connections', tenantId] as const,
  runs: (connectionId: string) => ['adapters', 'runs', connectionId] as const,
  run: (runId: string) => ['adapters', 'run', runId] as const,
  objects: (runId: string, params: ObjectQuery) => ['adapters', 'objects', runId, params] as const,
  object: (runId: string, type: string, name: string, schema: string) =>
    ['adapters', 'object', runId, type, name, schema] as const,
};

export interface ObjectQuery {
  object_type?: string;
  q?: string;
  offset: number;
  limit: number;
}

const enc = encodeURIComponent;
const ACTIVE = ['queued', 'running'];

export function useAdapters() {
  return useQuery({
    queryKey: adapterKeys.list,
    queryFn: ({ signal }) => api.get<AdapterSummary[]>('/adapters', { signal }),
  });
}

export function useAdapterContract() {
  return useQuery({
    queryKey: adapterKeys.contract,
    queryFn: ({ signal }) => api.get<AdapterContract>('/adapters/contract', { signal }),
    staleTime: Infinity,
  });
}

export function useTraps(name: string, version?: string) {
  return useQuery({
    queryKey: adapterKeys.traps(name, version),
    queryFn: ({ signal }) =>
      api.get<AdapterTrap[]>(withQuery(`/adapters/${enc(name)}/traps`, { version }), { signal }),
  });
}

export function useAddTrap(name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { trap: AdapterTrapDef | Record<string, unknown>; reason: string }) =>
      api.post<AdapterTrap>(`/adapters/${enc(name)}/traps`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: adapterKeys.all }),
  });
}

export function useSetTrapActive(name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ trapId, active, reason }: { trapId: string; active: boolean; reason: string }) =>
      api.put<undefined>(`/adapters/${enc(name)}/traps/${enc(trapId)}/active`, { active, reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: adapterKeys.all }),
  });
}

export function useTargetConstraints(name: string, version: string, enabled = true) {
  return useQuery({
    queryKey: adapterKeys.constraints(name, version),
    queryFn: ({ signal }) =>
      api.get<TargetConstraints>(`/adapters/${enc(name)}/${enc(version)}/constraints`, { signal }),
    enabled,
  });
}

// ---------- Source connections and runs ----------

export function useSourceConnections(tenantId: string) {
  return useQuery({
    queryKey: adapterKeys.connections(tenantId),
    queryFn: ({ signal }) =>
      api.get<SourceConnection[]>(`/tenants/${enc(tenantId)}/source-connections`, { signal }),
  });
}

export function useCreateSourceConnection(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SourceConnectionIn) =>
      api.post<SourceConnection>(`/tenants/${enc(tenantId)}/source-connections`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: adapterKeys.connections(tenantId) }),
  });
}

export function useDeleteSourceConnection(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<undefined>(`/source-connections/${enc(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: adapterKeys.connections(tenantId) }),
  });
}

export function useAdapterRuns(connectionId: string, enabled = true) {
  return useQuery({
    queryKey: adapterKeys.runs(connectionId),
    queryFn: ({ signal }) =>
      api.get<AdapterRun[]>(`/source-connections/${enc(connectionId)}/runs`, { signal }),
    enabled: enabled && connectionId !== '',
    refetchInterval: (q) =>
      (q.state.data ?? []).some((r) => ACTIVE.includes(r.status)) ? 3000 : false,
  });
}

export function useStartAdapterRun(connectionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { kind: AdapterRunKind; mode?: 'full' | 'delta' }) =>
      api.post<AdapterRun>(`/source-connections/${enc(connectionId)}/runs`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: adapterKeys.all }),
  });
}

export function useAdapterRun(runId: string) {
  return useQuery({
    queryKey: adapterKeys.run(runId),
    queryFn: ({ signal }) => api.get<AdapterRunDetail>(`/adapter-runs/${enc(runId)}`, { signal }),
    refetchInterval: (q) =>
      q.state.data && !ACTIVE.includes(q.state.data.run.status) ? false : 3000,
  });
}

export function useRunObjects(runId: string, params: ObjectQuery, enabled = true) {
  return useQuery({
    queryKey: adapterKeys.objects(runId, params),
    queryFn: ({ signal }) =>
      api.get<SourceObjectPage>(withQuery(`/adapter-runs/${enc(runId)}/objects`, { ...params }), {
        signal,
      }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useRunObject(
  runId: string,
  ref: { type: string; name: string; schema: string } | null,
) {
  return useQuery({
    queryKey: adapterKeys.object(runId, ref?.type ?? '', ref?.name ?? '', ref?.schema ?? ''),
    queryFn: ({ signal }) =>
      api.get<SourceObjectDetail>(
        withQuery(
          `/adapter-runs/${enc(runId)}/objects/${enc(ref?.type ?? '')}/${enc(ref?.name ?? '')}`,
          {
            schema: ref?.schema ?? '',
          },
        ),
        { signal },
      ),
    enabled: ref !== null,
    staleTime: Infinity,
  });
}
