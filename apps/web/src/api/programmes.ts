import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiDownload, withQuery } from './client';
import { isApiError } from './errors';
import type {
  Consent,
  ConsentIn,
  CustomerAssignIn,
  Fleet,
  FleetScan,
  Metering,
  PodIn,
  PortfolioPlan,
  ProgrammeDetail,
  ProgrammeView,
  SetupIn,
  WaveIn,
} from './programmes-types';
import { programmeKeys } from './tenancy';

const enc = encodeURIComponent;
const base = (id: string) => `/programmes/${enc(id)}`;

/** Under programmeKeys.all, so creating a programme or adding a partner refreshes these too. */
export const programmeDetailKeys = {
  one: (id: string) => [...programmeKeys.all, id] as const,
  detail: (id: string) => [...programmeKeys.all, id, 'detail'] as const,
  view: (id: string) => [...programmeKeys.all, id, 'view'] as const,
  fleet: (id: string) => [...programmeKeys.all, id, 'fleet'] as const,
  plan: (id: string) => [...programmeKeys.all, id, 'plan'] as const,
  metering: (id: string) => [...programmeKeys.all, id, 'metering'] as const,
  consents: (tenantId: string) => ['fleet', tenantId, 'consents'] as const,
  scans: (tenantId: string) => ['fleet', tenantId, 'scans'] as const,
};

const ACTIVE_SCAN = new Set(['queued', 'running']);

// ---------- Programme and set-up ----------

export function useProgramme(id: string) {
  return useQuery({
    queryKey: programmeDetailKeys.detail(id),
    queryFn: ({ signal }) => api.get<ProgrammeDetail>(base(id), { signal }),
  });
}

/** Every change returns the programme; it replaces the cached one and the views refetch. */
function useProgrammeChanged(id: string) {
  const qc = useQueryClient();
  return (detail: ProgrammeDetail) => {
    qc.setQueryData(programmeDetailKeys.detail(id), detail);
    void qc.invalidateQueries({ queryKey: programmeDetailKeys.one(id) });
    void qc.invalidateQueries({ queryKey: programmeKeys.all, exact: true });
  };
}

export function useSaveSetup(id: string) {
  const changed = useProgrammeChanged(id);
  return useMutation({
    mutationFn: (body: SetupIn) => api.put<ProgrammeDetail>(`${base(id)}/setup`, body),
    onSuccess: changed,
  });
}

export function useAddPod(id: string) {
  const changed = useProgrammeChanged(id);
  return useMutation({
    mutationFn: ({ partnerId, body }: { partnerId: string; body: PodIn }) =>
      api.post<ProgrammeDetail>(`${base(id)}/partners/${enc(partnerId)}/pods`, body),
    onSuccess: changed,
  });
}

export function useRemovePod(id: string) {
  const changed = useProgrammeChanged(id);
  return useMutation({
    mutationFn: (podId: string) => api.delete<ProgrammeDetail>(`${base(id)}/pods/${enc(podId)}`),
    onSuccess: changed,
  });
}

export function useSaveWave(id: string) {
  const changed = useProgrammeChanged(id);
  return useMutation({
    mutationFn: ({ key, body }: { key: string; body: WaveIn }) =>
      api.put<ProgrammeDetail>(`${base(id)}/waves/${enc(key)}`, body),
    onSuccess: changed,
  });
}

export function useRemoveWave(id: string) {
  const changed = useProgrammeChanged(id);
  return useMutation({
    mutationFn: (key: string) => api.delete<ProgrammeDetail>(`${base(id)}/waves/${enc(key)}`),
    onSuccess: changed,
  });
}

export function useAssignCustomer(id: string) {
  const changed = useProgrammeChanged(id);
  return useMutation({
    mutationFn: ({ tenantId, body }: { tenantId: string; body: CustomerAssignIn }) =>
      api.put<ProgrammeDetail>(`${base(id)}/customers/${enc(tenantId)}`, body),
    onSuccess: changed,
  });
}

// ---------- Programme view, fleet, plan and metering ----------

export function useProgrammeView(id: string) {
  return useQuery({
    queryKey: programmeDetailKeys.view(id),
    queryFn: ({ signal }) => api.get<ProgrammeView>(`${base(id)}/view`, { signal }),
  });
}

