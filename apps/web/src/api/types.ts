/**
 * Wire types for the Astra Migrate API (/api/v1), written from GET /api/v1/openapi.json.
 * Mirror the backend exactly; do not add fields the API does not return.
 */

export type Uuid = string;
/** ISO 8601 date-time string. */
export type DateTime = string;

// ---------- Errors (RFC 9457 problem details) ----------

/** Per-field validation message (422 with type /problems/validation). */
export interface ProblemFieldError {
  /** Dotted path of the request field, e.g. "slug" or "session_timeout_minutes". */
  field: string;
  message: string;
}

export interface ProblemDetails {
  /** URI reference identifying the problem type, e.g. "/problems/mfa-required". */
  type: string;
  title: string;
  status: number;
  detail?: string | null;
  instance?: string | null;
  /** Present on validation problems. */
  errors?: unknown;
}

// ---------- Platform ----------

export type HealthStatus = 'ok' | 'degraded';
export type HealthCheckStatus = 'ok' | 'fail';

export interface HealthCheck {
  name: string;
  status: HealthCheckStatus;
  detail?: string | null;
}

export interface Health {
  status: HealthStatus;
  version: string;
  checks: HealthCheck[];
}

// ---------- Identity ----------

export type ScopeType = 'platform' | 'programme' | 'partner' | 'tenant' | 'project';

export interface RoleAssignment {
  role: string;
  role_label: string;
  scope_type: ScopeType;
  scope_id: Uuid | null;
  scope_name: string | null;
}

export interface Me {
  id: Uuid;
  email: string;
  display_name: string;
  /** True when the current sign-in included a second factor. */
  mfa: boolean;
  roles: RoleAssignment[];
  /** Union of permissions across every role and scope the user holds. */
  permissions: string[];
}

export interface RoleDef {
  key: string;
  label: string;
  description: string;
  permissions: string[];
  allowed_scopes: ScopeType[];
}

// ---------- Tenancy ----------

export interface Region {
  code: string;
  name: string;
  jurisdiction: string;
  model_endpoints: Record<string, unknown>;
}

export interface Partner {
  id: Uuid;
  name: string;
}

export interface Programme {
  id: Uuid;
  name: string;
  description: string;
  partners: Partner[];
}

export interface ProgrammeIn {
  name: string;
  description?: string;
}

export interface PartnerIn {
  name: string;
}

/** Known tenant lifecycle states. The API types this as a plain string. */
export type TenantStatus =
  'provisioning' | 'active' | 'migrating' | 'deleting' | 'deleted' | 'failed';

export interface Tenant {
  id: Uuid;
  slug: string;
  name: string;
  region_code: string;
  region_name: string | null;
  programme_id: Uuid | null;
  programme_name: string | null;
  partner_id: Uuid | null;
  partner_name: string | null;
  status: TenantStatus | (string & {});
  status_detail: string | null;
  key_name: string;
  mfa_required: boolean;
  session_timeout_minutes: number;
  created_at: DateTime;
  deleted_at: DateTime | null;
  /** Permissions the caller holds on this tenant. Use for per-tenant button gating. */
  permissions: string[];
  /** The provisioning or region-move job in progress, if any. */
  active_job: JobRef | null;
}

export interface TenantIn {
  slug: string;
  name: string;
  region_code: string;
  programme_id?: Uuid | null;
  partner_id?: Uuid | null;
  mfa_required?: boolean;
  session_timeout_minutes?: number;
}

export interface PolicyIn {
  mfa_required: boolean;
  session_timeout_minutes: number;
  reason?: string;
}

export interface DeleteIn {
  confirm_slug: string;
  reason: string;
}

export interface RegionMoveIn {
  to_region: string;
  reason: string;
}

export interface RegionMoveTableCount {
  source: number;
  target: number;
}

export interface RegionMove {
  id: Uuid;
  from_region: string;
  to_region: string;
  reason: string;
  /** "running" | "completed" | "failed" in the current backend. */
  status: string;
  /** { tables?: { [table]: {source, target} }, error?: string } */
  detail: Record<string, unknown>;
  requested_at: DateTime;
  completed_at: DateTime | null;
}

// ---------- Connector secrets ----------

export interface Secret {
  id: Uuid;
  name: string;
  /** "secret://name": what connectors reference; the value is never returned. */
  reference: string;
  description: string;
  current_version: number;
  created_at: DateTime;
  created_by_name: string | null;
  rotated_at: DateTime | null;
  last_read_at: DateTime | null;
  last_read_by: string | null;
}

