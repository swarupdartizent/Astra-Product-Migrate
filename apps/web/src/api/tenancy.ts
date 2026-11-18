import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type {
  DeleteIn,
  Partner,
  PartnerIn,
  PolicyIn,
  Programme,
  ProgrammeIn,
  Region,
  RegionMove,
  RegionMoveIn,
  RoleDef,
  RotateIn,
  Secret,
  SecretIn,
  Tenant,
  TenantIn,
} from './types';

// ---------- Query keys (feature prefixes) ----------

export const referenceKeys = {
  all: ['reference'] as const,
  regions: ['reference', 'regions'] as const,
  roles: ['reference', 'roles'] as const,
};

export const programmeKeys = {
  all: ['programmes'] as const,
};

export const tenantKeys = {
  all: ['tenants'] as const,
  list: ['tenants', 'list'] as const,
  detail: (id: string) => ['tenants', 'detail', id] as const,
  secrets: (id: string) => ['tenants', 'secrets', id] as const,
  regionMoves: (id: string) => ['tenants', 'region-migrations', id] as const,
};

const enc = encodeURIComponent;

// ---------- Reference data ----------

export const regionsQuery = queryOptions({
  queryKey: referenceKeys.regions,
  queryFn: ({ signal }) => api.get<Region[]>('/regions', { signal }),
  staleTime: 10 * 60_000,
});

export const rolesQuery = queryOptions({
  queryKey: referenceKeys.roles,
  queryFn: ({ signal }) => api.get<RoleDef[]>('/roles', { signal }),
  staleTime: 10 * 60_000,
});

export function useRegions() {
  return useQuery(regionsQuery);
}

export function useRoles() {
  return useQuery(rolesQuery);
}

// ---------- Programmes and partners ----------

export const programmesQuery = queryOptions({
  queryKey: programmeKeys.all,
  queryFn: ({ signal }) => api.get<Programme[]>('/programmes', { signal }),
});

export function useProgrammes(enabled = true) {
  return useQuery({ ...programmesQuery, enabled });
}

export function useCreateProgramme() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProgrammeIn) => api.post<Programme>('/programmes', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: programmeKeys.all }),
  });
}

export function useAddPartner(programmeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PartnerIn) =>
      api.post<Partner>(`/programmes/${enc(programmeId)}/partners`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: programmeKeys.all }),
  });
}

// ---------- Tenants ----------

export const tenantsQuery = queryOptions({
  queryKey: tenantKeys.list,
  queryFn: ({ signal }) => api.get<Tenant[]>('/tenants', { signal }),
});

export function useTenants(enabled = true) {
  return useQuery({
    ...tenantsQuery,
    enabled,
    // While a tenant is provisioning or moving, keep its status current.
    refetchInterval: (query) => ((query.state.data ?? []).some((t) => t.active_job) ? 3000 : false),
  });
}

export function tenantQuery(id: string) {
  return queryOptions({
    queryKey: tenantKeys.detail(id),
    queryFn: ({ signal }) => api.get<Tenant>(`/tenants/${enc(id)}`, { signal }),
  });
}

export function useTenant(id: string) {
  return useQuery(tenantQuery(id));
}

export function useCreateTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TenantIn) => api.post<Tenant>('/tenants', body),
    onSuccess: (tenant) => {
      qc.setQueryData(tenantKeys.detail(tenant.id), tenant);
      return qc.invalidateQueries({ queryKey: tenantKeys.list });
    },
  });
}

/** Writes a fresh TenantOut into the cache and refreshes the list. */
function useTenantUpdated() {
  const qc = useQueryClient();
  return (tenant: Tenant) => {
    qc.setQueryData(tenantKeys.detail(tenant.id), tenant);
    return qc.invalidateQueries({ queryKey: tenantKeys.list });
  };
}

export function useUpdatePolicy(tenantId: string) {
  const updated = useTenantUpdated();
  return useMutation({
    mutationFn: (body: PolicyIn) => api.put<Tenant>(`/tenants/${enc(tenantId)}/policy`, body),
    onSuccess: updated,
  });
}

export function useDeleteTenant(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DeleteIn) => api.post<Tenant>(`/tenants/${enc(tenantId)}/delete`, body),
    onSuccess: () => {
      qc.removeQueries({ queryKey: tenantKeys.detail(tenantId) });
      return qc.invalidateQueries({ queryKey: tenantKeys.all });
    },
  });
}

export function useRegionMoves(tenantId: string) {
  return useQuery({
    queryKey: tenantKeys.regionMoves(tenantId),
    queryFn: ({ signal }) =>
      api.get<RegionMove[]>(`/tenants/${enc(tenantId)}/region-migrations`, { signal }),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((m) => m.status === 'queued' || m.status === 'running')
        ? 3000
        : false,
  });
}

export function useMoveRegion(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RegionMoveIn) =>
      api.post<RegionMove>(`/tenants/${enc(tenantId)}/region-migrations`, body),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: tenantKeys.regionMoves(tenantId) }),
        qc.invalidateQueries({ queryKey: tenantKeys.detail(tenantId) }),
        qc.invalidateQueries({ queryKey: tenantKeys.list }),
      ]),
  });
}

// ---------- Connector secrets ----------

export function useSecrets(tenantId: string, enabled = true) {
  return useQuery({
    queryKey: tenantKeys.secrets(tenantId),
    queryFn: ({ signal }) => api.get<Secret[]>(`/tenants/${enc(tenantId)}/secrets`, { signal }),
    enabled,
  });
}

export function useCreateSecret(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SecretIn) => api.post<Secret>(`/tenants/${enc(tenantId)}/secrets`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: tenantKeys.secrets(tenantId) }),
  });
}

export function useRotateSecret(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ secretId, body }: { secretId: string; body: RotateIn }) =>
      api.post<Secret>(`/tenants/${enc(tenantId)}/secrets/${enc(secretId)}/rotate`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: tenantKeys.secrets(tenantId) }),
  });
}

export function useDeleteSecret(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (secretId: string) =>
      api.delete<undefined>(`/tenants/${enc(tenantId)}/secrets/${enc(secretId)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: tenantKeys.secrets(tenantId) }),
  });
}
