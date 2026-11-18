import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiDownload, withQuery } from './client';
import type {
  ActualsResult,
  Coexistence,
  CoexistenceIn,
  ControlMatrix,
  CutoverAssumptions,
  CutoverChoice,
  CutoverComparison,
  CutoverOption,
  DependencyView,
  Disposition,
  Estimates,
  GapIn,
  GapPatch,
  PlanBaseline,
  PlanDiff,
  PlanGap,
  PlanOverview,
  PlanWorkbench,
  PresalesEstimate,
  PresalesIn,
  Risk,
  RiskIn,
  RiskPatch,
  Runbook,
  ScopeKey,
  ScopeGenerated,
  ScopePage,
  ScopeQuery,
  TaskPage,
  TaskQuery,
  TasksGenerated,
  VendorChanges,
  WaveIn,
  WavePlan,
  WavesView,
  WorkbenchEdit,
  WorkbenchEditResult,
} from './planning-types';

const enc = encodeURIComponent;

export const planKeys = {
  all: ['plan'] as const,
  project: (id: string) => ['plan', id] as const,
  overview: (id: string) => ['plan', id, 'overview'] as const,
  scope: (id: string, q: ScopeQuery) => ['plan', id, 'scope', q] as const,
  deps: (id: string) => ['plan', id, 'deps'] as const,
  scopeKeys: (id: string, q: string) => ['plan', id, 'scope-keys', q] as const,
  workbench: (id: string) => ['plan', id, 'workbench'] as const,
  tasks: (id: string, q: TaskQuery) => ['plan', id, 'tasks', q] as const,
  estimates: (id: string) => ['plan', id, 'estimates'] as const,
  controls: (id: string) => ['plan', id, 'controls'] as const,
  waves: (id: string) => ['plan', id, 'waves'] as const,
  risks: (id: string) => ['plan', id, 'risks'] as const,
  runbook: (id: string) => ['plan', id, 'runbook'] as const,
  coexistence: (id: string) => ['plan', id, 'coexistence'] as const,
  baselines: (id: string) => ['plan', id, 'baselines'] as const,
  diff: (id: string, baselineId: string) => ['plan', id, 'diff', baselineId] as const,
  gaps: (id: string) => ['plan', id, 'gaps'] as const,
  vendorChanges: (programmeId: string) => ['plan', 'vendor-changes', programmeId] as const,
  presales: ['presales'] as const,
  presalesOne: (id: string) => ['presales', id] as const,
};

const base = (projectId: string) => `/projects/${enc(projectId)}/plan`;

/** Every planning change can move other views (scope → tasks → estimates → waves …). */
function useInvalidatePlan(projectId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: planKeys.project(projectId) });
}

// ---------- Overview ----------

export function usePlanOverview(projectId: string) {
  return useQuery({
    queryKey: planKeys.overview(projectId),
    queryFn: ({ signal }) => api.get<PlanOverview>(base(projectId), { signal }),
  });
}

// ---------- Scope ----------