export interface SecretIn {
  name: string;
  description?: string;
  value: string;
}

export interface RotateIn {
  value: string;
}

// ---------- Access ----------

export type UserStatus = 'active' | 'invited' | 'disabled';

export interface Assignment {
  id: Uuid;
  role: string;
  role_label: string;
  scope_type: ScopeType;
  scope_id: Uuid | null;
  scope_name: string | null;
  granted_at: DateTime;
}

export interface User {
  id: Uuid;
  email: string;
  display_name: string;
  status: UserStatus;
  last_seen_at: DateTime | null;
  assignments: Assignment[];
}

export interface InviteIn {
  email: string;
  display_name: string;
}

export interface SetActiveIn {
  active: boolean;
  reason: string;
}

export interface GrantIn {
  user_id: Uuid;
  role: string;
  scope_type: ScopeType;
  scope_id?: Uuid | null;
}

// ---------- Audit ----------

export type ActorType = 'user' | 'agent' | 'system';

export interface AuditEvent {
  seq: number;
  occurred_at: DateTime;
  actor_type: ActorType | (string & {});
  actor_id: string;
  actor_name: string;
  action: string;
  /** "success" | "denied" | "failure" */
  outcome: string;
  tenant_id: Uuid | null;
  project_id: Uuid | null;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
  trace_id: string | null;
  hash: string;
}

export interface AuditPage {
  items: AuditEvent[];
  next_before_seq: number | null;
}

export interface AuditFilters {
  tenant_id?: Uuid;
  project_id?: Uuid;
  actor_id?: string;
  actor_type?: ActorType;
  /** Action prefix, e.g. "tenant." */
  action?: string;
  since?: DateTime;
  until?: DateTime;
}

export interface AuditVerify {
  ok: boolean;
  events_checked: number;
  head_seq: number;
  head_hash: string | null;
  anchors_checked: number;
  problems: string[];
  anchored_seq: number | null;
}

export interface AuditAnchor {
  id: number;
  anchored_at: DateTime;
  head_seq: number;
  head_hash: string;
  key_name: string;
  key_version: number;
}

// ---------- Observability ----------

export type SummaryGroupBy = 'category' | 'tenant' | 'name' | 'stage' | 'agent' | 'project';

export interface SummaryRow {
  key: string | null;
  spans: number;
  errors: number;
  total_ms: number;
  p95_ms: number;
  cost_usd: number | null;
}

export interface TraceRow {
  trace_id: string;
  name: string;
  started_at: DateTime;
  duration_ms: number;
  status: string;
  span_count: number;
  tenant_id: string | null;
  cost_usd: number | null;
}

export interface Span {
  span_id: string;
  parent_span_id: string | null;
  name: string;
  category: string;
  started_at: DateTime;
  duration_ms: number;
  status: string;
  stage: string | null;
  agent: string | null;
  model: string | null;
  cost_usd: number | null;
  attributes: Record<string, unknown>;
}

export interface TraceDetail {
  trace_id: string;
  jaeger_url: string | null;
  spans: Span[];
}

// ---------- Packs (tag "packs") ----------

export type PackType =
  'source_adapter' | 'target_adapter' | 'domain' | 'compliance' | 'pattern' | 'agentification';

export type PackStatus = 'draft' | 'published' | 'deprecated';

export type ControlType =
  'data_handling' | 'approval' | 'gate' | 'evidence' | 'residency' | 'retention';

/** Which value of a setting is stricter. "none" = no order. */
export type Strictness = 'higher' | 'lower' | 'true' | 'false' | 'none';

export type SettingValueType = number | boolean | string;

export interface PackSummary {
  id: Uuid;
  name: string;
  version: string;
  type: PackType | (string & {});
  title: string;
  status: PackStatus;
  /** null = tests not run yet. */
  tests_passed: boolean | null;
  reviewed_by_name: string | null;
  published_at: DateTime | null;
  created_at: DateTime;
}

export interface PackSource {
  reference: string;
  url?: string | null;
}

export interface PackRequirement {
  name: string;
  versions: string;
  reason?: string;
}

export interface PackControl {
  id: string;
  type: ControlType;
  title: string;
  rule: string;
  evidence_required: string;
  sources: PackSource[];
  gate?: string | null;
  parameters?: Record<string, unknown>;
  compliance_critical?: boolean;
  two_person_approval?: boolean;
}

