/**
 * Loads, validation, reconciliation, documents, parity and coexistence (API tag "loads", I10).
 * The server returns untyped dicts; these types follow platform/src/astra_migrate/loads/ (engine,
 * validate, documents, parity, coexistence) and api/routes/loads.py.
 */
import type { DateTime, Uuid } from './types';

// ---------- Load runs ----------

/** Kinds a person starts; `reload` runs are made from a run's error queue. */
export const START_KINDS = ['rehearsal', 'load', 'delta'] as const;
export type StartKind = (typeof START_KINDS)[number];
export type LoadKind = StartKind | 'reload';

export type LoadRunStatus =
  'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | (string & {});

/** Record outcomes. Accepted: loaded, unchanged, rehearsed. Failed: rejected, invalid, blocked. */
export const ACCEPTED_STATUSES = ['loaded', 'unchanged', 'rehearsed'] as const;
export const FAILED_STATUSES = ['rejected', 'invalid', 'blocked'] as const;
export type FailedStatus = (typeof FAILED_STATUSES)[number];
export type RecordStatus = (typeof ACCEPTED_STATUSES)[number] | FailedStatus | (string & {});

export interface LoadSegment {
  column: string;
  values: string[];
}

export interface PinnedArtifact {
  id: Uuid;
  name: string;
  version: number;
  digest: string;
}

export interface PinnedPacks {
  /** Domain, compliance and pattern packs, pinned as name@version. */
  blueprint: string[];
  source: string | null;
  target: string | null;
  target_baseline: Uuid | null;
}

/** Per target table: source, transformed and accepted counts plus a count per record status. */
export type TableReconciliation = {
  source: number;
  transformed: number;
  accepted: number;
} & Record<string, number>;

/** One measured amount at the three stages, as exact decimal strings. */
export interface MeasureReconciliation {
  table: string;
  column: string;
  label: string;
  /** Null when the run had no source rows for the table (a reload). */
  source: string | null;
  transformed: string;
  accepted: string;
}

/** Data quality, as percentages: before (discovery's profile) and after (no validation failure). */
export interface DataQuality {
  source_table: string;
  before: number | null;
  after: number | null;
  /** Per segment value; empty unless the run loaded by segment. */
  segments: Record<string, number>;
}

export interface DocumentSummary {
  documents: number;
  broken_links: number;
  sample_size: number;
  /** Count per sample outcome: match, mismatch, missing, blocked. */
  sample: Record<string, number>;
  blocked: string | null;
  passed: boolean;
}

export interface LoadSummary {
  tables?: Record<string, TableReconciliation>;
  measures?: MeasureReconciliation[];
  dq?: Record<string, DataQuality>;
  errors?: { artifact: string; error: string }[];
  counts?: Record<string, number>;
  /** Same input digest as an earlier run: whether that run gave the same result. */
  repeat_of?: { run: number; same_result: boolean } | null;
  breaks?: number;
  /** Per target table: why its records could not be sent. */
  blocked?: Record<string, string>;
  documents?: DocumentSummary;
}

export interface LoadRun {
  id: Uuid;
  number: number;
  kind: LoadKind;
  status: LoadRunStatus;
  status_detail: string | null;
  parent_run_id: Uuid | null;
  extract_run_id: Uuid | null;
  target_connection_id: Uuid | null;
  segment: LoadSegment | null;
  artifacts: PinnedArtifact[];
  packs: PinnedPacks;
  input_digest: string;
  result_digest: string | null;
  summary: LoadSummary;
  job_id: Uuid | null;
  requested_by: string | null;
  created_at: DateTime | null;
  finished_at: DateTime | null;
}

/** GET /load-runs/{id} adds what the caller may do. */
export interface LoadRunDetail extends LoadRun {
  can_load: boolean;
  can_triage: boolean;
}

export interface LoadRunIn {
  kind: StartKind;
  extract_run_id: Uuid;
  target_connection_id?: Uuid;
  segment?: LoadSegment;
}

// ---------- Error queue ----------

export interface ValidationFailure {
  rule: string;
  kind: 'structural' | 'reference' | 'semantic' | 'business' | (string & {});
  severity: 'blocking' | 'warning' | (string & {});
  column: string | null;
  message: string;
  fix: string;
}

export const TRIAGE_STATES = ['open', 'fixed', 'wont_fix', 'reloaded'] as const;
export type TriageState = (typeof TRIAGE_STATES)[number];
/** States a person sets; `reloaded` is set by a reload. */
export type SettableTriage = Exclude<TriageState, 'reloaded'>;

export interface LoadRecord {
  table: string;
  key: string;
  source_key: string | null;
  segment: string | null;
  payload: Record<string, unknown>;
  status: RecordStatus;
  http_status: number | null;
  reason: string | null;
  failures: ValidationFailure[];
  owner: string | null;
  triage: TriageState | (string & {});
  fixed_payload: Record<string, unknown> | null;
  note: string | null;
}

