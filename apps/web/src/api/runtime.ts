import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { projectKeys } from './blueprints';
import { api, withQuery } from './client';
import type {
  AgentPin,
  AgentRun,
  AgentRunDetail,
  AssistantRun,
  ReviewDecideIn,
  ReviewDecideOut,
  ProjectStage,
  ReviewItem,
  ReviewQueue,
  ReviewQueueQuery,
  ReviewWorkbench,
  StageStatus,
} from './types';

export const runtimeKeys = {
  all: ['runtime'] as const,
  pins: (projectId: string) => ['runtime', 'pins', projectId] as const,
  runs: (projectId: string) => ['runtime', 'runs', projectId] as const,
  run: (runId: string) => ['runtime', 'run', runId] as const,
  reviews: (projectId: string) => ['runtime', 'reviews', projectId] as const,
  queue: (projectId: string, q: ReviewQueueQuery) =>
    ['runtime', 'reviews', projectId, 'queue', q] as const,
  workbench: (id: string) => ['runtime', 'review', id, 'workbench'] as const,
  stages: (projectId: string) => ['runtime', 'stages', projectId] as const,
};

const enc = encodeURIComponent;

export function usePins(projectId: string) {
  return useQuery({
    queryKey: runtimeKeys.pins(projectId),
    queryFn: ({ signal }) => api.get<AgentPin[]>(`/projects/${enc(projectId)}/agents`, { signal }),
  });
}

export function usePinAgent(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agent, version, reason }: { agent: string; version: string; reason: string }) =>
      api.put<AgentPin[]>(`/projects/${enc(projectId)}/agents/${enc(agent)}`, { version, reason }),
    onSuccess: (pins) => {
      qc.setQueryData(runtimeKeys.pins(projectId), pins);
    },
  });
}

const RUN_ACTIVE = ['queued', 'running'];

export function useAgentRuns(projectId: string) {
  return useQuery({
    queryKey: runtimeKeys.runs(projectId),
    queryFn: ({ signal }) =>
      api.get<AgentRun[]>(withQuery(`/projects/${enc(projectId)}/agent-runs`, { limit: 50 }), {
        signal,
      }),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((r) => RUN_ACTIVE.includes(r.status)) ? 3000 : false,
  });
}

export function useAgentRun(runId: string | null) {
  return useQuery({
    queryKey: runtimeKeys.run(runId ?? ''),
    queryFn: ({ signal }) => api.get<AgentRunDetail>(`/agent-runs/${enc(runId ?? '')}`, { signal }),
    enabled: runId !== null,
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s && !RUN_ACTIVE.includes(s) ? false : 2000;
    },
  });
}

export function useStartAgentRun(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { agent: string; objective: string }) =>
      api.post<AgentRun>(`/projects/${enc(projectId)}/agent-runs`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: runtimeKeys.runs(projectId) }),
  });
}

// ---------- Review workbench (I8) ----------

export function useReviewQueue(projectId: string, q: ReviewQueueQuery) {
  return useQuery({
    queryKey: runtimeKeys.queue(projectId, q),
    queryFn: ({ signal }) =>
      api.get<ReviewQueue>(withQuery(`/projects/${enc(projectId)}/review-queue`, { ...q }), {
        signal,
      }),
    placeholderData: keepPreviousData,
  });
}

const ASSISTANT_ACTIVE = ['queued', 'running'];

export function useReviewWorkbench(id: string | null) {
  return useQuery({
    queryKey: runtimeKeys.workbench(id ?? ''),
    queryFn: ({ signal }) =>
      api.get<ReviewWorkbench>(`/review-items/${enc(id ?? '')}/workbench`, { signal }),
    enabled: id !== null,
    // Follow Review Assistant runs until they finish.
    refetchInterval: (query) =>
      (query.state.data?.assistant_runs ?? []).some((r) =>
        ASSISTANT_ACTIVE.includes(r.status ?? ''),
      )
        ? 3000
        : false,
  });
}

/** After any change to an item: refresh its workbench and every queue page of the project. */
function useInvalidateReview(projectId: string) {
  const qc = useQueryClient();
  return (id: string) =>
    Promise.all([
      qc.invalidateQueries({ queryKey: runtimeKeys.workbench(id) }),
      qc.invalidateQueries({ queryKey: runtimeKeys.reviews(projectId) }),
    ]);
}

export function useDecideReview(projectId: string) {
  const inv = useInvalidateReview(projectId);
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ReviewDecideIn }) =>
      api.post<ReviewDecideOut>(`/review-items/${enc(id)}/decide`, body),
    onSuccess: (_out, { id }) => inv(id),
  });
}

export function useAssignReviewer(projectId: string) {
  const inv = useInvalidateReview(projectId);
  return useMutation({
    mutationFn: ({ id, userId }: { id: string; userId: string | null }) =>
      api.put<ReviewItem>(`/review-items/${enc(id)}/reviewer`, { user_id: userId }),
    onSuccess: (_item, { id }) => inv(id),
  });
}

export function useAskAssistant(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, question }: { id: string; question: string }) =>
      api.post<AssistantRun>(`/review-items/${enc(id)}/ask`, { question }),
    onSuccess: (_run, { id }) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: runtimeKeys.workbench(id) }),
        qc.invalidateQueries({ queryKey: runtimeKeys.runs(projectId) }),
      ]),
  });
}

export function useStages(projectId: string) {
  return useQuery({
    queryKey: runtimeKeys.stages(projectId),
    queryFn: ({ signal }) =>
      api.get<ProjectStage[]>(`/projects/${enc(projectId)}/stages`, { signal }),
  });
}

export function useMoveStage(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ stage, status, note }: { stage: string; status: StageStatus; note: string }) =>
      api.put<ProjectStage[]>(`/projects/${enc(projectId)}/stages/${enc(stage)}`, { status, note }),
    onSuccess: (stages) => {
      qc.setQueryData(runtimeKeys.stages(projectId), stages);
      return qc.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
    },
  });
}
