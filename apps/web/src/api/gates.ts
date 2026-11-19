import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiDownload } from './client';
import { runtimeKeys } from './runtime';
import type {
  ApprovalIn,
  EvidenceIn,
  Gate,
  GateList,
  ProofPack,
  ProofPackIn,
  ProofPackList,
  ProofPackVerify,
  SigningKey,
} from './gates-types';

const enc = encodeURIComponent;

export const gateKeys = {
  all: ['gates'] as const,
  gates: (projectId: string) => ['gates', projectId, 'gates'] as const,
  packs: (projectId: string) => ['gates', projectId, 'packs'] as const,
  verify: (packId: string) => ['gates', 'verify', packId] as const,
  signingKey: ['gates', 'signing-key'] as const,
};

const base = (projectId: string) => `/projects/${enc(projectId)}`;

// ---------- Gates ----------

export function useGates(projectId: string) {
  return useQuery({
    queryKey: gateKeys.gates(projectId),
    queryFn: ({ signal }) => api.get<GateList>(`${base(projectId)}/gates`, { signal }),
  });
}

/** Puts the returned gate into the list, then refetches (other gates can share evidence). */
function useGateUpdated(projectId: string) {
  const qc = useQueryClient();
  return (gate: Gate) => {
    qc.setQueryData<GateList>(gateKeys.gates(projectId), (old) =>
      old ? { ...old, gates: old.gates.map((g) => (g.key === gate.key ? gate : g)) } : old,
    );
    void qc.invalidateQueries({ queryKey: gateKeys.gates(projectId) });
    // Stage moves cite gates: refresh the stage strip too.
    void qc.invalidateQueries({ queryKey: runtimeKeys.stages(projectId) });
  };
}

export function useAttestGate(projectId: string, gate: string) {
  const updated = useGateUpdated(projectId);
  return useMutation({
    mutationFn: (body: EvidenceIn) =>
      api.put<Gate>(`${base(projectId)}/gates/${enc(gate)}/evidence`, body),
    onSuccess: updated,
  });
}

export function useApproveGate(projectId: string, gate: string) {
  const updated = useGateUpdated(projectId);
  return useMutation({
    mutationFn: (body: ApprovalIn) =>
      api.post<Gate>(`${base(projectId)}/gates/${enc(gate)}/approvals`, body),
    onSuccess: updated,
  });
}

// ---------- Proof packs ----------

export function useProofPacks(projectId: string) {
  return useQuery({
    queryKey: gateKeys.packs(projectId),
    queryFn: ({ signal }) => api.get<ProofPackList>(`${base(projectId)}/proof-packs`, { signal }),
  });
}

export function useCreateProofPack(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProofPackIn) => api.post<ProofPack>(`${base(projectId)}/proof-packs`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: gateKeys.packs(projectId) }),
  });
}

/** Recomputes both digests from the stored files and verifies the signature (when asked). */
export function useProofPackVerification(packId: string | null) {
  return useQuery({
    queryKey: gateKeys.verify(packId ?? ''),
    queryFn: ({ signal }) =>
      api.get<ProofPackVerify>(`/proof-packs/${enc(packId ?? '')}/verify`, { signal }),
    enabled: packId !== null,
    staleTime: 0,
    gcTime: 0,
  });
}

/** The exact signed bytes, through the authenticated client. */
export function useDownloadProofPack() {
  return useMutation({
    mutationFn: ({ pack, format }: { pack: ProofPack; format: 'json' | 'pdf' }) =>
      apiDownload(
        `/proof-packs/${enc(pack.id)}/${format === 'json' ? 'document' : 'pdf'}`,
        `proof-pack-${String(pack.number)}.${format}`,
      ),
  });
}

export function useSigningKey(enabled = true) {
  return useQuery({
    queryKey: gateKeys.signingKey,
    queryFn: ({ signal }) => api.get<SigningKey>('/proof-packs/signing-key', { signal }),
    enabled,
    staleTime: 10 * 60_000,
  });
}