export interface PackRule {
  id: string;
  statement: string;
  applies_to?: string[];
  severity?: 'blocking' | 'warning';
  sources?: PackSource[];
}

export interface PackSetting {
  key: string;
  value: SettingValueType;
  stricter: Strictness;
  unit?: string | null;
  description?: string;
  sources?: PackSource[];
}

/** pack.yaml as stored (keys as in the file, e.g. apiVersion). */
export interface PackManifest {
  apiVersion?: string;
  type: PackType;
  name: string;
  version: string;
  title: string;
  description?: string;
  publisher: string;
  licence?: string;
  standards?: string[];
  disclaimer?: string | null;
  requires?: PackRequirement[];
  adds?: { controls?: PackControl[]; rules?: PackRule[]; settings?: PackSetting[] };
  content?: Record<string, unknown>;
  tests?: Record<string, unknown>[];
}

export interface PackFile {
  path: string;
  size: number;
  sha256: string;
}

export interface PackCheck {
  name: string;
  passed: boolean;
  message: string;
}

export interface PackTestReport {
  passed: boolean;
  ran_at: DateTime;
  digest: string;
  checks: PackCheck[];
}

export interface PackDetail extends PackSummary {
  manifest: PackManifest;
  digest: string;
  files: PackFile[];
  test_report: PackTestReport | null;
  reviewed_by_role: string | null;
  reviewed_at: DateTime | null;
  created_by: string;
  published_by: string | null;
  /** All versions of this pack, newest first (includes this one). */
  other_versions: string[];
}

export interface PackFileContent {
  path: string;
  text: string | null;
  size: number;
  binary: boolean;
}

export interface ControlPlacement {
  type: ControlType;
  area: string;
  detail: string;
}

export interface PackSectionDiff<T> {
  added: T[];
  removed: T[];
  changed: { id: string; before: T; after: T }[];
}

export interface PackDiff {
  from: string;
  to: string;
  controls: PackSectionDiff<PackControl>;
  rules: PackSectionDiff<PackRule>;
  settings: PackSectionDiff<PackSetting>;
  requires: { before: PackRequirement[]; after: PackRequirement[] };
}

export interface ComposedControl extends PackControl {
  key: string;
  pack: string;
  placement: { area: string; detail: string };
}

export interface ComposedSetting {
  key: string;
  stricter: Strictness;
  unit: string | null;
  conflict: boolean;
  /** Stricter value when ordered; null for unordered conflicts. */
  strictest: SettingValueType | null;
  fingerprint: string;
  values: { pack: string; value: SettingValueType }[];
}

export interface CompositionProblem {
  severity: 'blocking' | 'warning';
  code: string;
  path: string;
  message: string;
  fix: string;
}

export interface Composition {
  packs: string[];
  controls: ComposedControl[];
  rules: (PackRule & { pack: string })[];
  settings: ComposedSetting[];
  problems: CompositionProblem[];
}

// ---------- Projects and blueprints (tag "blueprints") ----------

export interface VersionSummary {
  number: number;
  /** "draft" | "approved" | "superseded" | "rejected" */
  status: string;
  message: string;
  author_name: string;
  created_at: DateTime;
  commit_sha: string;
  template: string | null;
}

export interface PlanningGate {
  ready: boolean;
  reason: string;
  version: number | null;
}

export interface Project {
  id: Uuid;
  tenant_id: Uuid;
  tenant_name: string;
  name: string;
  description: string;
  status: string;
  created_at: DateTime;
  latest_version: VersionSummary | null;
  approved_version: number | null;
  planning_gate: PlanningGate;
  /** Permissions the caller holds on this project. */
  permissions: string[];
  /** Role keys the caller holds on this project. */
  roles: string[];
}

export interface ProjectIn {
  name: string;
  description?: string;
  template?: string | null;
}

export interface ValidationIssue {
  severity: 'blocking' | 'warning';
  code: string;
  path: string;
  message: string;
  fix: string;
}

export interface BlueprintValidation {
  ok: boolean;
  blocking: number;
  warnings: number;
  issues: ValidationIssue[];
  composition: Composition | null;
  open_decisions: { id: Uuid; kind: string; subject: string; status: string }[];
}

export interface Approval {
  user_name: string;
  role: string;
  decision: 'approve' | 'reject' | (string & {});
  reason: string;
  decided_at: DateTime;
}

