import type {
  Approval,
  BlueprintValidation,
  ComposedSetting,
  SettingValueType,
  Strictness,
} from '@/api/types';
import type { Tone } from '@/ui';

/** A blueprint as edited in the form: the same mapping the API stores (`content`). */
export type Content = Record<string, unknown>;
export type Path = readonly (string | number)[];

export const API_VERSION = 'astra.blueprints/v1';

export const PATTERNS = [
  {
    value: 'cross_product',
    label: 'Cross-product',
    description: 'Move from one product to a different product, mapping data and configuration.',
  },
  {
    value: 'same_family_upgrade',
    label: 'Same-family upgrade',
    description: 'Upgrade to a newer version of the same product family.',
  },
  {
    value: 'consolidation',
    label: 'Consolidation',
    description: 'Merge several source estates into one target.',
  },
] as const;

export const CUTOVER_STRATEGIES = [
  { value: 'whole_estate', label: 'Whole estate at once' },
  { value: 'phased', label: 'Phased' },
  { value: 'parallel_run', label: 'Parallel run' },
] as const;

export const PLANNING_MODES = [
  { value: 'delivery', label: 'Delivery' },
  { value: 'pre_sales', label: 'Pre-sales estimate' },
  { value: 'installed_base', label: 'Installed-base programme' },
] as const;

export const RISK_APPETITES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
] as const;

export const STREAMS = [
  'data',
  'configuration',
  'customizations',
  'integrations',
  'reports',
  'security',
  'process',
  'agentification',
  'platform',
] as const;

export const PACK_LISTS = [
  { field: 'domain_packs', type: 'domain', label: 'Domain packs' },
  { field: 'compliance_packs', type: 'compliance', label: 'Compliance packs' },
  { field: 'pattern_packs', type: 'pattern', label: 'Pattern packs' },
  { field: 'agentification_packs', type: 'agentification', label: 'Agentification packs' },
] as const;

/** Defaults the API applies when approvals are not set. */
export const DEFAULT_APPROVERS = ['migration_lead', 'customer_data_owner'] as const;

export const MAX_TASK_HOURS = 40;

/** Blueprint names: lowercase letters, digits and hyphens. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return slug.length >= 3 ? slug : `${slug || 'blueprint'}-draft`.slice(0, 120);
}

/** The starting point when a project has no version yet. Adapters are left for the user. */
export function emptyBlueprint(projectName: string): Content {
  return {
    apiVersion: API_VERSION,
    name: slugify(projectName),
    description: '',
    pattern: 'cross_product',
    source: { adapter: '' },
    target: { adapter: '' },
    domain_packs: [],
    compliance_packs: [],
    pattern_packs: [],
    agentification_packs: [],
  };
}

// ---------- Immutable path helpers ----------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getIn(content: unknown, path: Path): unknown {
  let current: unknown = content;
  for (const key of path) {
    if (typeof key === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[key];
    } else {
      if (!isRecord(current)) return undefined;
      current = current[key];
    }
  }
  return current;
}

/**
 * Returns a copy of `content` with `value` at `path`. `undefined` removes the key (so optional
 * fields disappear from the YAML instead of becoming nulls); parents are created as needed.
 */
export function setIn(content: Content, path: Path, value: unknown): Content {
  if (path.length === 0) return isRecord(value) ? value : content;
  const [head, ...rest] = path;
  if (head === undefined) return content;
  if (typeof head === 'number') throw new Error('The top level of a blueprint is a mapping.');
  const next: Content = { ...content };
  if (rest.length === 0) {
    if (value === undefined) return withoutKey(next, head);
    next[head] = value;
    return next;
  }
  const child = content[head];
  if (typeof rest[0] === 'number') {
    const list = Array.isArray(child) ? [...(child as unknown[])] : [];
    const index = rest[0];
    if (rest.length === 1) {
      if (value === undefined) list.splice(index, 1);
      else list[index] = value;
    } else {
      list[index] = setIn(isRecord(list[index]) ? list[index] : {}, rest.slice(1), value);
    }
    next[head] = list;
    return next;
  }
  next[head] = setIn(isRecord(child) ? child : {}, rest, value);
  return next;
}

