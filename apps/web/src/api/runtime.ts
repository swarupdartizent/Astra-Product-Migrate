import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { projectKeys } from './blueprints';
import { api, withQuery } from './client';
import type {
  AgentPin,
  AgentRun,
  AgentRunDetail,
  ProjectStage,
  ResolveIn,
  ReviewItem,
  StageStatus,
} from './types';

export type ReviewStatusFilter = 'open' | 'resolved' | 'dismissed' | 'all';

export const runtimeKeys = {
  all: ['runtime'] as const,
  pins: (projectId: string) => ['runtime', 'pins', projectId] as const,
  runs: (projectId: string) => ['runtime', 'runs', projectId] as const,
  run: (runId: string) => ['runtime', 'run', runId] as const,
  reviews: (projectId: string, status: ReviewStatusFilter) =>
    ['runtime', 'reviews', projectId, status] as const,
  review: (id: string) => ['runtime', 'review', id] as const,
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

export function useReviews(projectId: string, status: ReviewStatusFilter) {
  return useQuery({
    queryKey: runtimeKeys.reviews(projectId, status),
    queryFn: ({ signal }) =>
      api.get<ReviewItem[]>(withQuery(`/projects/${enc(projectId)}/reviews`, { status }), {
        signal,
      }),
  });
}

export function useReviewItem(id: string | null) {
  return useQuery({
    queryKey: runtimeKeys.review(id ?? ''),
    queryFn: ({ signal }) => api.get<ReviewItem>(`/review-items/${enc(id ?? '')}`, { signal }),
    enabled: id !== null,
  });
}

export function useResolveReview(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ResolveIn }) =>
      api.post<ReviewItem>(`/review-items/${enc(id)}/resolve`, body),
    onSuccess: (item) => {
      qc.setQueryData(runtimeKeys.review(item.id), (prev: ReviewItem | undefined) => ({
        ...item,
        flagged_text: item.flagged_text ?? prev?.flagged_text ?? null,
      }));
      return qc.invalidateQueries({ queryKey: ['runtime', 'reviews', projectId] });
    },
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
