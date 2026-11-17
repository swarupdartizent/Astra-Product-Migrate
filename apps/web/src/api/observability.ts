import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, withQuery } from './client';
import type { SummaryGroupBy, SummaryRow, TraceDetail, TraceRow } from './types';

export const observabilityKeys = {
  all: ['observability'] as const,
  summary: (groupBy: SummaryGroupBy) => ['observability', 'summary', groupBy] as const,
  traces: (status: 'ok' | 'error' | null) => ['observability', 'traces', status] as const,
  trace: (traceId: string) => ['observability', 'trace', traceId] as const,
};

export function useObservabilitySummary(groupBy: SummaryGroupBy) {
  return useQuery({
    queryKey: observabilityKeys.summary(groupBy),
    queryFn: ({ signal }) =>
      api.get<SummaryRow[]>(withQuery('/observability/summary', { group_by: groupBy }), { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useTraces(status: 'ok' | 'error' | null) {
  return useQuery({
    queryKey: observabilityKeys.traces(status),
    queryFn: ({ signal }) =>
      api.get<TraceRow[]>(withQuery('/observability/traces', { status, limit: 50 }), { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useTrace(traceId: string) {
  return useQuery({
    queryKey: observabilityKeys.trace(traceId),
    queryFn: ({ signal }) =>
      api.get<TraceDetail>(`/observability/traces/${encodeURIComponent(traceId)}`, { signal }),
  });
}