export interface RecordQuery {
  status?: FailedStatus;
  table?: string;
  triage?: TriageState;
  owner?: string;
  q?: string;
  offset: number;
  limit: number;
}

export interface RecordPage {
  items: LoadRecord[];
  total: number;
  /** Every status of the run with its count (accepted ones too). */
  by_status: Record<string, number>;
}

export interface TriageIn {
  table: string;
  key: string;
  owner?: string;
  triage?: SettableTriage;
  fixed_payload?: Record<string, unknown>;
  note?: string;
}

export interface RecordRef {
  table: string;
  key: string;
}

// ---------- Documents ----------

export type DocumentStatus = 'linked' | 'broken' | 'match' | 'mismatch' | 'missing' | 'blocked';

export interface DocumentCheck {
  doc_key: string;
  entity: string | null;
  link_key: string | null;
  status: DocumentStatus | (string & {});
  detail: string | null;
}

export interface DocumentCheckPage {
  items: DocumentCheck[];
  total: number;
  summary: DocumentSummary | null;
}

// ---------- Reconciliation breaks ----------

export type BreakOrigin = 'load' | 'coexistence';
export type BreakStatus = 'open' | 'closed';

export interface ReconBreak {
  id: Uuid;
  origin: BreakOrigin;
  load_run_id: Uuid | null;
  /** The target table (load) or shared entity (coexistence). */
  scope: string;
  measure: string;
  source_value: string | null;
  target_value: string | null;
  difference: string | null;
  detail: string | null;
  owner_role: string | null;
  owner_user_id: Uuid | null;
  owner: string | null;
  status: BreakStatus;
  close_reason: string | null;
  closed_by: string | null;
  closed_at: DateTime | null;
  created_at: DateTime | null;
}

export interface BreakQuery {
  origin?: BreakOrigin;
  status?: BreakStatus;
  load_run_id?: Uuid;
}

export interface BreakIn {
  owner_user_id?: Uuid;
  close_reason?: string;
}

// ---------- Parity ----------

export const PARITY_KINDS = ['rating', 'report', 'workflow', 'period_close'] as const;
export type ParityKind = (typeof PARITY_KINDS)[number];

export const FIELD_TYPES = ['money', 'number', 'text'] as const;
export type ParityFieldType = (typeof FIELD_TYPES)[number];

export interface ParityFieldSpec {
  name: string;
  type: ParityFieldType;
  target_name?: string | null;
}

export interface ParitySpec {
  keys: string[];
  fields: ParityFieldSpec[];
  inputs: string[];
}

export interface ParitySummary {
  cases: number;
  differences: number;
  totals: Record<string, { source: string; target: string; difference: string }>;
  missing_in_target: number;
  missing_in_source: number;
  open: number;
  passed: boolean;
}

export interface ParityRun {
  id: Uuid;
  kind: ParityKind;
  name: string;
  spec: ParitySpec;
  summary: ParitySummary;
  source_sha256: string;
  target_sha256: string;
  created_by: string | null;
  created_at: DateTime | null;
}

export interface ParityFile {
  name: string;
  content_base64: string;
}

export interface ParityRunIn {
  kind: ParityKind;
  name: string;
  spec: ParitySpec;
  source: ParityFile;
  target: ParityFile;
}

export type ParityCaseKind = 'difference' | 'missing_in_target' | 'missing_in_source';
export type ParityCaseStatus = 'open' | 'approved' | 'fixed';

export interface ParityCase {
  key: string;
  kind: ParityCaseKind | (string & {});
  /** The compared field, or "*" for a case missing on one side. */
  field: string;
  source_value: string | null;
  target_value: string | null;
  inputs: Record<string, unknown>;
  status: ParityCaseStatus | (string & {});
  decided_by: string | null;
  decided_at: DateTime | null;
  note: string | null;
}

export interface ParityCasePage {
  run: ParityRun;
  total: number;
  items: ParityCase[];
  can_decide: boolean;
}

export interface CasesDecisionIn {
  cases: { key: string; field: string }[];
  action: 'approve' | 'fixed';
  note: string;
}

export interface CasesDecisionOut {
  decided: number;
  open: number;
  passed: boolean;
}

// ---------- Coexistence ----------

export interface CoexistenceRule {
  key: string;
  entity?: string;
  wave?: string;
  system_of_record?: 'source' | 'target';
  end_date?: string;
  exit_reconciliation?: string;
  [extra: string]: unknown;
}

export interface CoexistenceSchedule {
  connection_id: Uuid;
  owner_user_id: Uuid;
  owner: string | null;
  hour_utc: number;
  enabled: boolean;
  last_run_at: DateTime | null;
  next_run_at: DateTime | null;
}

export interface CoexistenceScheduleIn {
  connection_id: Uuid;
  owner_user_id: Uuid;
  hour_utc: number;
  enabled: boolean;
}

export interface CoexistenceDashboard {
  rules: CoexistenceRule[];
  schedule: CoexistenceSchedule | null;
  open_breaks: ReconBreak[];
  can_manage: boolean;
  can_close: boolean;
}
