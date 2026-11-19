import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, withQuery } from './client';
import type {
  BreakIn,
  BreakQuery,
  CasesDecisionIn,
  CasesDecisionOut,
  CoexistenceDashboard,
  CoexistenceSchedule,
  CoexistenceScheduleIn,
  DocumentCheckPage,
  DocumentSummary,
  LoadRun,
  LoadRunDetail,
  LoadRunIn,
  ParityCasePage,
  ParityKind,
  ParityRun,
  ParityRunIn,
  ReconBreak,
  RecordPage,
  RecordQuery,
  RecordRef,
  TriageIn,
} from './loads-types';

const enc = encodeURIComponent;
const ACTIVE = ['queued', 'running'];
const POLL_MS = 4000;

export const loadKeys = {
  all: ['loads'] as const,
  project: (projectId: string) => ['loads', projectId] as const,
  runs: (projectId: string) => ['loads', projectId, 'runs'] as const,
  run: (projectId: string, id: string) => ['loads', projectId, 'run', id] as const,
  records: (projectId: string, id: string, q: RecordQuery) =>
    ['loads', projectId, 'records', id, q] as const,
  documents: (projectId: string, id: string, status: string, offset: number) =>
    ['loads', projectId, 'documents', id, status, offset] as const,
  breaks: (projectId: string, q: BreakQuery) => ['loads', projectId, 'breaks', q] as const,
  parityRuns: (projectId: string, kind: string) => ['loads', projectId, 'parity', kind] as const,
  parityCases: (projectId: string, id: string, status: string, offset: number) =>
    ['loads', projectId, 'parity-cases', id, status, offset] as const,
  coexistence: (projectId: string) => ['loads', projectId, 'coexistence'] as const,
};

const base = (projectId: string) => `/projects/${enc(projectId)}`;

/** Loads move counts, breaks, documents and the coexistence dashboard together. */
function useInvalidateProject(projectId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: loadKeys.project(projectId) });
}

// ---------- Load runs ----------

export function useLoadRuns(projectId: string) {
  return useQuery({
    queryKey: loadKeys.runs(projectId),
    queryFn: ({ signal }) => api.get<LoadRun[]>(`${base(projectId)}/load-runs`, { signal }),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((r) => ACTIVE.includes(r.status)) ? POLL_MS : false,
  });
}

export function useLoadRun(projectId: string, id: string | null) {
  return useQuery({
    queryKey: loadKeys.run(projectId, id ?? ''),
    queryFn: ({ signal }) => api.get<LoadRunDetail>(`/load-runs/${enc(id ?? '')}`, { signal }),
    enabled: id !== null,
    refetchInterval: (q) =>
      q.state.data && ACTIVE.includes(q.state.data.status) ? POLL_MS : false,
  });
}

export function useStartLoadRun(projectId: string) {
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: (body: LoadRunIn) => api.post<LoadRun>(`${base(projectId)}/load-runs`, body),
    onSuccess: invalidate,
  });
}

export function useReload(projectId: string, runId: string) {
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: (records: RecordRef[]) =>
      api.post<LoadRun>(`/load-runs/${enc(runId)}/reload`, { records }),
    onSuccess: invalidate,
  });
}

// ---------- Error queue ----------

export function useLoadRecords(projectId: string, runId: string | null, q: RecordQuery) {
  return useQuery({
    queryKey: loadKeys.records(projectId, runId ?? '', q),
    queryFn: ({ signal }) =>
      api.get<RecordPage>(withQuery(`/load-runs/${enc(runId ?? '')}/records`, { ...q }), {
        signal,
      }),
    enabled: runId !== null,
    placeholderData: keepPreviousData,
  });
}

export function useTriageRecord(projectId: string, runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TriageIn) =>
      api.patch<{ ok: boolean }>(`/load-runs/${enc(runId)}/records`, body),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['loads', projectId, 'records', runId] as const }),
  });
}

// ---------- Documents ----------

export function useDocumentChecks(
  projectId: string,
  runId: string | null,
  status: string,
  offset: number,
) {
  return useQuery({
    queryKey: loadKeys.documents(projectId, runId ?? '', status, offset),
    queryFn: ({ signal }) =>
      api.get<DocumentCheckPage>(
        withQuery(`/load-runs/${enc(runId ?? '')}/document-checks`, {
          status,
          offset,
          limit: 100,
        }),
        { signal },
      ),
    enabled: runId !== null,
    placeholderData: keepPreviousData,
  });
}

export function useRunDocumentChecks(projectId: string, runId: string) {
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: () => api.post<DocumentSummary>(`/load-runs/${enc(runId)}/document-checks`),
    onSuccess: invalidate,
  });
}

// ---------- Reconciliation breaks ----------

export function useBreaks(projectId: string, q: BreakQuery) {
  return useQuery({
    queryKey: loadKeys.breaks(projectId, q),
    queryFn: ({ signal }) =>
      api.get<ReconBreak[]>(withQuery(`${base(projectId)}/recon-breaks`, { ...q }), { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useUpdateBreak(projectId: string) {
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: BreakIn }) =>
      api.patch<ReconBreak>(`/recon-breaks/${enc(id)}`, body),
    onSuccess: invalidate,
  });
}

// ---------- Parity ----------

export function useParityRuns(projectId: string, kind: ParityKind | '') {
  return useQuery({
    queryKey: loadKeys.parityRuns(projectId, kind),
    queryFn: ({ signal }) =>
      api.get<ParityRun[]>(withQuery(`${base(projectId)}/parity-runs`, { kind }), { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useStartParityRun(projectId: string) {
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: (body: ParityRunIn) => api.post<ParityRun>(`${base(projectId)}/parity-runs`, body),
    onSuccess: invalidate,
  });
}

export function useParityCases(
  projectId: string,
  runId: string | null,
  status: string,
  offset: number,
) {
  return useQuery({
    queryKey: loadKeys.parityCases(projectId, runId ?? '', status, offset),
    queryFn: ({ signal }) =>
      api.get<ParityCasePage>(
        withQuery(`/parity-runs/${enc(runId ?? '')}/cases`, { status, offset, limit: 100 }),
        { signal },
      ),
    enabled: runId !== null,
    placeholderData: keepPreviousData,
  });
}

export function useDecideCases(projectId: string, runId: string) {
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: (body: CasesDecisionIn) =>
      api.post<CasesDecisionOut>(`/parity-runs/${enc(runId)}/cases/decide`, body),
    onSuccess: invalidate,
  });
}

// ---------- Coexistence ----------

export function useCoexistence(projectId: string) {
  return useQuery({
    queryKey: loadKeys.coexistence(projectId),
    queryFn: ({ signal }) =>
      api.get<CoexistenceDashboard>(`${base(projectId)}/coexistence`, { signal }),
  });
}

export function useSetCoexistenceSchedule(projectId: string) {
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: (body: CoexistenceScheduleIn) =>
      api.put<CoexistenceSchedule>(`${base(projectId)}/coexistence-schedule`, body),
    onSuccess: invalidate,
  });
}

export function useReconcileNow(projectId: string) {
  return useMutation({
    mutationFn: () => api.post<{ job_id: string }>(`${base(projectId)}/coexistence-reconcile`),
  });
}
