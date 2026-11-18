/**
 * Version delta, pattern advice, code conversion with recorded tests, and the hosting checklist
 * (API tag "upgrade"). Several responses are untyped dicts on the server; these types follow the
 * platform's dataclasses.
 */
import type { DateTime, PackSource, Uuid } from './types';

// ---------- Version delta ----------

export const DELTA_GROUPS = [
  'unchanged',
  'renamed_or_moved',
  'changed_behaviour',
  'removed_in_target',
] as const;
export type DeltaGroup = (typeof DELTA_GROUPS)[number];

export const ORIGINS = ['standard', 'customized_standard', 'customer_specific', 'unknown'] as const;
export type Origin = (typeof ORIGINS)[number];

export interface PatternAdvice {
  chosen: string | null;
  recommended: string | null;
  agrees: boolean | null;
  reasons: string[];
}

export interface DeltaRun {
  id: Uuid;
  project_id: Uuid;
  connection_id: Uuid;
  connection_name: string | null;
  baseline: string;
  standard_baseline: string | null;
  /** queued | running | succeeded | failed | blocked | cancelled */
  status: string;
  status_detail: string | null;
  counts: Partial<Record<DeltaGroup, number>>;
  origin_counts: Partial<Record<Origin, number>>;
  not_in_scope: number;
  new_in_target: number;
  input_digest: string | null;
  result_digest: string | null;
  /** Empty until the run succeeds. */
  advice: Partial<PatternAdvice>;
  job_id: Uuid | null;
  requested_by: string;
  created_at: DateTime;
  finished_at: DateTime | null;
}

export interface DeltaIn {
  connection_id: Uuid;
  standard_baseline_id?: Uuid | null;
}

export interface DeltaDifference {
  group: DeltaGroup | (string & {});
  type: string;
  source: string;
  target: string | null;
  origin: Origin | (string & {});
  /**
   * moved {how, from_schema, to_schema}; renamed {how, similarity, added_in_target,
   * missing_in_target, type_changed}; changed {what, ...column diffs}; removed {closest, similarity}
   */
  details: Record<string, unknown> | null;
}

export interface DeltaDifferencePage {
  total: number;
  offset: number;
  groups: string[];
  items: DeltaDifference[];
}

export interface DifferenceQuery {
  group?: string;
  origin?: string;
  type?: string;
  q?: string;
  offset: number;
  limit: number;
}

export interface DeltaLists {
  /** "type:schema.name" */
  not_in_scope: string[];
  new_in_target: string[];
  problems: string[];
}

export interface ProjectPatternAdvice extends PatternAdvice {
  delta_run_id: Uuid | null;
}

// ---------- Conversion ----------

export interface ConversionSummary {
  objects?: number;
  compiled?: number;
  compile_failed?: number;
  review?: number;
  tests?: { passed: number; failed: number };
  code_unreadable?: number;
  workbench_tables?: number;
}

export interface ConversionRun {
  id: Uuid;
  project_id: Uuid;
  connection_id: Uuid;
  connection_name: string | null;
  baseline: string;
  source_dialect: string;
  target_dialect: string;
  status: string;
  status_detail: string | null;
  summary: ConversionSummary;
  job_id: Uuid | null;
  requested_by: string;
  created_at: DateTime;
  finished_at: DateTime | null;
}

export interface ConversionIn {
  connection_id: Uuid;
  target_dialect: 'sqlserver';
}

export type ConversionStatus = 'compiled' | 'compile_failed' | 'review';

export interface CompileResult {
  ok: boolean;
  error: string | null;
  unresolved: string[];
}

export interface TestOutcome {
  test_id: string;
  name: string;
  passed: boolean;
  inputs: Record<string, unknown>;
  expected: unknown;
  actual: unknown;
  differences: string[];
  error: string | null;
}

export interface ConvertedObject {
  object_type: string;
  name: string;
  status: ConversionStatus | (string & {});
  rules: string[];
  warnings: string[];
  review: string[];
  /** Empty object when the object was not compiled (sent to review). */
  compile: Partial<CompileResult>;
  tests: TestOutcome[];
}

export interface ConvertedObjectDetail extends ConvertedObject {
  source: string;
  converted: string | null;
}

export interface ConvertedObjectPage {
  total: number;
  offset: number;
  items: ConvertedObject[];
}

export interface ConversionObjectQuery {
  status?: string;
  q?: string;
  offset: number;
  limit: number;
}

export interface TestExpected {
  value?: unknown;
  outputs?: Record<string, unknown>;
  rows?: unknown[][];
  error?: string;
}

export interface ConversionTestIn {
  object_name: string;
  name: string;
  inputs: Record<string, unknown>;
  outputs: string[];
  setup: Record<string, Record<string, unknown>[]>;
  expected: TestExpected;
}

export interface ConversionTest {
  id: Uuid;
  object_name: string;
  name: string;
  body: Omit<ConversionTestIn, 'object_name' | 'name'>;
  created_by: string | null;
  created_at: DateTime;
}

// ---------- Hosting checklist ----------

export type ChecklistStatus = 'open' | 'in_progress' | 'done' | 'not_applicable';

export type ChecklistSource =
  | {
      kind: 'adapter';
      adapter: string | null;
      constraint: string;
      reference: PackSource;
      recorded_on: string;
      confidence: string;
    }
  | { kind: 'generic'; note: string };

export interface ChecklistItem {
  id: Uuid;
  key: string;
  category: string;
  category_title: string;
  title: string;
  detail: string;
  source: ChecklistSource;
  owner_user_id: Uuid | null;
  owner_name: string | null;
  owner_role: string;
  status: ChecklistStatus | (string & {});
  note: string;
  updated_by: string | null;
  updated_at: DateTime | null;
}

export interface Checklist {
  items: ChecklistItem[];
  adapter: string | null;
  missing: string[];
  areas: string[];
  complete: boolean;
  done: number;
  total: number;
  can_manage: boolean;
}

export interface ChecklistPatch {
  owner_user_id?: Uuid | null;
  status?: ChecklistStatus;
  note?: string;
}
