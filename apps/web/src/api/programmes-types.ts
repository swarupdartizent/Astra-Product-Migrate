/**
 * Installed-base programmes (I12, E18): set-up, pods, programme waves, customer assignment,
 * consent and fleet scans, the Migration Complexity Index, the portfolio planner, the programme
 * view and commercial metering. Shapes follow api/routes/programmes.py and programme.py.
 */

import type { DateTime, Uuid } from './types';

export type Band = 'simple' | 'medium' | 'complex';
export const BANDS: readonly Band[] = ['simple', 'medium', 'complex'];

/** Whether the caller sees every customer (programme) or only its partners' customers. */
export type ProgrammeScope = 'programme' | 'partner';

// ---------- Programme detail (GET /programmes/{id}) ----------

export interface MciMeasureDef {
  key: string;
  label: string;
}

/** The programme's Complexity Index settings, defaults merged in (programme.config_of). */
export interface MciSettings {
  measures: MciMeasureDef[];
  weights: Record<string, number>;
  /** [low, high] per measure. */
  ranges: Record<string, [number, number]>;
  /** Upper limits: simple below `simple`, medium below `medium`, complex from `medium`. */
  bands: { simple: number; medium: number };
}

export interface Pod {
  id: Uuid;
  name: string;
  /** Customers the pod migrates at once in a wave. */
  capacity: number;
}

export interface ProgrammePartner {
  id: Uuid;
  name: string;
  pods: Pod[];
}

export interface ProgrammeWave {
  key: string;
  name: string;
  /** ISO dates. */
  start: string;
  end: string;
}

export interface ProgrammeCustomer {
  id: Uuid;
  name: string;
  partner_id: Uuid | null;
  segment: string | null;
}

export interface ProgrammeDetail {
  id: Uuid;
  name: string;
  description: string;
  source_adapter: string | null;
  target_adapter: string | null;
  blueprint_template: string | null;
  packs: string[];
  segments: string[];
  band_effort_weeks: Record<string, number>;
  mci: MciSettings;
  /** Only the partners the caller may see. */
  partners: ProgrammePartner[];
  waves: ProgrammeWave[];
  customers: ProgrammeCustomer[];
  scope: ProgrammeScope;
  /** Programme owner: set-up, pods, waves, customers and the portfolio plan. */
  can_manage: boolean;
  /** May record consent and run light scans. */
  can_scan: boolean;
}

export interface SetupIn {
  source_adapter: string | null;
  target_adapter: string | null;
  blueprint_template: string | null;
  packs: string[];
  segments: string[];
  mci_config: {
    weights: Record<string, number>;
    ranges: Record<string, [number, number]>;
    bands: { simple: number; medium: number };
  };
  band_effort_weeks: Record<Band, number>;
}

export interface PodIn {
  name: string;
  capacity: number;
}

export interface WaveIn {
  name: string;
  start: string;
  end: string;
}

export interface CustomerAssignIn {
  partner_id: Uuid | null;
  segment: string | null;
}

// ---------- Consent and fleet scans ----------

export interface Consent {
  id: Uuid;
  signatory_name: string;
  signatory_title: string;
  scope: string;
  reference: string;
  recorded_by: string | null;
  recorded_at: DateTime | null;
  active: boolean;
  revoked_at: DateTime | null;
  revoked_by: string | null;
  revoke_reason: string | null;
}

export interface ConsentIn {
  signatory_name: string;
  signatory_title: string;
  scope: string;
  reference: string;
}

export interface MciMeasureRow {
  key: string;
  label: string;
  value: number;
  low: number;
  high: number;
  normalised: number;
  weight: number;
  /** Points of the score (0–100 scale). */
  contribution: number;
}

export interface MciScore {
  score: number;
  band: Band;
  measures: MciMeasureRow[];
  bands: { simple: number; medium: number };
  formula: string;
}

export type FleetScanStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked';

