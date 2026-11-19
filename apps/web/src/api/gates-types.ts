// I11 gates and proof packs (api/routes/gates.py, gates.py `as_dict`, proof.py).

export type GateItemKind = 'evidence' | 'control' | 'attestation';
export type GateStatus = 'open' | 'passed' | 'changed_since_pass';

export interface GateSource {
  /** Record type, e.g. blueprint_version, load_run, recon_breaks, gate_evidence. */
  type: string;
  id: string;
  /** The API path that returns the record; for attested evidence, the reference given. */
  href: string | null;
}

export interface GateControl {
  id: string;
  pack: string;
  title: string;
  rule: string;
  evidence_required: string;
  compliance_critical: boolean;
  sources: string[];
}

export interface GateEvidence {
  note: string;
  reference: string | null;
  by: string | null;
  at: string | null;
}

export interface GateItem {
  key: string;
  kind: GateItemKind;
  title: string;
  met: boolean;
  detail: string;
  source: GateSource | null;
  control: GateControl | null;
  evidence: GateEvidence | null;
}

export interface GateApprover {
  role: string;
  label: string;
}

export interface GateApproval {
  role: string;
  role_label: string;
  user: string | null;
  user_id: string;
  note: string;
  at: string | null;
}

export interface Gate {
  key: string;
  title: string;
  /** The blueprint's label for the gate (e.g. G0), else the title. */
  label: string;
  approvers: GateApprover[];
  items: GateItem[];
  all_met: boolean;
  /** sha256 of the checklist as it is now; approvals bind to it. */
  digest: string;
  status: GateStatus;
  /** Approvals recorded on the current digest only. */
  approvals: GateApproval[];
  passed_at: string | null;
  ever_passed: boolean;
}

export interface GateList {
  gates: Gate[];
  my_roles: string[];
  can_attest: boolean;
}

export interface EvidenceIn {
  item_key: string;
  note: string;
  reference?: string | null;
}

export interface ApprovalIn {
  role: string;
  note: string;
}

export interface ProofPackSummary {
  counts: Record<string, number>;
  items: number;
  bytes: number;
}

export interface ProofPack {
  id: string;
  number: number;
  scope: 'project' | 'wave';
  wave: string | null;
  json_sha256: string;
  pdf_sha256: string;
  signature: string;
  signing_key: string;
  key_version: number;
  summary: ProofPackSummary;
  created_by: string | null;
  created_at: string | null;
  document_url: string;
  pdf_url: string;
}

export interface ProofPackList {
  packs: ProofPack[];
  waves: string[];
  can_create: boolean;
}

export interface ProofPackIn {
  wave?: string | null;
}

export interface ProofPackVerify {
  json_sha256: string;
  pdf_sha256: string;
  signature_valid: boolean;
  matches_record: boolean;
  valid: boolean;
  key_version: number;
}

export interface SigningKey {
  key: string;
  type: string | null;
  algorithm: string;
  message: string;
  /** Key version → base64 public key (null when the vault does not expose it). */
  versions: Record<string, string | null>;
}
