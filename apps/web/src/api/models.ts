import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, withQuery } from './client';
import type {
  AliasIn,
  ModelAlias,
  ModelCall,
  ModelProvider,
  ProviderIn,
  ProviderUpdate,
  UsageGroupBy,
  UsageRow,
} from './types';

export const modelKeys = {
  all: ['models'] as const,
  providers: ['models', 'providers'] as const,
  aliases: ['models', 'aliases'] as const,
  usage: (params: UsageParams) => ['models', 'usage', params] as const,
  calls: (params: CallFilters) => ['models', 'calls', params] as const,
};

export interface UsageParams {
  group_by: UsageGroupBy;
  since?: string;
  include_tests?: boolean;
}

export interface CallFilters {
  agent?: string;
  agent_run_id?: string;
  test_run_id?: string;
  status?: string;
}

const enc = encodeURIComponent;

export function useProviders() {
  return useQuery({
    queryKey: modelKeys.providers,
    queryFn: ({ signal }) => api.get<ModelProvider[]>('/models/providers', { signal }),
  });
}

export function useAliases(enabled = true) {
  return useQuery({
    queryKey: modelKeys.aliases,
    queryFn: ({ signal }) => api.get<ModelAlias[]>('/models/aliases', { signal }),
    enabled,
  });
}

export function useModelUsage(params: UsageParams, enabled = true) {
  return useQuery({
    queryKey: modelKeys.usage(params),
    queryFn: ({ signal }) =>
      api.get<UsageRow[]>(withQuery('/models/usage', { ...params }), { signal }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useModelCalls(filters: CallFilters, enabled = true) {
  return useQuery({
    queryKey: modelKeys.calls(filters),
    queryFn: ({ signal }) =>
      api.get<ModelCall[]>(withQuery('/models/calls', { ...filters, limit: 100 }), { signal }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** Provider and alias changes affect readiness everywhere: refresh models and agents. */
function useInvalidateModels() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: modelKeys.all }),
      qc.invalidateQueries({ queryKey: ['agents'] }),
    ]);
}

export function useCreateProvider() {
  const invalidate = useInvalidateModels();
  return useMutation({
    mutationFn: (body: ProviderIn) => api.post<ModelProvider>('/models/providers', body),
    onSuccess: invalidate,
  });
}

export function useUpdateProvider(id: string) {
  const invalidate = useInvalidateModels();
  return useMutation({
    mutationFn: (body: ProviderUpdate) =>
      api.put<ModelProvider>(`/models/providers/${enc(id)}`, body),
    onSuccess: invalidate,
  });
}

export function useSetCredential(id: string) {
  const invalidate = useInvalidateModels();
  return useMutation({
    mutationFn: (apiKey: string) =>
      api.put<ModelProvider>(`/models/providers/${enc(id)}/credential`, { api_key: apiKey }),
    onSuccess: invalidate,
  });
}

export function useCheckProvider(id: string) {
  const invalidate = useInvalidateModels();
  return useMutation({
    mutationFn: () => api.post<ModelProvider>(`/models/providers/${enc(id)}/check`),
    onSuccess: invalidate,
  });
}

export function useDeleteProvider() {
  const invalidate = useInvalidateModels();
  return useMutation({
    mutationFn: (id: string) => api.delete<undefined>(`/models/providers/${enc(id)}`),
    onSuccess: invalidate,
  });
}

export function useSetAlias() {
  const invalidate = useInvalidateModels();
  return useMutation({
    mutationFn: ({ alias, body }: { alias: string; body: AliasIn }) =>
      api.put<ModelAlias>(`/models/aliases/${enc(alias)}`, body),
    onSuccess: invalidate,
  });
}

export function useDeleteAlias() {
  const invalidate = useInvalidateModels();
  return useMutation({
    mutationFn: (alias: string) => api.delete<undefined>(`/models/aliases/${enc(alias)}`),
    onSuccess: invalidate,
  });
}
