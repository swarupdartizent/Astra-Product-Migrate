/**
 * Design and build (API tag "design", I9): design runs, the design register and its decisions, form
 * parity, integration end-to-end tests, security profile access and versioned build artifacts. The
 * server returns untyped dicts; these types follow platform/src/astra_migrate/design/ and
 * api/routes/design.py.
 */
import type { DateTime, Uuid } from './types';

export const DESIGN_STREAMS = [
  'mapping',
  'configuration',
  'form',
  'code',
  'integration',
  'report',
  'page',
  'security',
] as const;
export type DesignStream = (typeof DESIGN_STREAMS)[number];

export const DESIGN_STATUSES = [
  'proposed',
  'in_review',
  'approved',
  'rejected',
  'blocked',
] as const;
export type DesignStatus = (typeof DESIGN_STATUSES)[number];

export const ACCESS_LEVELS = ['none', 'view', 'edit', 'full'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

// ---------- Target adapter design section ----------

export type DesignConfidence = 'confirmed' | 'reported' | 'assumed';

export interface DesignSourceRef {
  reference: string;
  url: string | null;
}

export interface Mechanism {
  key: string;
  kind: 'rest_api' | 'read_query' | 'webhook' | 'integration_vendor' | 'file_exchange';
  label: string;
  directions: ('inbound' | 'outbound' | 'read')[];
  notes: string;
  source: DesignSourceRef;
  confidence: DesignConfidence;
}

export interface Retirement {
  object_type: string;
  when: Record<string, unknown>;
  name_pattern: string | null;
  replacement: string;
  source: DesignSourceRef;
  confidence: DesignConfidence;
}

export interface NamingRules {
  schema: string;
  prefix: string;
  case: 'pascal' | 'snake' | 'upper_snake' | 'as_is';
  max_length: number;
  source: DesignSourceRef;
  confidence: DesignConfidence;
}

export interface ConfigurationArea {
  key: string;
  label: string;
  source_kinds: string[];
  method: 'api' | 'import_file' | 'manual';
  notes: string;
}

export interface FormFormat {
  format: string;
  source_kinds: string[];
  already_when: Record<string, unknown>;
  notes: string;
  source: DesignSourceRef;
  confidence: DesignConfidence;
}

export interface PageBuilder {
  name: string;
  notes: string;
  source: DesignSourceRef;
  confidence: DesignConfidence;
}

export interface TargetDesign {
  mechanisms: Mechanism[];
  report_access: string | null;
  retirements: Retirement[];
  naming: NamingRules | null;
  configuration_areas: ConfigurationArea[];
  forms: FormFormat | null;
  pages: PageBuilder | null;
}

// ---------- Runs and overview ----------

export interface RequiredUnmapped {
  source_table: string;
  target_table: string;
  required_unmapped: string[];
}

export interface MappingRunSummary {
  columns: number;
  in_review: number;
  no_target: number;
  required_unmapped: RequiredUnmapped[];
  threshold: number;
}

/** Per stream: items proposed by the run, decisions kept, and counts by status (non-zero only). */
export type StreamRunSummary = { items: number; kept_decisions: number } & Partial<
  Record<DesignStatus, number>
>;

export interface DesignRunSummary {
  streams?: Partial<Record<DesignStream, StreamRunSummary>>;
  mapping?: MappingRunSummary;
  /** Stream (or "target") → why every item of it is blocked. */
  blocked?: Record<string, string>;
  problems?: string[];
  review_items?: number;
}

export interface DesignRun {
  id: Uuid;
  project_id: Uuid;
  connection_id: Uuid;
  /** queued | running | succeeded | failed | blocked | cancelled */
  status: string;
  status_detail: string | null;
  summary: DesignRunSummary;
  job_id: Uuid | null;
  requested_by: string | null;
  created_at: DateTime | null;
  finished_at: DateTime | null;
}

export interface DesignRunIn {
  connection_id: Uuid;
}

export interface BuildCounts {
  generated: number;
  tests_failed: number;
  tests_passed: number;
  approved: number;
}

export interface DesignOverview {
  latest_run: DesignRun | null;
  /** Current register: stream → status → count. */
  counts: Partial<Record<DesignStream, Partial<Record<DesignStatus, number>>>>;
  target_design: TargetDesign | null;
  target_design_missing: string | null;
  build: BuildCounts;
  can_run: boolean;
  can_build: boolean;
  can_decide: Record<DesignStream, boolean>;
}

// ---------- Register items ----------

export interface DesignDecision {
  /** approve | reject | change | redesign */
  action: string;
  reason: string;
  by: string;
  by_id: string;
  at: string;
  no_target?: boolean;
  controls?: string[];
  option?: string;
  outcome?: string | null;
  review_item_id?: string;
}

export interface DesignApproval {
  by: string;
  by_id: string;
  at: string;
  action: string;
  no_target: boolean;
}

export interface FormParity {
  passed: boolean;
  differences: string[];
  pages: number;
  golden_pages: number;
  fields: number;
  golden_fields: number;
  converted_sha256: string;
  golden_sha256: string;
  at: string;
  by: string;
}

export interface FormFile {
  role: 'converted' | 'golden';
  name: string;
  sha256: string;
  bytes: number;
  uploaded_by: string;
  uploaded_at: DateTime | null;
}

export interface MappingSource {
  table: string;
  column: string;
  type: string;
  max_length: number | null;
  nullable: boolean;
  ordinal: number;
}

export interface MappingTarget {
  table: string;
  column: string;
  type: string | null;
  nullable: boolean | null;
}

export interface Precedent {
  project_id: string;
  target: MappingTarget | null;
  decided_by: string | null;
  decided_at: string | null;
}

export interface SourceColumnInfo {
  name: string;
  type: string;
  max_length: number | null;
  nullable: boolean;
  ordinal: number;
}

export interface TestStep {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body: unknown;
  expect_status: number;
  expect_keys: string[];
}

export interface TestStepResult {
  step: string;
  status: number | null;
  passed: boolean;
  problems: string[];
}

export interface IntegrationTestRun {
  at: string;
  by: string;
  connection: string;
  blocked: string | null;
  passed: boolean;
  steps: TestStepResult[];
}

export interface PageField {
  label: string;
  target: string;
  type: string | null;
  required: boolean;
  source: string;
  decided: boolean;
}

export interface PageSection {
  label: string;
  fields?: PageField[];
  links?: { label: string; entity: string | null }[];
}

/**
 * One register item. `source` and `target` hold different fields per stream (see
 * design/streams.py and design/mapping.py); the stream views read them through model helpers.
 */
export interface DesignItemSummary {
  stream: DesignStream;
  key: string;
  status: DesignStatus;
  source: Record<string, unknown>;
  target: Record<string, unknown> | null;
  proposed_target: Record<string, unknown> | null;
  confidence: number | null;
  flags: string[] | null;
  evidence: string[] | null;
  decision: DesignDecision | null;
  review_item_id: string | null;
  approvals: DesignApproval[] | null;
  parity: FormParity | null;
  missing: string[] | null;
  key_columns: string[] | null;
  desktop: boolean | null;
  updated_at: string | null;
}

export interface DesignItemDetail extends DesignItemSummary {
  run_id: string;
  updated_by: string | null;
  source_digest?: string;
  previous_decision?: DesignDecision;
  precedents?: Precedent[];
  entries?: Record<string, AccessLevel | null>;
  tests?: TestStep[];
  test_runs?: IntegrationTestRun[];
  last_test?: IntegrationTestRun;
  definition?: string | null;
  /** Why the item cannot be approved yet, or null. */
  readiness: string | null;
  can_decide: boolean;
  cannot_decide_reason: string | null;
  files: FormFile[];
}

export interface DesignItemPage {
  items: DesignItemSummary[];
  total: number;
}

export interface DesignItemQuery {
  stream: DesignStream;
  status?: DesignStatus;
  q?: string;
  offset?: number;
  limit?: number;
}

export type DecisionAction = 'approve' | 'reject' | 'change';

export interface DecisionIn {
  stream: DesignStream;
  keys: string[];
  action: DecisionAction;
  reason: string;
  target?: string;
  no_target?: boolean;
}

export interface DecisionOut {
  decided: string[];
  awaiting_second_approval: string[];
  refused: { key: string; reason: string }[];
  required_approvals: number;
}

export interface SecurityIn {
  key: string;
  entries: Record<string, AccessLevel>;
}

export interface CodeKeyIn {
  key: string;
  columns: string[];
}

export interface IntegrationTestIn {
  key: string;
  steps: TestStep[];
}

export interface IntegrationTestRunIn {
  key: string;
  target_connection_id: Uuid;
}

export interface FormFileIn {
  key: string;
  role: 'converted' | 'golden';
  name: string;
  content_base64: string;
}

// ---------- Build ----------

export type ArtifactKind = 'transformation' | 'code_object';

export interface TestSummary {
  tests?: number;
  passed?: number;
  failed?: string[];
  at?: string;
}

export interface BuildArtifact {
  id: Uuid;
  kind: ArtifactKind;
  name: string;
  version: number;
  digest: string;
  /** generated | tests_failed | tests_passed | approved | superseded */
  status: string;
  test_summary: TestSummary;
  runnable: boolean;
  /** The approver's user id (the API does not return a display name). */
  approved_by: string | null;
  approval_note: string | null;
  approved_at: DateTime | null;
  created_by: string | null;
  created_at: DateTime | null;
}

export interface ArtifactTest {
  name: string;
  /** compile | rows | values | check | exec | case */
  kind: string;
  check?: string;
  expect?: number;
  [extra: string]: unknown;
}

export interface ArtifactResult {
  name: string;
  passed: boolean;
  detail: string | null;
}

/** Inputs differ by artifact: transformations list mappings and seed rows. */
export interface ArtifactInputs {
  source_table?: string;
  target_table?: string;
  mappings?: { source: string; target: string; decided_by: string | null }[];
  seed_rows?: Record<string, unknown>[];
  real_sample_rows?: number;
  columns?: SourceColumnInfo[];
  key?: string[];
  kind?: string;
  cases?: number;
  tables?: Record<string, string>;
  [extra: string]: unknown;
}

export interface BuildArtifactDetail extends BuildArtifact {
  code: string | null;
  tests: ArtifactTest[];
  results: ArtifactResult[];
  inputs: ArtifactInputs;
  can_approve: boolean;
  cannot_approve_reason: string | null;
}

export interface ArtifactQuery {
  kind?: ArtifactKind;
  all_versions?: boolean;
}