export function useFleet(id: string) {
  return useQuery({
    queryKey: programmeDetailKeys.fleet(id),
    queryFn: ({ signal }) => api.get<Fleet>(`${base(id)}/fleet`, { signal }),
  });
}

/** The latest portfolio plan, or null when the planner has not run yet (404). */
export function useLatestPlan(id: string) {
  return useQuery({
    queryKey: programmeDetailKeys.plan(id),
    queryFn: async ({ signal }) => {
      try {
        return await api.get<PortfolioPlan>(`${base(id)}/portfolio-plans/latest`, { signal });
      } catch (e) {
        if (isApiError(e) && e.status === 404) return null;
        throw e;
      }
    },
  });
}

export function useRunPlanner(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<PortfolioPlan>(`${base(id)}/portfolio-plans`),
    onSuccess: (plan) => {
      qc.setQueryData(programmeDetailKeys.plan(id), plan);
      void qc.invalidateQueries({ queryKey: programmeDetailKeys.plan(id) });
      void qc.invalidateQueries({ queryKey: programmeDetailKeys.metering(id) });
    },
  });
}

export function useMetering(id: string) {
  return useQuery({
    queryKey: programmeDetailKeys.metering(id),
    queryFn: ({ signal }) => api.get<Metering>(`${base(id)}/metering`, { signal }),
  });
}

/** The gate evidence for invoicing, as CSV, through the authenticated client. */
export function useGateEvidenceCsv(id: string) {
  return useMutation({
    mutationFn: () =>
      apiDownload(withQuery(`${base(id)}/metering`, { format: 'csv' }), `gate-evidence-${id}.csv`),
  });
}

// ---------- Consent and fleet scans (per customer tenant) ----------

export function useConsents(tenantId: string | null) {
  return useQuery({
    queryKey: programmeDetailKeys.consents(tenantId ?? ''),
    queryFn: ({ signal }) =>
      api.get<Consent[]>(`/tenants/${enc(tenantId ?? '')}/consents`, { signal }),
    enabled: tenantId !== null,
  });
}

function useFleetChanged(programmeId: string, tenantId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: programmeDetailKeys.consents(tenantId) });
    void qc.invalidateQueries({ queryKey: programmeDetailKeys.scans(tenantId) });
    void qc.invalidateQueries({ queryKey: programmeDetailKeys.fleet(programmeId) });
  };
}

export function useRecordConsent(programmeId: string, tenantId: string) {
  const changed = useFleetChanged(programmeId, tenantId);
  return useMutation({
    mutationFn: (body: ConsentIn) => api.post<Consent>(`/tenants/${enc(tenantId)}/consents`, body),
    onSuccess: changed,
  });
}

export function useRevokeConsent(programmeId: string, tenantId: string) {
  const changed = useFleetChanged(programmeId, tenantId);
  return useMutation({
    mutationFn: ({ consentId, reason }: { consentId: string; reason: string }) =>
      api.post<Consent>(`/consents/${enc(consentId)}/revoke`, { reason }),
    onSuccess: changed,
  });
}

/** Scans of one customer, newest first; polls while one is queued or running. */
export function useFleetScans(programmeId: string, tenantId: string | null) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: programmeDetailKeys.scans(tenantId ?? ''),
    queryFn: async ({ signal }) => {
      const scans = await api.get<FleetScan[]>(`/tenants/${enc(tenantId ?? '')}/fleet-scans`, {
        signal,
      });
      const before = qc.getQueryData<FleetScan[]>(programmeDetailKeys.scans(tenantId ?? ''));
      const finished = scans.some(
        (sc) =>
          !ACTIVE_SCAN.has(sc.status) &&
          before?.some((b) => b.id === sc.id && ACTIVE_SCAN.has(b.status)),
      );
      if (finished) {
        void qc.invalidateQueries({ queryKey: programmeDetailKeys.one(programmeId) });
      }
      return scans;
    },
    enabled: tenantId !== null,
    refetchInterval: (q) => (q.state.data?.some((sc) => ACTIVE_SCAN.has(sc.status)) ? 3000 : false),
  });
}

export function useStartScan(programmeId: string, tenantId: string) {
  const changed = useFleetChanged(programmeId, tenantId);
  return useMutation({
    mutationFn: (connectionId: string) =>
      api.post<FleetScan>(`/tenants/${enc(tenantId)}/fleet-scans`, {
        connection_id: connectionId,
      }),
    onSuccess: changed,
  });
}