export interface FleetScan {
  id: Uuid;
  tenant_id: Uuid;
  status: FleetScanStatus | (string & {});
  status_detail: string | null;
  /** Raw counts: only numbers are kept. */
  measures: Record<string, number>;
  mci: MciScore | null;
  job_id: Uuid | null;
  consent_id: Uuid;
  requested_by: string | null;
  created_at: DateTime | null;
  finished_at: DateTime | null;
}

export interface FleetRow {
  customer_id: Uuid;
  customer: string;
  segment: string | null;
  partner_id: Uuid | null;
  /** An active consent exists. */
  consent: boolean;
  /** The latest succeeded scan. */
  scan: FleetScan | null;
}

export interface FleetSegment {
  segment: string;
  customers: number;
  mean_score: number;
  band: Band;
  bands: Record<Band, number>;
}

export interface Fleet {
  customers: FleetRow[];
  segments: FleetSegment[];
  scope: ProgrammeScope;
}

// ---------- Portfolio planner ----------

export interface PlanAssignment {
  customer_id: Uuid;
  customer: string;
  partner_id: Uuid;
  segment: string | null;
  band: Band;
  weeks: number;
  wave: string;
  pod_id: Uuid;
  pod: string;
}

export interface PlanConflict {
  /** Null for a programme-wide conflict (no waves). */
  customer_id: Uuid | null;
  customer: string | null;
  band?: Band;
  reason: string;
}

export interface PodRotation {
  pod_id: Uuid;
  pod: string;
  partner_id: Uuid;
  capacity: number;
  waves: { wave: string; customers: string[] }[];
}

export interface PortfolioPlan {
  number: number;
  created_at?: DateTime | null;
  /** CP-SAT status name, lower case (optimal, feasible, …), or no_waves. */
  status: string;
  assignments: PlanAssignment[];
  conflicts: PlanConflict[];
  pods: PodRotation[];
  /** Absent when the programme had no waves. */
  waves?: ProgrammeWave[];
}

// ---------- Programme view ----------

export interface ProjectGates {
  project: string;
  project_id: Uuid;
  passed: number;
  of: number;
  next_gate: string | null;
}

export interface ViewCustomer {
  customer_id: Uuid;
  customer: string;
  partner_id: Uuid | null;
  partner: string | null;
  segment: string | null;
  band: Band | null;
  score: number | null;
  scanned_at: DateTime | null;
  gates: ProjectGates[];
  open_vendor_gaps: number;
  has_gaps: boolean;
  open_breaks: number;
  last_load: { number: number; kind: string; counts: Record<string, number> | null } | null;
  open_risks: number;
  actual_hours: number;
  /** The customer's database could not be read; risks and hours are unknown. */
  unavailable?: boolean;
}

export interface ProgrammeView {
  programme: { id: Uuid; name: string };
  customers: ViewCustomer[];
  totals: {
    customers: number;
    /** Band → count, including "not scanned". */
    bands: Record<string, number>;
    open_vendor_gaps: number;
    open_breaks: number;
    open_risks: number;
  };
  scope: ProgrammeScope;
}

// ---------- Metering ----------

export interface MeteringCustomer {
  customer_id: Uuid;
  customer: string;
  segment: string | null;
  partner_id: Uuid | null;
  band: Band | null;
  score: number | null;
  gates_passed: number;
  effort_hours: number;
  elapsed_days: number | null;
  wave: string | null;
}

export interface GateEvidence {
  customer_id: Uuid;
  customer: string;
  segment: string | null;
  project: string | null;
  gate: string;
  label: string;
  passed_at: DateTime | null;
  approvers: string;
  checklist_digest: string;
  band: Band | null;
}

export interface SegmentWave {
  segment: string;
  wave: string;
  customers: number;
  effort_hours: number;
  hours_per_customer: number;
  hours_per_score_point: number;
}

export interface Metering {
  customers: MeteringCustomer[];
  gate_evidence: GateEvidence[];
  segment_waves: SegmentWave[];
  plan_number: number | null;
}
