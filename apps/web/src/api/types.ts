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