/** Copy of a mapping without one key. */
export function withoutKey<T extends Record<string, unknown>>(record: T, key: string): T {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key)) as T;
}

export function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

export function asRecordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Text input → optional string (empty removes the key). */
export function optionalText(text: string): string | undefined {
  return text.trim() === '' ? undefined : text;
}

/** Number input → optional integer (empty removes the key; invalid stays as text for validation). */
export function optionalInt(text: string): number | string | undefined {
  if (text.trim() === '') return undefined;
  return /^-?\d+$/.test(text.trim()) ? Number(text.trim()) : text;
}

// ---------- Stream key/value rows ----------

export interface KeyValueRow {
  key: string;
  value: string;
}

/** Shows a stream value as text: strings as-is, everything else as JSON. */
export function formatValueText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** Reads a typed value back: true/false, numbers, JSON objects/arrays, otherwise text. */
export function parseValueText(text: string): unknown {
  const t = text.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t !== '' && /^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

export function recordToRows(record: unknown): KeyValueRow[] {
  if (!isRecord(record)) return [];
  return Object.entries(record).map(([key, value]) => ({ key, value: formatValueText(value) }));
}

/** Rows with an empty key are ignored (still being typed). Later duplicates win. */
export function rowsToRecord(rows: readonly KeyValueRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) out[key] = parseValueText(row.value);
  }
  return out;
}

// ---------- Overrides: tighten / loosen ----------

/** >0 when a is stricter than b, <0 looser, 0 equal. Mirrors the API's rule. */
export function compareStrictness(
  stricter: Strictness,
  a: SettingValueType,
  b: SettingValueType,
): number {
  if (a === b) return 0;
  switch (stricter) {
    case 'higher':
      return Number(a) > Number(b) ? 1 : -1;
    case 'lower':
      return Number(a) < Number(b) ? 1 : -1;
    case 'true':
      return a === true ? 1 : -1;
    case 'false':
      return a === false ? 1 : -1;
    default:
      return -1;
  }
}

export type OverrideDirection =
  'tighten' | 'same' | 'loosen_pending' | 'loosen_approved' | 'no_effect' | 'unknown';

export interface OverrideStatus {
  direction: OverrideDirection;
  label: string;
  tone: Tone;
  /** Effective value the override is compared with, when known. */
  effective?: SettingValueType | null;
}

/**
 * Live badge for override `index`. The validation result is the authority for loosening and
 * unknown settings; tightening/same are worked out from the composed setting.
 */
export function overrideStatus(
  override: { setting?: unknown; value?: unknown },
  index: number,
  validation: BlueprintValidation | undefined,
): OverrideStatus {
  if (!validation) return { direction: 'unknown', label: 'Checking…', tone: 'neutral' };
  const path = `overrides[${index}]`;
  const issues = validation.issues.filter((i) => i.path === path || i.path.startsWith(`${path}.`));
  if (issues.some((i) => i.code === 'override.loosening_unapproved')) {
    return { direction: 'loosen_pending', label: 'Loosens · needs approval', tone: 'danger' };
  }
  if (issues.some((i) => i.code === 'override.unknown_setting')) {
    return { direction: 'no_effect', label: 'No pack sets this', tone: 'warning' };
  }
  const setting = validation.composition?.settings.find((x) => x.key === override.setting);
  const value = override.value;
  if (
    !setting ||
    (typeof value !== 'number' && typeof value !== 'boolean' && typeof value !== 'string')
  ) {
    return { direction: 'unknown', label: 'Not checked', tone: 'neutral' };
  }
  const effective = effectiveValue(setting);
  if (effective === null) return { direction: 'unknown', label: 'Not checked', tone: 'neutral' };
  const c = compareStrictness(setting.stricter, value, effective);
  if (c > 0) return { direction: 'tighten', label: 'Tightens', tone: 'success', effective };
  if (c === 0) return { direction: 'same', label: 'Same as packs', tone: 'neutral', effective };
  return { direction: 'loosen_approved', label: 'Loosens · approved', tone: 'warning', effective };
}

