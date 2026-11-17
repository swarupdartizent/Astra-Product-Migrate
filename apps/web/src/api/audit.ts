import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiDownload, withQuery } from './client';
import type { AuditAnchor, AuditFilters, AuditPage, AuditVerify } from './types';

export const auditKeys = {
  all: ['audit'] as const,
  events: (filters: AuditFilters) => ['audit', 'events', filters] as const,
  anchors: ['audit', 'anchors'] as const,
};

export const AUDIT_PAGE_SIZE = 100;

/** Newest first; "Load older" follows next_before_seq (keyset pagination). */
export function useAuditEvents(filters: AuditFilters) {
  return useInfiniteQuery({
    queryKey: auditKeys.events(filters),
    initialPageParam: null as number | null,
    queryFn: ({ pageParam, signal }) =>
      api.get<AuditPage>(
        withQuery('/audit', { ...filters, before_seq: pageParam, limit: AUDIT_PAGE_SIZE }),
        { signal },
      ),
    getNextPageParam: (last) => last.next_before_seq,
  });
}

export function useAuditAnchors(enabled = true) {
  return useQuery({
    queryKey: auditKeys.anchors,
    queryFn: ({ signal }) => api.get<AuditAnchor[]>('/audit/anchors', { signal }),
    enabled,
  });
}

export function useVerifyAudit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<AuditVerify>('/audit/verify'),
    // Verification signs a new anchor and records an audit event.
    onSettled: () => qc.invalidateQueries({ queryKey: auditKeys.all }),
  });
}

export function useExportAudit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ format, filters }: { format: 'csv' | 'jsonl'; filters: AuditFilters }) =>
      apiDownload(withQuery('/audit/export', { format, ...filters }), `audit-export.${format}`),
    // Exporting is itself an audited action.
    onSettled: () => qc.invalidateQueries({ queryKey: auditKeys.all }),
  });
}
