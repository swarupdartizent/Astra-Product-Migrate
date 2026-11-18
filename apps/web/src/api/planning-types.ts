/**
 * Planning (API tag "planning"): scope, dependencies, tasks and estimates, controls, waves, risks,
 * cutover, coexistence, baselines, exports, gaps and pre-sales estimates. The server returns
 * untyped dicts; these types follow platform/src/astra_migrate/planning/.
 */
import type { DateTime, Uuid } from './types';

export const DISPOSITIONS = [
  'migrate',
  'rebuild',
  'replace_with_standard',
  'agentify',
  'archive',
  'retire',
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export interface Range {
  low: number;
  likely: number;
  high: number;
}

export interface RangeWithTasks extends Range {
  tasks: number;
}

// ---------- Overview ----------

export interface EstimationPackInfo {
  pack: string;
  calibrated: boolean;
  basis: string;
  rules?: number;
}

export interface PlanBaseline {
  id: Uuid;
  number: number;
  digest: string;
  summary: { items?: Record<string, number>; hours?: Range };
  changes: { against?: number; added?: number; removed?: number; changed?: number };
  reason: string;
  /** proposed | approved | rejected | superseded */
  status: string;
  proposed_by: string | null;
  decided_by: string | null;
  decided_at: DateTime | null;
  decision_note: string | null;
  created_at: DateTime;
}

export interface CutoverChoice {
  option: CutoverOption;
  reason: string;
  by: string;
  at: DateTime;
  assumptions: Record<string, number>;
  comparison?: CutoverComparisonOption[];
}

export type PlanOverview =
  | { ready: false; problem: string; can_manage: boolean }
  | {
      ready: true;
      blueprint_version: number | null;
      notes: string[];
      missing_packs: string[];
      estimation: EstimationPackInfo[];
      compliance_packs: string[];
      max_task_hours: number;
      discovery_run_id: Uuid | null;
      delta_run_id: Uuid | null;
      target_adapter: string | null;
      counts: Record<string, number>;
      scope_approved: number;
      estimate: RangeWithTasks | null;
      waves_fit: boolean | null;
      cutover_choice: CutoverChoice | null;
      latest_baseline: PlanBaseline | null;
      approved_baseline_id: Uuid | null;
      /** The newest baseline is proposed and waiting for a decision. */
      baseline_awaiting_approval: boolean;
      /** The caller may approve that waiting baseline (holds plan approval and did not propose it). */
      can_approve_waiting: boolean;
      can_manage: boolean;
      can_approve: boolean;
    };

// ---------- Scope ----------

export interface ScopeItem {
  key: string;
  element: string;
  kind: string;
  stream: string;
  concept: string | null;
  segment: string;
  props: Record<string, unknown>;
  proposed: Disposition;
  evidence: string[];
  delta: Record<string, unknown> | null;
  /** The discovery and delta runs the proposal came from. */
  sources?: { discovery_run?: string | null; delta_run?: string | null };
  /** proposed | approved */
  status: string;
  disposition: Disposition | null;
  decision: { by: string; at: DateTime; reason: string; changed: boolean } | null;
  effective: Disposition;
}

export interface ScopePage {
  total: number;
  offset: number;
  dispositions: Disposition[];
  counts: Partial<Record<Disposition, number>>;
  pending: number;
  items: ScopeItem[];
}

export interface ScopeQuery {
  stream?: string;
  disposition?: string;
  status?: string;
  q?: string;
  offset: number;
  limit: number;
}

export interface ScopeGenerated {
  items: number;
  edges: number;
  dropped?: string[];
  by_disposition: Record<string, number>;
  approved: number;
}

// ---------- Dependencies ----------

export interface DepNode {
  key: string;
  element: string;
  kind: string;
  stream: string;
  disposition: Disposition;
  depth: number;
}

export interface DepEdge {
  key: string;
  src: string;
  dst: string;
  kinds: string[];
  /** discovery | person */
  source: string;
  removed: { by: string; at: DateTime; reason: string } | null;
  added?: { by: string; at: DateTime; reason: string };
}

export interface DependencyView {
  nodes: DepNode[];
  edges: DepEdge[];
  errors: { kind: 'cycle' | (string & {}); members: string[]; detail: string }[];
}

// ---------- Tasks and estimates ----------

export interface TaskEvidence {
  rule: string | null;
  pack?: string | null;
  size?: number;
  unit?: string;
  low?: number;
  likely?: number;
  high?: number;
  calibration?: { factor?: number; samples?: number; past_tasks?: string[]; note?: string };
  rule_sources?: string[];
  share?: number;
  note?: string;
}

/** A person's change to a generated task, kept with the generated values. */
export interface TaskOverride {
  role: string | null;
  low: number | null;
  likely: number | null;
  high: number | null;
  reason: string;
  by: string;
  by_id?: string;
  at: DateTime;
  original: { role: string; low: number | null; likely: number | null; high: number | null };
}

export interface PlanTask {
  key: string;
  scope: string;
  element: string;
  stream: string;
  segment: string;
  disposition: string;
  approved: boolean;
  title: string;
  activity: string;
  role: string;
  part: number;
  parts: number;
  low: number | null;
  likely: number | null;
  high: number | null;
  evidence: TaskEvidence;
  depends_on: string[];
  wave: string | null;
  control?: string;
  override?: TaskOverride | null;
}

export interface TaskPage {
  total: number;
  offset: number;
  roles: string[];
  items: PlanTask[];
}

export interface TaskQuery {
  stream?: string;
  role?: string;
  wave?: string;
  q?: string;
  offset: number;
  limit: number;
}

export interface TasksGenerated {
  tasks: number;
  unestimated: string[];
  over_limit: string[];
  max_task_hours: number;
}

export interface Estimates {
  total: RangeWithTasks | Record<string, never>;
  by_stream: Record<string, RangeWithTasks>;
  by_segment: Record<string, RangeWithTasks>;
  by_wave: Record<string, RangeWithTasks>;
  by_role: Record<string, RangeWithTasks>;
  unestimated_tasks: number;
  calibration: Record<string, Record<string, unknown>>;
  estimation: EstimationPackInfo[];
}

// ---------- Controls ----------

export interface ControlRow {
  control: string;
  pack: string;
  type: string;
  title: string;
  rule: string;
  evidence_required: string;
  placement: string;
  gates: string[];
  role: string;
  control_task: string;
  control_task_exists: boolean;
  tasks: string[];
  task_count: number;
  compliance_critical?: boolean;
  two_person_approval?: boolean;
  sources: string[];
}

export interface ControlMatrix {
  packs: string[];
  controls: ControlRow[];
  complete: boolean;
}

// ---------- Waves ----------

export interface Wave {
  key: string;
  name: string;
  start: string;
  end: string;
  cutover: string | null;
  capacity: Record<string, number>;
}

export interface WaveIn {
  name: string;
  start: string;
  end: string;
  cutover?: string | null;
  capacity: Record<string, number>;
}

export interface BrokenConstraint {
  constraint: string;
  wave: string | null;
  role?: string;
  item?: string;
  detail: string;
  over_by_hours?: number;
}

export interface WaveOption {
  option: string;
  detail: string;
  wave?: string;
  role?: string;
  hours?: number;
  item?: string;
  to?: string;
}

export interface WavePlan {
  status: string;
  fits: boolean;
  assignments: Record<string, string>;
  broken: BrokenConstraint[];
  options: WaveOption[];
  load: Record<string, Record<string, { hours: number; capacity: number }>>;
  vendor_dependencies?: {
    gap_id: Uuid;
    title: string;
    vendor_ref: string | null;
    blocks_waves: string[];
  }[];
  items?: number;
  solved_at?: DateTime;
}

// ---------- Planning workbench (E16.F2.S1) ----------

export interface ScopeKey {
  key: string;
  element: string;
  stream: string;
  disposition: string;
}

export interface WorkbenchWave {
  key: string;
  name: string | null;
  start: string | null;
  end: string | null;
  cutover: string | null;
  capacity: Record<string, number>;
  load: Record<string, { hours: number; capacity: number }>;
  /** Scope keys the solver placed in the wave. */
  items: string[];
}

export interface WorkbenchItem {
  key: string;
  element: string;
  kind: string;
  stream: string;
  segment: string | null;
  disposition: string;
  status: string;
  wave: string | null;
  pinned_wave: string | null;
  depth: number;
  tasks: number;
  overridden_tasks: number;
  low: number;
  likely: number;
  high: number;
  roles: Record<string, number>;
  depends_on: string[];
}

export interface WorkbenchEdge {
  key: string;
  src: string;
  dst: string;
  source: string | null;
  kinds: string[];
  removed: { by: string; at: DateTime; reason: string } | null;
}

export interface PlanWorkbench {
  waves: WorkbenchWave[];
  items: WorkbenchItem[];
  /** Items with estimated work that the solver has not placed. */
  unplaced: string[];
  /** Items with no estimated work. */
  unestimated: string[];
  edges: WorkbenchEdge[];
  cycles: string[][];
  plan: WavePlan | null;
  /** Scope, edges, tasks, waves or pins changed after the last solve. */
  stale: boolean;
  roles: string[];
  can_edit: boolean;
}

export type WorkbenchEdit =
  | { op: 'move'; scope_key: string; wave: string | null }
  | { op: 'add_dependency'; src: string; dst: string; reason: string }
  | { op: 'remove_dependency'; key: string; reason: string }
  | {
      op: 'task';
      key: string;
      role?: string;
      low?: number;
      likely?: number;
      high?: number;
      reason: string;
    };

export interface WorkbenchEditResult extends PlanWorkbench {
  applied: string[];
  /** The edits were saved but the solver could not run. */
  solve_error: string | null;
  solved_at: DateTime;
}

export interface WavesView {
  waves: Wave[];
  pins: Record<string, { wave: string; by: string; at: DateTime }>;
  plan: WavePlan | null;
  roles: string[];
}

// ---------- Risks ----------

export interface Risk {
  key: string;
  title: string;
  detail: string;
  likelihood: number;
  impact: number;
  score: number;
  owner_user_id: Uuid | null;
  owner_name: string | null;
  mitigation_task: string | null;
  /** proposed | accepted | rejected | closed */
  status: string;
  /** person | planner | agent */
  source: string;
  decision: { by: string; at: DateTime; note: string } | null;
}

export interface RiskIn {
  title: string;
  detail: string;
  likelihood: number;
  impact: number;
  owner_user_id?: Uuid | null;
  mitigation_task?: string | null;
}

export interface RiskPatch {
  status?: 'accepted' | 'rejected' | 'closed';
  likelihood?: number;
  impact?: number;
  owner_user_id?: Uuid | null;
  mitigation_task?: string;
  note?: string;
}

// ---------- Cutover ----------

export const CUTOVER_OPTIONS = ['whole_estate', 'phased', 'parallel_run'] as const;
export type CutoverOption = (typeof CUTOVER_OPTIONS)[number];

export interface CutoverAssumptions {
  extract_hours?: number;
  reconciliation_minutes_per_entity?: number;
  parallel_run_weeks?: number;
  parallel_hours_per_day?: number;
  switch_minutes?: number;
}

export interface CutoverComparisonOption {
  option: CutoverOption;
  windows: number;
  longest_window_hours: number;
  durations_known: boolean;
  elapsed_days: number | null;
  effort_hours: number;
  risk: number;
  risk_factors: { factor: string; value: unknown; detail: string }[];
  constraints: { constraint: string; ok: boolean; detail: string }[];
  ok: boolean;
  steps: number;
}

export interface CutoverComparison {
  options: CutoverComparisonOption[];
  assumptions: Record<string, number>;
  inputs: {
    entities: {
      name: string;
      table: string;
      concept: string | null;
      rows: number | null;
      batch_size: number;
      wave: string | null;
    }[];
    requests_per_minute: number | null;
    loads_blocked: boolean;
    window_hours: number | null;
    waves: string[];
    blueprint_strategy?: string | null;
  };
}

export interface RunbookStep {
  key: string;
  title: string;
  role: string;
  planned_minutes: number | null;
  estimate_minutes: number | null;
  /** step | go_no_go | rollback */
  kind: string;
  basis: string;
  wave?: string | null;
  order?: number;
  rehearsals: { rehearsal: string; minutes: number; by: string; at: DateTime }[];
}

export interface Runbook {
  option: CutoverOption | null;
  steps: RunbookStep[];
  planned_hours: number;
  unknown_durations: string[];
}

export interface Coexistence {
  needed: string[];
  rules: Record<
    string,
    {
      entity: string;
      wave: string;
      system_of_record: 'source' | 'target';
      end_date: string;
      exit_reconciliation: string;
      by?: string;
      at?: DateTime;
    }
  >;
  warnings: { key: string; level: 'error' | 'warning'; detail: string }[];
  complete: boolean;
}

export interface CoexistenceIn {
  entity: string;
  wave: string;
  system_of_record: 'source' | 'target';
  end_date: string;
  exit_reconciliation: string;
}

// ---------- Baselines, diff, export, actuals ----------

export interface PlanDiff {
  baseline: PlanBaseline;
  added: string[];
  removed: string[];
  changed: { item: string; fields: { field: string; before: unknown; after: unknown }[] }[];
  by_kind: Record<string, { added: number; removed: number; changed: number }>;
  counts: { added: number; removed: number; changed: number };
  same: boolean;
}

export interface ActualsResult {
  rows: number;
  matched: number;
  unmatched: string[];
  hours: number;
}

// ---------- Gaps ----------

export const GAP_ROUTES = [
  'configuration',
  'customer_extension',
  'vendor_product_change',
  'process_change',
] as const;
export type GapRoute = (typeof GAP_ROUTES)[number];

export interface PlanGap {
  id: Uuid;
  project_id: Uuid;
  title: string;
  detail: string;
  scope_key: string | null;
  route: GapRoute | null;
  owner_user_id: Uuid | null;
  owner_name: string | null;
  product: string | null;
  vendor_ref: string | null;
  blocks_waves: string[];
  /** open | closed */
  status: string;
  close_note: string | null;
  closed_by: string | null;
  closed_at: DateTime | null;
  created_by: string | null;
  created_at: DateTime;
}

export interface GapIn {
  title: string;
  detail: string;
  scope_key?: string | null;
}

export interface GapPatch {
  route?: GapRoute;
  owner_user_id?: Uuid | null;
  vendor_ref?: string;
  blocks_waves?: string[];
  status?: 'open' | 'closed';
  close_note?: string;
}

export interface VendorChanges {
  programme: string;
  changes: {
    rank: number;
    change: string;
    product: string | null;
    customer_count: number;
    customers: string[];
    projects: string[];
    waves_blocked: number;
    gaps: Uuid[];
  }[];
}

// ---------- Pre-sales ----------

export interface Questionnaire {
  tables: number;
  customer_tables: number;
  code_objects: number;
  reports: number;
  interfaces: number;
  configuration_items: number;
  rows_millions: number;
  avg_columns?: number | null;
  team_hours_per_week: number;
  wave_weeks: number;
}

export interface PresalesIn {
  name: string;
  programme_id?: Uuid | null;
  estimation_packs: string[];
  questionnaire: Questionnaire;
  sample_extract_yaml?: string | null;
}

export interface PresalesResult {
  label: string;
  scope_outline: {
    elements: string;
    count: number;
    stream: string;
    disposition: string;
    hours: Range | null;
    rule?: string;
    pack?: string;
  }[];
  effort_hours: Range;
  waves: { wave: string; weeks: number; likely_hours: number }[];
  duration_weeks: number;
  assumptions: string[];
  unestimated: string[];
  basis: EstimationPackInfo[];
}

export interface PresalesEstimate {
  id: Uuid;
  name: string;
  programme_id: Uuid | null;
  estimation_packs: string[];
  questionnaire: Questionnaire;
  sample: Record<string, number> | null;
  result: PresalesResult;
  created_by: string | null;
  created_at: DateTime;
}
