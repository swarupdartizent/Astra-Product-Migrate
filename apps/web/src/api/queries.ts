import { queryOptions, useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { Health, Me } from './types';

/**
 * Query keys live here so invalidation is consistent across features.
 * Feature modules add their own keys under a feature prefix, e.g. ['tenants', ...].
 */
export const queryKeys = {
  health: ['health'] as const,
  me: ['me'] as const,
};

export const healthQuery = queryOptions({
  queryKey: queryKeys.health,
  // A degraded platform may answer 503 with the normal health payload.
  queryFn: ({ signal }) =>
    api.get<Health>('/health', { signal, auth: false, acceptStatuses: [503] }),
  refetchInterval: 60_000,
  staleTime: 15_000,
});

export const meQuery = queryOptions({
  queryKey: queryKeys.me,
  queryFn: ({ signal }) => api.get<Me>('/me', { signal }),
  staleTime: 5 * 60_000,
});

export function useHealth() {
  return useQuery(healthQuery);
}

export function useMe() {
  return useQuery(meQuery);
}
