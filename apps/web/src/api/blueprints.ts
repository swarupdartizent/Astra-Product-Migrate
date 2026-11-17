import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, withQuery } from './client';
import { tenantKeys } from './tenancy';
import type {
  ApproveIn,
  BlueprintBody,
  BlueprintDiff,
  BlueprintTemplate,
  BlueprintValidation,
  ConvertOut,
  DecideIn,
  Decision,
  PlanningGate,
  Project,
  ProjectIn,
  SaveVersionIn,
  TemplateIn,
  VersionDetail,
  VersionSummary,
} from './types';

export const projectKeys = {
  all: ['projects'] as const,
  byTenant: (tenantId: string) => ['projects', 'tenant', tenantId] as const,
  detail: (id: string) => ['projects', 'detail', id] as const,
  gate: (id: string) => ['projects', 'gate', id] as const,
  versions: (id: string) => ['projects', 'versions', id] as const,
  version: (id: string, n: number) => ['projects', 'version', id, n] as const,
  diff: (id: string, a: number, b: number) => ['projects', 'diff', id, a, b] as const,
  decisions: (id: string) => ['projects', 'decisions', id] as const,
  validate: (id: string, body: BlueprintBody) => ['projects', 'validate', id, body] as const,
};

export const templateKeys = {
  all: ['templates'] as const,
};

const enc = encodeURIComponent;

// ---------- Projects ----------

export function useTenantProjects(tenantId: string) {
  return useQuery({
    queryKey: projectKeys.byTenant(tenantId),
    queryFn: ({ signal }) => api.get<Project[]>(`/tenants/${enc(tenantId)}/projects`, { signal }),
  });
}

export function useProject(projectId: string) {
  return useQuery({
    queryKey: projectKeys.detail(projectId),
    queryFn: ({ signal }) => api.get<Project>(`/projects/${enc(projectId)}`, { signal }),
  });
}

export function usePlanningGate(projectId: string) {
  return useQuery({
    queryKey: projectKeys.gate(projectId),
    queryFn: ({ signal }) =>
      api.get<PlanningGate>(`/projects/${enc(projectId)}/planning-gate`, { signal }),
  });
}

export function useCreateProject(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProjectIn) => api.post<Project>(`/tenants/${enc(tenantId)}/projects`, body),
    onSuccess: (project) => {
      qc.setQueryData(projectKeys.detail(project.id), project);
      return qc.invalidateQueries({ queryKey: projectKeys.byTenant(tenantId) });
    },
  });
}

/** Everything that changes when a version is saved, approved or a decision is made. */
function useInvalidateProject(projectId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: projectKeys.all }),
      qc.invalidateQueries({ queryKey: tenantKeys.all }),
    ]).then(() => qc.removeQueries({ queryKey: ['projects', 'validate', projectId] }));
}

// ---------- Blueprint versions ----------

export function useVersions(projectId: string) {
  return useQuery({
    queryKey: projectKeys.versions(projectId),
    queryFn: ({ signal }) =>
      api.get<VersionSummary[]>(`/projects/${enc(projectId)}/blueprint/versions`, { signal }),
  });
}

export function useVersion(projectId: string, number: number | null) {
  return useQuery({
    queryKey: projectKeys.version(projectId, number ?? 0),
    queryFn: ({ signal }) =>
      api.get<VersionDetail>(`/projects/${enc(projectId)}/blueprint/versions/${number ?? 0}`, {
        signal,
      }),
    enabled: number !== null,
  });
}

export function useSaveVersion(projectId: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: (body: SaveVersionIn) =>
      api.post<VersionDetail>(`/projects/${enc(projectId)}/blueprint/versions`, body),
    onSuccess: (version) => {
      qc.setQueryData(projectKeys.version(projectId, version.number), version);
      return invalidate();
    },
  });
}

export function useVersionDecision(projectId: string, number: number) {
  const qc = useQueryClient();
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: (body: ApproveIn) =>
      api.post<VersionDetail>(
        `/projects/${enc(projectId)}/blueprint/versions/${number}/decision`,
        body,
      ),
    onSuccess: (version) => {
      qc.setQueryData(projectKeys.version(projectId, version.number), version);
      return invalidate();
    },
  });
}

export function useBlueprintDiff(projectId: string, from: number | null, to: number | null) {
  return useQuery({
    queryKey: projectKeys.diff(projectId, from ?? 0, to ?? 0),
    queryFn: ({ signal }) =>
      api.get<BlueprintDiff>(
        withQuery(`/projects/${enc(projectId)}/blueprint/diff`, {
          from_version: from,
          to_version: to,
        }),
        { signal },
      ),
    enabled: from !== null && to !== null && from !== to,
  });
}

/** Validate unsaved content or YAML. Nothing is stored. */
export function validateBlueprint(projectId: string, body: BlueprintBody, signal?: AbortSignal) {
  return api.post<BlueprintValidation>(
    `/projects/${enc(projectId)}/blueprint/validate`,
    body,
    signal ? { signal } : {},
  );
}

export function useBlueprintValidation(projectId: string, body: BlueprintBody | null) {
  return useQuery({
    queryKey: projectKeys.validate(projectId, body ?? { content: {} }),
    queryFn: ({ signal }) => validateBlueprint(projectId, body ?? { content: {} }, signal),
    enabled: body !== null,
    placeholderData: (previous) => previous,
    staleTime: 0,
  });
}

/** Form ↔ file: content → canonical YAML, or YAML → content. 422 when YAML is invalid. */
export function convertBlueprint(body: BlueprintBody) {
  return api.post<ConvertOut>('/blueprints/convert', body);
}

// ---------- Decisions ----------

export function useDecisions(projectId: string) {
  return useQuery({
    queryKey: projectKeys.decisions(projectId),
    queryFn: ({ signal }) =>
      api.get<Decision[]>(`/projects/${enc(projectId)}/decisions`, { signal }),
  });
}

export function useDecide(projectId: string) {
  const invalidate = useInvalidateProject(projectId);
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: DecideIn }) =>
      api.post<Decision>(`/decisions/${enc(id)}`, body),
    onSuccess: invalidate,
  });
}

// ---------- Templates ----------

export function useTemplates(enabled = true) {
  return useQuery({
    queryKey: templateKeys.all,
    queryFn: ({ signal }) => api.get<BlueprintTemplate[]>('/blueprint-templates', { signal }),
    enabled,
  });
}

export function useCreateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TemplateIn) => api.post<BlueprintTemplate>('/blueprint-templates', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: templateKeys.all }),
  });
}