export interface VersionDetail extends VersionSummary {
  yaml_text: string;
  content: Record<string, unknown>;
  validation: BlueprintValidation;
  required_roles: string[];
  approvals: Approval[];
  git_verified: boolean;
  /** Roles the caller can still approve as; empty = no approve/reject buttons. */
  can_approve_as: string[];
}

/** Exactly one of yaml_text (file) or content (form). */
export type BlueprintBody = { yaml_text: string } | { content: Record<string, unknown> };

export type SaveVersionIn = BlueprintBody & { message: string };

export interface ConvertOut {
  yaml_text: string;
  content: Record<string, unknown>;
}

export interface BlueprintDiff {
  from: VersionSummary;
  to: VersionSummary;
  added: { path: string; value: unknown }[];
  removed: { path: string; value: unknown }[];
  changed: { path: string; before: unknown; after: unknown }[];
}

export interface ApproveIn {
  approve: boolean;
  reason?: string;
}

export interface SettingConflictContext {
  key: string;
  stricter: Strictness;
  unit: string | null;
  strictest: SettingValueType | null;
  values: {
    pack: string;
    value: SettingValueType;
    description?: string;
    sources?: PackSource[];
  }[];
}

export interface LooseningContext {
  setting: string;
  value: SettingValueType;
  effective: SettingValueType | null;
  reason?: string;
  packs?: string[];
}

export interface Decision {
  id: Uuid;
  kind: 'setting_conflict' | 'loosening';
  subject: string;
  status: 'open' | 'decided' | 'rejected';
  /** SettingConflictContext or LooseningContext depending on kind. */
  context: Record<string, unknown>;
  chosen_value: SettingValueType | null;
  reason: string | null;
  requested_by_name: string | null;
  decided_by_name: string | null;
  decided_at: DateTime | null;
  created_at: DateTime;
  can_decide: boolean;
}

export interface DecideIn {
  reason: string;
  chosen_value?: SettingValueType | null;
  approve?: boolean;
}

export interface BlueprintTemplate {
  id: Uuid;
  name: string;
  title: string;
  description: string;
  yaml_text: string;
  created_by: string;
  created_at: DateTime;
}

export interface TemplateIn {
  name: string;
  title: string;
  description?: string;
  yaml_text: string;
}

// ---------- Background jobs (tag "jobs") ----------

/** "queued" | "running" | "succeeded" | "failed" | "cancelled" in the current runner. */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | (string & {});

export interface Job {
  id: Uuid;
  kind: string;
  title: string;
  status: JobStatus;
  /** 0–100 */
  progress: number;
  progress_message: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  max_attempts: number;
  tenant_id: Uuid | null;
  project_id: Uuid | null;
  requested_by: string;
  trace_id: string | null;
  created_at: DateTime;
  started_at: DateTime | null;
  finished_at: DateTime | null;
}

/** The short form embedded in TenantOut.active_job. */
export interface JobRef {
  id: Uuid;
  kind: string;
  status: JobStatus;
  progress: number;
  progress_message: string | null;
}

// ---------- Model gateway (tag "models") ----------

export type ProviderKind = 'anthropic' | 'anthropic_foundry' | 'azure_openai';

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface ModelProvider {
  id: Uuid;
  name: string;
  kind: ProviderKind | (string & {});
  kind_label: string;
  endpoint: string | null;
  api_version: string | null;
  has_credential: boolean;
  credential_version: number | null;
  no_training_terms: boolean;
  terms_reference: string;
  options: Record<string, unknown>;
  prices: Record<string, ModelPrice>;
  enabled: boolean;
  usable: boolean;
  /** Why the provider cannot be used yet (empty when usable). */
  problems: string[];
  /** "unchecked" | "ok" | "failed" */
  check_status: string;
  check_detail: string | null;
  checked_at: DateTime | null;
  /** Regions whose tenants this provider kind can serve. */
  regions: string[];
  aliases: string[];
  created_at: DateTime;
}

export interface ProviderIn {
  name: string;
  kind: ProviderKind;
  endpoint?: string | null;
  api_version?: string | null;
  no_training_terms: boolean;
  terms_reference?: string;
  options?: Record<string, boolean>;
  prices?: Record<string, ModelPrice> | null;
}

export interface ProviderUpdate extends ProviderIn {
  enabled: boolean;
}

export interface ModelAlias {
  alias: string;
  provider_id: Uuid;
  provider_name: string;
  provider_usable: boolean;
  model: string;
  description: string;
  price_configured: boolean;
  updated_at: DateTime;
}

export interface AliasIn {
  provider_id: Uuid;
  model: string;
  description?: string;
  reason: string;
}

