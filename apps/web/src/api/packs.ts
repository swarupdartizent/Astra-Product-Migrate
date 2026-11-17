import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, withQuery } from './client';
import type {
  Composition,
  ControlPlacement,
  PackDetail,
  PackDiff,
  PackFileContent,
  PackStatus,
  PackSummary,
  PackTestReport,
  PackType,
} from './types';

export const packKeys = {
  all: ['packs'] as const,
  list: (filters: PackListFilters) => ['packs', 'list', filters] as const,
  detail: (name: string, version: string) => ['packs', 'detail', name, version] as const,
  file: (name: string, version: string, path: string) =>
    ['packs', 'file', name, version, path] as const,
  diff: (name: string, from: string, to: string) => ['packs', 'diff', name, from, to] as const,
  controlTypes: ['packs', 'control-types'] as const,
  compose: (refs: readonly string[]) => ['packs', 'compose', [...refs].sort()] as const,
};

export interface PackListFilters {
  type?: PackType;
  status?: PackStatus;
  name?: string;
}

const enc = encodeURIComponent;
const packPath = (name: string, version: string) => `/packs/${enc(name)}/${enc(version)}`;

export function usePacks(filters: PackListFilters = {}, enabled = true) {
  return useQuery({
    queryKey: packKeys.list(filters),
    queryFn: ({ signal }) =>
      api.get<PackSummary[]>(withQuery('/packs', { ...filters }), { signal }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** Published packs, used by the blueprint editor's pickers. */
export function usePublishedPacks(enabled = true) {
  return usePacks({ status: 'published' }, enabled);
}

export function usePack(name: string, version: string) {
  return useQuery({
    queryKey: packKeys.detail(name, version),
    queryFn: ({ signal }) => api.get<PackDetail>(packPath(name, version), { signal }),
  });
}

export function usePackFile(name: string, version: string, path: string | null) {
  return useQuery({
    queryKey: packKeys.file(name, version, path ?? ''),
    queryFn: ({ signal }) =>
      api.get<PackFileContent>(withQuery(`${packPath(name, version)}/file`, { path }), { signal }),
    enabled: path !== null,
    staleTime: Infinity,
  });
}

export function useControlTypes() {
  return useQuery({
    queryKey: packKeys.controlTypes,
    queryFn: ({ signal }) => api.get<ControlPlacement[]>('/packs/control-types', { signal }),
    staleTime: Infinity,
  });
}

export function usePackDiff(name: string, from: string | null, to: string) {
  return useQuery({
    queryKey: packKeys.diff(name, from ?? '', to),
    queryFn: ({ signal }) =>
      api.get<PackDiff>(
        withQuery(`/packs/${enc(name)}/diff`, { from_version: from, to_version: to }),
        { signal },
      ),
    enabled: from !== null && from !== to,
  });
}

/** Composition preview of published packs (name@version). Read-only on the server. */
export function useComposition(refs: readonly string[]) {
  return useQuery({
    queryKey: packKeys.compose(refs),
    queryFn: ({ signal }) => api.post<Composition>('/packs/compose', { packs: refs }, { signal }),
    enabled: refs.length > 0,
    placeholderData: keepPreviousData,
  });
}

function useInvalidatePacks() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: packKeys.all });
}

export function useUploadPack() {
  const invalidate = useInvalidatePacks();
  return useMutation({
    mutationFn: (files: Record<string, string>) => api.post<PackSummary>('/packs', { files }),
    onSuccess: invalidate,
  });
}

export function useTestPack(name: string, version: string) {
  const invalidate = useInvalidatePacks();
  return useMutation({
    mutationFn: () => api.post<PackTestReport>(`${packPath(name, version)}/test`),
    onSettled: invalidate,
  });
}

export function useReviewPack(name: string, version: string) {
  const invalidate = useInvalidatePacks();
  return useMutation({
    mutationFn: (body: { reviewer_name: string; reviewer_role: string }) =>
      api.post<PackSummary>(`${packPath(name, version)}/review`, body),
    onSuccess: invalidate,
  });
}

export function usePublishPack(name: string, version: string) {
  const invalidate = useInvalidatePacks();
  return useMutation({
    mutationFn: () => api.post<PackSummary>(`${packPath(name, version)}/publish`),
    // Publishing re-runs the tests even when it is refused, so refresh either way.
    onSettled: invalidate,
  });
}

export function useDeprecatePack(name: string, version: string) {
  const invalidate = useInvalidatePacks();
  return useMutation({
    mutationFn: (reason: string) =>
      api.post<PackSummary>(`${packPath(name, version)}/deprecate`, { reason }),
    onSuccess: invalidate,
  });
}
