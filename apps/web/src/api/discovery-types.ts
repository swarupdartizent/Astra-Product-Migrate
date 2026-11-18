/**
 * Discovery and the Migration Knowledge Graph (API tag "discovery"). Result sections are JSON built
 * from the platform's dataclasses, so only their fields appear (computed properties such as a
 * column's null rate or a configuration item's digest are not sent).
 */
import type { DateTime, Uuid } from './types';

// ---------- Activity imports ----------

export interface ActivityImport {
  id: Uuid;
  connection_id: Uuid;
  filename: string;
  sha256: string;
  records: number;
  first_at: DateTime | null;
  last_at: DateTime | null;
  days: number;
  created_by: string | null;
  created_at: DateTime;
}

export interface ActivityIn {
  filename: string;
  content_base64: string;
}

// ---------- Runs ----------

/** done | partial | failed | skipped */
export type PhaseStatus = 'done' | 'partial' | 'failed' | 'skipped' | (string & {});

export interface DiscoveryPhase {
  status: PhaseStatus;
  detail: string;
  counts: Record<string, unknown>;
}

export interface DiscoverySummary {
  coverage_pct?: number;
  nodes?: number;
  edges?: number;
  by_stream?: Record<string, number>;
  estate_score?: number;
  rules?: number;
  interfaces?: number;
  unused?: number;
  evidence_days?: number;
  configuration_items?: number;
  documents?: number | null;
  document_bytes?: number | null;
}

export interface DiscoveryRun {
  id: Uuid;
  project_id: Uuid;
  connection_id: Uuid;
  connection_name: string | null;
  adapter: string;
  /** queued | running | succeeded | failed | blocked | cancelled */
  status: string;
  status_detail: string | null;
  as_of: DateTime;
  window_days: number;
  phases: Record<string, DiscoveryPhase>;
  summary: DiscoverySummary;
  job_id: Uuid | null;
  requested_by: string;
  created_at: DateTime;
  finished_at: DateTime | null;
  coverage_report_id: Uuid | null;
}

export interface DiscoveryRunIn {
  connection_id: Uuid;
  window_days: number;
  as_of?: DateTime | null;
}

// ---------- Result sections ----------

export interface ColumnPattern {
  shape: string;
  share: number;
}

export interface ColumnProfile {
  column: string;
  data_type: string;
  rows: number;
  nulls: number;
  distinct: number | null;
  patterns: ColumnPattern[];
}

export interface BrokenReference {
  relation: string;
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
  enforced: boolean;
  broken_rows: number;
}

export interface TableProfile {
  table: string;
  rows: number;
  columns: ColumnProfile[];
  broken: BrokenReference[];
  components: Record<string, number>;
  score: number;
  error: string | null;
}

export interface ProfileSection {
  estate_score: number;
  weights: Record<string, number>;
  tables: TableProfile[];
}

export interface ElementUsage {
  element: string;
  kind: string;
  reads: number;
  writes: number;
  executions: number;
  last_used: DateTime | null;
  via: string[];
}

export interface UsageSection {
  window_start: DateTime | null;
  window_end: DateTime | null;
  evidence_days: number;
  note: string | null;
  unused: string[];
  elements: ElementUsage[];
}

export interface CodeRule {
  id: string;
  object: string;
  object_type: string;
  kind: string;
  statement: string;
  confidence: number;
  excerpt: string;
  line_from: number;
  line_to: number;
  reads: string[];
  sets: string[];
}

export interface DiscoveredInterface {
  key: string;
  name: string;
  /** program | report_tool | linked_server | external_program */
  kind: string;
  /** query_log | login_log | code | configuration | session */
  source: string;
  program: string | null;
  hosts: string[];
  logins: string[];
  events: number;
  per_day: number;
  first_seen: DateTime | null;
  last_seen: DateTime | null;
  reads: string[];
  writes: string[];
  executes: string[];
  evidence: string[];
}

export interface ConfigItem {
  kind: string;
  key: string;
  name: string;
  scope: string | null;
  definition: string;
  depends_on: string[];
  /** Not sent today (a computed property on the platform side); kept optional. */
  digest?: string;
}

export interface ConfigDiff {
  scopes: string[];
  only_in_some: { kind: string; name: string; present_in: string[]; missing_in: string[] }[];
  different: { kind: string; name: string; definitions: Record<string, string> }[];
  same_everywhere: number;
}

export interface ConfigurationSection {
  items: ConfigItem[];
  problems: string[];
  diff: ConfigDiff;
}

export interface DocumentRow {
  type: string;
  age: string;
  link_entity: string;
  count: number;
  bytes: number;
}

export interface DocumentsSection {
  rows: DocumentRow[];
  total_count: number;
  total_bytes: number;
}

export interface DictionaryRelation {
  name: string;
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
  enforced: boolean;
}

export interface DictionarySection {
  columns: number;
  relations: DictionaryRelation[];
  code_lists: { name: string; table: string; values: Record<string, string>[] }[];
  problems: string[];
}

export interface DiscoveryGap {
  id: string;
  stream: string;
  /** blocking | warning */
  severity: string;
  message: string;
}

export interface ResultSections {
  profile: ProfileSection;
  usage: UsageSection;
  rules: CodeRule[];
  interfaces: DiscoveredInterface[];
  configuration: ConfigurationSection;
  /** null when the adapter declares no document store */
  documents: DocumentsSection | null;
  dictionary: DictionarySection;
  gaps: DiscoveryGap[];
}

export type ResultSection = keyof ResultSections;

// ---------- Knowledge graph ----------

export interface GraphNode {
  id: string;
  kind: string;
  stream: string;
  element: string;
  usage: Record<string, unknown> | null;
  concept: string | null;
  target: string | null;
  props: Record<string, unknown> | null;
}

export interface GraphPage {
  total: number;
  offset: number;
  counts: { kind: string; stream: string; nodes: number }[];
  streams: Record<string, string>;
  nodes: GraphNode[];
}

export interface GraphQuery {
  kind?: string;
  stream?: string;
  q?: string;
  unused?: boolean;
  offset: number;
  limit: number;
}

export interface GraphEdge {
  type: string;
  node_id: string;
  element: string | null;
  node_kind: string | null;
  props: Record<string, unknown> | null;
}

export interface GraphNodeDetail {
  node: GraphNode;
  outgoing: GraphEdge[];
  incoming: GraphEdge[];
}

// ---------- Coverage report ----------

export interface CoverageStream {
  stream: string;
  title: string;
  /** covered | partial | gap | not_started */
  status: string;
  counts: Record<string, unknown>;
  gaps: string[];
}

export interface CoverageWaiver {
  gap_id: string;
  reason: string;
  by: string;
  by_id?: string;
  at: DateTime;
}

export interface CoverageReport {
  id: Uuid;
  project_id: Uuid;
  discovery_run_id: Uuid;
  coverage_pct: number;
  streams: CoverageStream[];
  gaps: DiscoveryGap[];
  waivers: CoverageWaiver[];
  /** draft | accepted | rejected | superseded */
  status: string;
  blocking_open: string[];
  decided_by: string | null;
  decided_at: DateTime | null;
  decision_note: string | null;
  created_at: DateTime;
  can_decide: boolean;
}
