import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type {
  Agent,
  AgentCatalogItem,
  AgentTestRun,
  AgentVersionDetail,
  GovernanceRecord,
  ManifestValidation,
  ModelReadiness,
  ScreenOut,
  ToolCatalogue,
} from './types';

export const agentKeys = {
  all: ['agents'] as const,
  list: ['agents', 'list'] as const,
  catalog: ['agents', 'catalog'] as const,
  tools: ['agents', 'tools'] as const,
  readiness: ['agents', 'model-readiness'] as const,
  version: (name: string, version: string) => ['agents', 'version', name, version] as const,
  tests: (name: string, version: string) => ['agents', 'tests', name, version] as const,
  testRun: (id: string) => ['agents', 'test-run', id] as const,
  governance: (name: string, version: string) => ['agents', 'governance', name, version] as const,
  governanceAll: ['agents', 'governance-all'] as const,
};

const enc = encodeURIComponent;
const versionPath = (name: string, version: string) =>
  `/agents/${enc(name)}/versions/${enc(version)}`;

export function useAgents() {
  return useQuery({
    queryKey: agentKeys.list,
    queryFn: ({ signal }) => api.get<Agent[]>('/agents', { signal }),
  });
}

export function useAgentCatalog() {
  return useQuery({
    queryKey: agentKeys.catalog,
    queryFn: ({ signal }) => api.get<AgentCatalogItem[]>('/agents/catalog', { signal }),
  });
}

export function useToolCatalogue() {
  return useQuery({
    queryKey: agentKeys.tools,
    queryFn: ({ signal }) => api.get<ToolCatalogue>('/agents/tools', { signal }),
    staleTime: Infinity,
  });
}

export function useModelReadiness() {
  return useQuery({
    queryKey: agentKeys.readiness,
    queryFn: ({ signal }) => api.get<ModelReadiness[]>('/agents/model-readiness', { signal }),
  });
}

export function useAgentVersion(name: string, version: string) {
  return useQuery({
    queryKey: agentKeys.version(name, version),
    queryFn: ({ signal }) => api.get<AgentVersionDetail>(versionPath(name, version), { signal }),
  });
}

export function useAgentTestRuns(name: string, version: string) {
  return useQuery({
    queryKey: agentKeys.tests(name, version),
    queryFn: ({ signal }) =>
      api.get<AgentTestRun[]>(`${versionPath(name, version)}/tests`, { signal }),
  });
}

export function useAgentTestRun(id: string | null) {
  return useQuery({
    queryKey: agentKeys.testRun(id ?? ''),
    queryFn: ({ signal }) => api.get<AgentTestRun>(`/agent-test-runs/${enc(id ?? '')}`, { signal }),
    enabled: id !== null,
  });
}

export function useGovernanceRecord(name: string, version: string) {
  return useQuery({
    queryKey: agentKeys.governance(name, version),
    queryFn: ({ signal }) =>
      api.get<GovernanceRecord>(`${versionPath(name, version)}/governance`, { signal }),
  });
}

export function useAllGovernanceRecords(enabled = true) {
  return useQuery({
    queryKey: agentKeys.governanceAll,
    queryFn: ({ signal }) => api.get<GovernanceRecord[]>('/agents/governance', { signal }),
    enabled,
  });
}

export function validateManifest(manifestYaml: string, signal?: AbortSignal) {
  return api.post<ManifestValidation>(
    '/agents/validate',
    { manifest_yaml: manifestYaml },
    signal ? { signal } : {},
  );
}

export function useManifestValidation(manifestYaml: string) {
  return useQuery({
    queryKey: ['agents', 'validate', manifestYaml] as const,
    queryFn: ({ signal }) => validateManifest(manifestYaml, signal),
    enabled: manifestYaml.trim().length >= 10,
    placeholderData: (previous) => previous,
  });
}

function useInvalidateAgents() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: agentKeys.all });
}

export function useImportCatalog() {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: () => api.post<Agent[]>('/agents/catalog/import'),
    onSuccess: invalidate,
  });
}

export function useRegisterAgentVersion() {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: (manifestYaml: string) =>
      api.post<AgentVersionDetail>('/agents/versions', { manifest_yaml: manifestYaml }),
    onSuccess: invalidate,
  });
}

export function useStartAgentTests(name: string, version: string) {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: () => api.post<AgentTestRun>(`${versionPath(name, version)}/tests`),
    onSuccess: invalidate,
  });
}

export function useReleaseAgentVersion(name: string, version: string) {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: (note: string) =>
      api.post<AgentVersionDetail>(`${versionPath(name, version)}/release`, { note }),
    onSuccess: invalidate,
  });
}

export function useDeprecateAgentVersion(name: string, version: string) {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: (reason: string) =>
      api.post<AgentVersionDetail>(`${versionPath(name, version)}/deprecate`, { reason }),
    onSuccess: invalidate,
  });
}

/** Guardrail lab: nothing is stored. */
export function useScreenText() {
  return useMutation({
    mutationFn: (body: { text: string; source: string }) =>
      api.post<ScreenOut>('/guardrails/screen', body),
  });
}