export function useScope(projectId: string, q: ScopeQuery) {
  return useQuery({
    queryKey: planKeys.scope(projectId, q),
    queryFn: ({ signal }) =>
      api.get<ScopePage>(withQuery(`${base(projectId)}/scope`, { ...q }), { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useGenerateScope(projectId: string) {
  const inv = useInvalidatePlan(projectId);
  return useMutation({
    mutationFn: () => api.post<ScopeGenerated>(`${base(projectId)}/scope/generate`),
    onSuccess: inv,
  });
}

export function useDecideScope(projectId: string) {
  const inv = useInvalidatePlan(projectId);
  return useMutation({
    mutationFn: (body: { keys: string[]; disposition: Disposition | null; reason: string }) =>
      api.post<{ decided: number }>(`${base(projectId)}/scope/decisions`, body),
    onSuccess: inv,
  });
}

// ---------- Dependencies ----------

export function useDependencies(projectId: string) {
  return useQuery({
    queryKey: planKeys.deps(projectId),
    queryFn: ({ signal }) => api.get<DependencyView>(`${base(projectId)}/dependencies`, { signal }),
  });
}

export function useAddDependency(projectId: string) {
  const inv = useInvalidatePlan(projectId);
  return useMutation({
    mutationFn: (body: { src: string; dst: string; reason: string }) =>
      api.post<DependencyView>(`${base(projectId)}/dependencies`, body),
    onSuccess: inv,
  });
}

export function useRemoveDependency(projectId: string) {
  const inv = useInvalidatePlan(projectId);
  return useMutation({
    // The reason goes in the body, so it is not kept in URLs and access logs.
    mutationFn: (body: { key: string; reason: string }) =>
      api.post<DependencyView>(`${base(projectId)}/dependencies/remove`, body),
    onSuccess: inv,
  });
}

/** A short list of scope items for pickers (pins, dependencies). */
export function useScopeKeys(projectId: string, q: string, enabled = true) {
  return useQuery({
    queryKey: planKeys.scopeKeys(projectId, q),
    queryFn: ({ signal }) =>
      api.get<ScopeKey[]>(withQuery(`${base(projectId)}/scope/keys`, { q, limit: 50 }), {
        signal,
      }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

// ---------- Planning workbench ----------

export function usePlanWorkbench(projectId: string) {
  return useQuery({
    queryKey: planKeys.workbench(projectId),
    queryFn: ({ signal }) => api.get<PlanWorkbench>(`${base(projectId)}/workbench`, { signal }),
  });
}

/** Applies the edits in one transaction and re-runs the solver; nothing is saved if one fails. */
export function useApplyWorkbenchEdits(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (edits: WorkbenchEdit[]) =>
      api.post<WorkbenchEditResult>(`${base(projectId)}/workbench/edits`, { edits }),
    onSuccess: (out) => {
      const { applied: _a, solve_error: _e, solved_at: _s, ...view } = out;
      qc.setQueryData<PlanWorkbench>(planKeys.workbench(projectId), view);
      return qc.invalidateQueries({
        queryKey: planKeys.project(projectId),
        predicate: (query) => query.queryKey[2] !== 'workbench',
      });
    },
  });
}

// ---------- Tasks and estimates ----------

export function useTasks(projectId: string, q: TaskQuery) {
  return useQuery({
    queryKey: planKeys.tasks(projectId, q),
    queryFn: ({ signal }) =>
      api.get<TaskPage>(withQuery(`${base(projectId)}/tasks`, { ...q }), { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useGenerateTasks(projectId: string) {
  const inv = useInvalidatePlan(projectId);
  return useMutation({
    mutationFn: () => api.post<TasksGenerated>(`${base(projectId)}/tasks/generate`),
    onSuccess: inv,
  });
}

export function useEstimates(projectId: string) {
  return useQuery({
    queryKey: planKeys.estimates(projectId),
    queryFn: ({ signal }) => api.get<Estimates>(`${base(projectId)}/estimates`, { signal }),
  });
}

// ---------- Controls ----------

export function useControls(projectId: string) {
  return useQuery({
    queryKey: planKeys.controls(projectId),
    queryFn: ({ signal }) => api.get<ControlMatrix>(`${base(projectId)}/controls`, { signal }),
  });
}

// ---------- Waves ----------

export function useWaves(projectId: string) {
  return useQuery({
    queryKey: planKeys.waves(projectId),
    queryFn: ({ signal }) => api.get<WavesView>(`${base(projectId)}/waves`, { signal }),
  });
}

export function useSaveWave(projectId: string) {
  const inv = useInvalidatePlan(projectId);
  return useMutation({
    mutationFn: ({ key, body }: { key: string; body: WaveIn }) =>
      api.put<WavesView>(`${base(projectId)}/waves/${enc(key)}`, body),
    onSuccess: inv,
  });
}

export function useDeleteWave(projectId: string) {
  const inv = useInvalidatePlan(projectId);
  return useMutation({
    mutationFn: (key: string) => api.delete<WavesView>(`${base(projectId)}/waves/${enc(key)}`),
    onSuccess: inv,
  });
}

export function usePin(projectId: string) {
  const inv = useInvalidatePlan(projectId);
  return useMutation({
    mutationFn: (body: { scope_key: string; wave: string | null }) =>
      api.post<WavesView>(`${base(projectId)}/pins`, body),
    onSuccess: inv,
  });
}

export function useSolveWaves(projectId: string) {
  const inv = useInvalidatePlan(projectId);
  return useMutation({
    mutationFn: () => api.post<WavePlan>(`${base(projectId)}/waves/solve`),
    onSuccess: inv,
  });
}

// ---------- Risks ----------

export function useRisks(projectId: string) {
  return useQuery({
    queryKey: planKeys.risks(projectId),
    queryFn: ({ signal }) => api.get<Risk[]>(`${base(projectId)}/risks`, { signal }),
  });
}

export function useAddRisk(projectId: string) {
  const inv = useInvalidatePlan(projectId);
  return useMutation({
    mutationFn: (body: RiskIn) => api.post<Risk>(`${base(projectId)}/risks`, body),
    onSuccess: inv,
  });
}

export function useUpdateRisk(projectId: string) {
  const inv = useInvalidatePlan(projectId);
  return useMutation({
    mutationFn: ({ key, patch }: { key: string; patch: RiskPatch }) =>
      api.patch<Risk>(`${base(projectId)}/risks/${enc(key)}`, patch),
    onSuccess: inv,
  });
}

// ---------- Cutover ----------

export function useCompareCutover(projectId: string) {
  return useMutation({
    mutationFn: (assumptions: CutoverAssumptions) =>
      api.post<CutoverComparison>(`${base(projectId)}/cutover/compare`, assumptions),
  });
}

export function useChooseCutover(projectId: string) {
  const inv = useInvalidatePlan(projectId);
  return useMutation({
    mutationFn: (body: {
      option: CutoverOption;
      reason: string;
      assumptions: CutoverAssumptions;
    }) => api.put<CutoverChoice>(`${base(projectId)}/cutover/choice`, body),
    onSuccess: inv,
  });
}

export function useRunbook(projectId: string) {
  return useQuery({
    queryKey: planKeys.runbook(projectId),
    queryFn: ({ signal }) => api.get<Runbook>(`${base(projectId)}/runbook`, { signal }),
  });
}

export function useGenerateRunbook(projectId: string) {
  const inv = useInvalidatePlan(projectId);
  return useMutation({
    mutationFn: () => api.post<Runbook>(`${base(projectId)}/runbook/generate`),
    onSuccess: inv,
  });
}

export function useRecordRehearsal(projectId: string) {
  const inv = useInvalidatePlan(projectId);
  return useMutation({
    mutationFn: (body: { name: string; timings: Record<string, number> }) =>
      api.post<Runbook>(`${base(projectId)}/runbook/rehearsals`, body),
    onSuccess: inv,
  });
}

export function useCoexistence(projectId: string) {
  return useQuery({
    queryKey: planKeys.coexistence(projectId),
    queryFn: ({ signal }) => api.get<Coexistence>(`${base(projectId)}/coexistence`, { signal }),
  });
}

export function useSetCoexistence(projectId: string) {
  const inv = useInvalidatePlan(projectId);
  return useMutation({
    mutationFn: (body: CoexistenceIn) =>
      api.put<Coexistence>(`${base(projectId)}/coexistence`, body),
    onSuccess: inv,
  });
}

// ---------- Baselines, diff, export, actuals ----------

export function usePlanBaselines(projectId: string) {
  return useQuery({
    queryKey: planKeys.baselines(projectId),
    queryFn: ({ signal }) => api.get<PlanBaseline[]>(`${base(projectId)}/baselines`, { signal }),
  });
}

export function useProposeBaseline(projectId: string) {
  const inv = useInvalidatePlan(projectId);
  return useMutation({
    mutationFn: (reason: string) =>
      api.post<PlanBaseline>(`${base(projectId)}/baselines`, { reason }),
    onSuccess: inv,
  });
}

export function useDecideBaseline(projectId: string) {
  const inv = useInvalidatePlan(projectId);
  return useMutation({
    mutationFn: ({ id, approve, note }: { id: string; approve: boolean; note: string }) =>
      api.post<PlanBaseline>(`/plan-baselines/${enc(id)}/decision`, { approve, note }),
    onSuccess: inv,
  });
}

export function usePlanDiff(projectId: string, baselineId: string | null) {
  return useQuery({
    queryKey: planKeys.diff(projectId, baselineId ?? ''),
    queryFn: ({ signal }) =>
      api.get<PlanDiff>(withQuery(`${base(projectId)}/diff`, { baseline_id: baselineId ?? '' }), {
        signal,
      }),
    enabled: baselineId !== null,
  });
}

export function useExportPlan(projectId: string) {
  return useMutation({
    mutationFn: ({ format, target }: { format: 'jira' | 'ado'; target: string }) =>
      apiDownload(withQuery(`${base(projectId)}/export`, { format, target }), `plan-${format}.csv`),
  });
}

export function useImportActuals(projectId: string) {
  const inv = useInvalidatePlan(projectId);
  return useMutation({
    mutationFn: (body: { filename: string; content_base64: string }) =>
      api.post<ActualsResult>(`${base(projectId)}/actuals`, body),
    onSuccess: inv,
  });
}

// ---------- Gaps ----------

export function useGaps(projectId: string) {
  return useQuery({
    queryKey: planKeys.gaps(projectId),
    queryFn: ({ signal }) => api.get<PlanGap[]>(`/projects/${enc(projectId)}/gaps`, { signal }),
  });
}

export function useAddGap(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GapIn) => api.post<PlanGap>(`/projects/${enc(projectId)}/gaps`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: planKeys.gaps(projectId) }),
  });
}

export function useUpdateGap(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: GapPatch }) =>
      api.patch<PlanGap>(`/gaps/${enc(id)}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: planKeys.project(projectId) }),
  });
}

export function useVendorChanges(programmeId: string | null) {
  return useQuery({
    queryKey: planKeys.vendorChanges(programmeId ?? ''),
    queryFn: ({ signal }) =>
      api.get<VendorChanges>(`/programmes/${enc(programmeId ?? '')}/vendor-changes`, { signal }),
    enabled: programmeId !== null,
  });
}

export function useVendorChangesCsv(programmeId: string) {
  return useMutation({
    mutationFn: () =>
      apiDownload(
        withQuery(`/programmes/${enc(programmeId)}/vendor-changes`, { format: 'csv' }),
        'vendor-changes.csv',
      ),
  });
}

// ---------- Pre-sales ----------

export function usePresalesEstimates() {
  return useQuery({
    queryKey: planKeys.presales,
    queryFn: ({ signal }) => api.get<PresalesEstimate[]>('/presales-estimates', { signal }),
  });
}

export function usePresalesEstimate(id: string | null) {
  return useQuery({
    queryKey: planKeys.presalesOne(id ?? ''),
    queryFn: ({ signal }) =>
      api.get<PresalesEstimate>(`/presales-estimates/${enc(id ?? '')}`, { signal }),
    enabled: id !== null,
  });
}

export function useCreatePresales() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PresalesIn) => api.post<PresalesEstimate>('/presales-estimates', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: planKeys.presales }),
  });
}