/** The value packs agree on, or the stricter one when they conflict (display only). */
export function effectiveValue(setting: ComposedSetting): SettingValueType | null {
  const distinct = [...new Set(setting.values.map((v) => v.value))];
  if (distinct.length === 1) return distinct[0] ?? null;
  return setting.strictest;
}

/** Turns override value text into the type the setting uses. */
export function coerceOverrideValue(
  text: string,
  sample: SettingValueType | undefined,
): SettingValueType {
  if (typeof sample === 'boolean') return text === 'true';
  if (typeof sample === 'number') {
    const n = Number(text);
    return text.trim() !== '' && Number.isFinite(n) ? n : text;
  }
  return text;
}

// ---------- Approvals ----------

export interface ApprovalProgressItem {
  role: string;
  status: 'approved' | 'rejected' | 'pending';
  by?: string;
}

export interface ApprovalProgress {
  approved: number;
  total: number;
  rejected: boolean;
  items: ApprovalProgressItem[];
}

/** Required roles with who approved (or rejected) as each. */
export function approvalProgress(
  required: readonly string[],
  approvals: readonly Approval[],
): ApprovalProgress {
  const items = required.map<ApprovalProgressItem>((role) => {
    const reject = approvals.find((a) => a.role === role && a.decision === 'reject');
    if (reject) return { role, status: 'rejected', by: reject.user_name };
    const approve = approvals.find((a) => a.role === role && a.decision === 'approve');
    return approve
      ? { role, status: 'approved', by: approve.user_name }
      : { role, status: 'pending' };
  });
  return {
    approved: items.filter((i) => i.status === 'approved').length,
    total: required.length,
    rejected: items.some((i) => i.status === 'rejected'),
    items,
  };
}

/** "1 of 2 approvals: Migration lead ✓, Customer data owner pending" */
export function approvalSummary(
  progress: ApprovalProgress,
  roleLabel: (key: string) => string,
): string {
  const parts = progress.items.map((i) => {
    const label = roleLabel(i.role);
    if (i.status === 'approved') return `${label} ✓`;
    if (i.status === 'rejected') return `${label} rejected`;
    return `${label} pending`;
  });
  return `${progress.approved} of ${progress.total} approvals: ${parts.join(', ')}`;
}

export const VERSION_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'info' },
  approved: { label: 'Approved', tone: 'success' },
  superseded: { label: 'Superseded', tone: 'neutral' },
  rejected: { label: 'Rejected', tone: 'danger' },
};

export function versionStatus(status: string): { label: string; tone: Tone } {
  return VERSION_STATUS[status] ?? { label: status, tone: 'neutral' };
}

// ---------- Validation paths → form fields ----------

/** DOM id for the form control that edits `path` (e.g. "source.adapter"). */
export function fieldId(path: string): string {
  return `bp-${path.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
}

/**
 * Candidate paths for focusing, most specific first:
 * "constraints.freeze_periods[0].end" → [that, "constraints.freeze_periods[0]",
 * "constraints.freeze_periods", "constraints"].
 */
export function pathCandidates(path: string): string[] {
  const out: string[] = [];
  let current = path;
  while (current) {
    out.push(current);
    const cut = Math.max(current.lastIndexOf('.'), current.lastIndexOf('['));
    if (cut <= 0) break;
    current = current.slice(0, cut);
  }
  return out;
}

/** Groups issues for display. */
export function groupIssues(validation: BlueprintValidation | undefined) {
  const issues = validation?.issues ?? [];
  return {
    blocking: issues.filter((i) => i.severity === 'blocking'),
    warnings: issues.filter((i) => i.severity !== 'blocking'),
  };
}

/** Short git sha for display. */
export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

/** Readable diff values. */
export function formatDiffValue(value: unknown): string {
  if (value === true) return 'included';
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** Approve (reason optional) or reject (reason of 10+ characters). */
export function decisionReasonError(approve: boolean, reason: string): string | undefined {
  const n = reason.trim().length;
  if (!approve && n < 10) return `Explain the rejection in at least 10 characters (${n} so far).`;
  return undefined;
}