export interface ModelCall {
  id: Uuid;
  created_at: DateTime;
  provider_name: string;
  provider_kind: string;
  alias: string | null;
  requested_model: string;
  served_model: string | null;
  api_version: string | null;
  sdk_version: string | null;
  request_id: string | null;
  agent_name: string | null;
  agent_version: string | null;
  agent_run_id: Uuid | null;
  test_run_id: Uuid | null;
  tenant_id: Uuid | null;
  project_id: Uuid | null;
  region_code: string | null;
  region_pinned: boolean | null;
  status: string;
  stop_reason: string | null;
  error: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** null = no price configured for the served model. */
  cost_usd: number | null;
  latency_ms: number;
  trace_id: string | null;
}

export type UsageGroupBy = 'agent' | 'served_model' | 'provider' | 'alias' | 'project' | 'tenant';

export interface UsageRow {
  key: string | null;
  calls: number;
  errors: number;
  refused: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  /** Successful calls with no price configured (their cost is not in cost_usd). */
  unpriced_calls: number;
  p95_latency_ms: number;
}

// ---------- Agents (tag "agents") ----------

export interface AgentTool {
  name: string;
  description: string;
  /** e.g. "read", "propose", "delegate" */
  effect: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCatalogue {
  tools: AgentTool[];
  /** Effects no platform tool can ever have. */
  forbidden_effects: string[];
}

export interface AgentVersionSummary {
  id: Uuid;
  version: string;
  /** "draft" | "released" | "deprecated" */
  status: string;
  risk_rating: string;
  created_at: DateTime;
  released_at: DateTime | null;
  latest_test_status: string | null;
}

export interface Agent {
  name: string;
  title: string;
  team: string;
  purpose: string;
  identity_user_id: Uuid;
  versions: AgentVersionSummary[];
  latest_released: string | null;
}

export interface AgentCatalogItem {
  file: string;
  name: string;
  version: string;
  title: string;
  registered_status: string | null;
}

export interface ManifestValidation {
  valid: boolean;
  errors: { field: string; message: string }[];
}

export type TestCaseKind = 'tool_policy' | 'screening' | 'model';
export type TestCaseStatus = 'passed' | 'failed' | 'blocked';

export interface TestCaseResult {
  name: string;
  kind: TestCaseKind | (string & {});
  status: TestCaseStatus | (string & {});
  detail: string;
  tools_called?: string[];
  models?: string[];
  screening?: { source: string; flagged: boolean; rules: string[] }[];
  answer?: string;
  cost_usd?: number;
}

export interface AgentTestRun {
  id: Uuid;
  agent: string;
  version: string;
  /** "queued" | "running" | "passed" | "failed" | "blocked" | "error" */
  status: string;
  digest_matches: boolean;
  job_id: Uuid | null;
  started_by: string | null;
  started_at: DateTime;
  finished_at: DateTime | null;
  /** {total, passed, failed, blocked} or {note} */
  summary: Record<string, unknown>;
  results: TestCaseResult[];
  cost_usd: number;
}

/** The manifest as stored (agents/manifest.py AgentManifest). */
export interface AgentManifest {
  apiVersion?: string;
  name: string;
  version: string;
  title: string;
  team: string;
  purpose: string;
  data_access: 'metadata_only' | 'business_data' | (string & {});
  model: { alias: string; effort?: string; max_tokens?: number };
  instructions: string;
  tools?: string[];
  guardrails?: {
    screen_untrusted_inputs?: boolean;
    max_model_calls?: number;
    max_tool_calls?: number;
    max_cost_usd?: number;
    max_delegation_depth?: number;
  };
  oversight: { autonomy: string; human_review: string[]; escalation: string };
  governance: {
    risk_rating: string;
    risk_rationale: string;
    intended_use: string;
    out_of_scope?: string[];
    regulatory_notes?: string;
  };
  tests: Record<string, unknown>[];
}

export interface AgentVersionDetail {
  id: Uuid;
  agent: string;
  version: string;
  status: string;
  digest: string;
  manifest: AgentManifest;
  manifest_yaml: string;
  created_by: string | null;
  created_at: DateTime;
  released_by: string | null;
  released_at: DateTime | null;
  release_note: string | null;
  latest_test_run: AgentTestRun | null;
  /** Why release is refused right now (empty = can be released). */
  release_blockers: string[];
  model_ready: boolean;
  /** Where the model alias resolves to, or why it is blocked. */
  model_status: string;
  /** ["agent:manage"] when the caller may act on agent versions. */
  permissions: string[];
}

export interface TestRunSummary {
  id: string;
  status: string;
  started_at: DateTime;
  finished_at: DateTime | null;
  summary: Record<string, unknown>;
  cost_usd: number;
  digest_matches: boolean;
}

/** registry.governance_record (the endpoint is typed as a plain object). */
export interface GovernanceRecord {
  agent: string;
  version: string;
  status: string;
  digest: string;
  title: string;
  team: string;
  purpose: string;
  risk_rating: string;
  risk_rationale: string;
  intended_use: string;
  out_of_scope: string[];
  regulatory_notes: string;
  oversight: { autonomy: string; human_review: string[]; escalation: string };
  data_access: string;
  tools: { name: string; effect: string; description: string }[];
  guardrails: Record<string, unknown>;
  hard_rules: string[];
  model: {
    alias: string;
    effort: string;
    currently_resolves_to: { provider_id: string; model: string } | null;
    models_that_answered: string[];
  };
  usage: { model_calls: number; cost_usd: number; agent_runs: number; projects_pinned: number };
  tests: {
    cases: number;
    by_kind: Record<string, number>;
    latest: TestRunSummary | null;
    history: TestRunSummary[];
  };
  release: {
    released_at: DateTime | null;
    released_by: string | null;
    test_run_id: string | null;
    note: string | null;
  };
  registered_at: DateTime;
}

export interface ModelReadiness {
  alias: string;
  ready: boolean;
  /** Where the alias resolves to, or why it is blocked. */
  detail: string;
  agents: string[];
}

export interface ScreeningFinding {
  rule: string;
  label: string;
  severity: string;
  excerpt: string;
  encoded: boolean;
}

export interface ScreenOut {
  flagged: boolean;
  severity: string | null;
  hidden_characters: number;
  findings: ScreeningFinding[];
  /** Exactly how the text would be passed to an agent. */
  wrapped: string;
  /** The text with hidden characters made visible. */
  visible_text: string;
}

// ---------- Project runtime (tag "runtime") ----------

export interface AgentPin {
  agent: string;
  title: string;
  team: string;
  pinned_version: string | null;
  pinned_status: string | null;
  pinned_by: string | null;
  pinned_at: DateTime | null;
  reason: string | null;
  released_versions: string[];
  newer_release: string | null;
}

export interface AgentRun {
  id: Uuid;
  project_id: Uuid;
  agent: string;
  agent_version: string;
  parent_run_id: Uuid | null;
  /** "queued" | "running" | "succeeded" | "failed" | "blocked" ... */
  status: string;
  status_detail: string | null;
  requested_by: string;
  /** "user" | "agent" | "system" */
  requested_by_type: string;
  job_id: Uuid | null;
  model_calls: number;
  tool_calls: number;
  denied_tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  trace_id: string | null;
  created_at: DateTime;
  started_at: DateTime | null;
  finished_at: DateTime | null;
}

export type RunEventKind =
  'model_request' | 'model_response' | 'tool_call' | 'tool_result' | 'guardrail' | 'error';

export interface RunEvent {
  seq: number;
  kind: RunEventKind | (string & {});
  payload: Record<string, unknown>;
  created_at: DateTime;
}

export interface AgentRunDetail extends AgentRun {
  objective: string | null;
  output: string | null;
  events: RunEvent[];
}

export interface ReviewItem {
  id: Uuid;
  project_id: Uuid;
  kind: string;
  title: string;
  question: string;
  options: string[];
  context: Record<string, unknown>;
  owner_role: string;
  owner_role_label: string;
  owner_user: string | null;
  requested_by: string;
  requested_by_type: string;
  agent_run_id: Uuid | null;
  /** "open" | "resolved" | "dismissed" */
  status: string;
  resolution: string | null;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: DateTime | null;
  created_at: DateTime;
  can_resolve: boolean;
  /** Screening flags only, on GET /review-items/{id}: the legacy text, hidden characters revealed. */
  flagged_text?: string | null;
}

export interface ResolveIn {
  action: 'resolve' | 'dismiss';
  resolution?: string | null;
  note?: string;
}

export type StageStatus = 'not_started' | 'blocked' | 'in_progress' | 'done';

export interface ProjectStage {
  stage: string;
  title: string;
  status: StageStatus | (string & {});
  note: string;
  updated_by: string | null;
  updated_by_type: string | null;
  updated_at: DateTime | null;
}
