import type {
  ColumnProfile,
  ConfigItem,
  ConfigurationSection,
  CoverageReport,
  DiscoveryGap,
  DocumentRow,
} from '@/api/discovery-types';
import type { Tone } from '@/ui';

// ---------- Tabs ----------

export const RUN_TABS = [
  'summary',
  'graph',
  'profile',
  'usage',
  'rules',
  'interfaces',
  'configuration',
  'documents',
  'dictionary',
] as const;
export type RunTab = (typeof RUN_TABS)[number];

export const RUN_TAB_LABELS: Record<RunTab, string> = {
  summary: 'Summary',
  graph: 'Knowledge graph',
  profile: 'Data profile',
  usage: 'Usage',
  rules: 'Business rules',
  interfaces: 'Interfaces',
  configuration: 'Configuration',
  documents: 'Documents',
  dictionary: 'Dictionary',
};

// ---------- Runs and phases ----------

/** The pipeline's phases, in the order it runs them. */
export const PHASES = [
  'inventory',
  'dictionary',
  'profile',
  'usage',
  'code',
  'interfaces',
  'configuration',
  'documents',
] as const;

export const PHASE_LABELS: Record<string, string> = {
  inventory: 'Object inventory',
  dictionary: 'Data dictionary',
  profile: 'Data profile',
  usage: 'Usage',
  code: 'Code reading',
  interfaces: 'Interfaces',
  configuration: 'Configuration',
  documents: 'Documents',
};

export const PHASE_STATUS: Record<string, { label: string; tone: Tone }> = {
  done: { label: 'Done', tone: 'success' },
  partial: { label: 'Partial', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  skipped: { label: 'Skipped', tone: 'neutral' },
};

export function phaseStatus(status: string) {
  return PHASE_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
}

export const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  succeeded: { label: 'Succeeded', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  blocked: { label: 'Blocked', tone: 'warning' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export function runStatus(status: string) {
  return RUN_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
}

/** Phases in pipeline order, then any the API adds later. */
export function orderedPhases<T>(phases: Record<string, T>): [string, T][] {
  const known = PHASES.filter((p) => p in phases).map((p): [string, T] => [p, phases[p] as T]);
  const extra = Object.entries(phases).filter(([k]) => !(PHASES as readonly string[]).includes(k));
  return [...known, ...extra];
}

/** "evidence_days" → "Evidence days". */
export function humanize(key: string): string {
  const w = key.replace(/_/g, ' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** Readable scalar for count maps; structures as compact JSON. */
export function countText(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return v.toLocaleString();
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return JSON.stringify(v);
}

// ---------- Profile ----------

/** What each component of a table's quality score measures. */
export const WEIGHT_MEANING: Record<string, string> = {
  completeness: 'How filled the mostly-filled columns are (columns over half empty are left out).',
  validity:
    'How consistently values follow their column’s dominant shape, for columns with one dominant shape.',
  integrity: 'The share of rows without broken references to other tables.',
};

/** nulls / rows; null when the table has no rows. */
export function nullRate(c: Pick<ColumnProfile, 'nulls' | 'rows'>): number | null {
  return c.rows > 0 ? c.nulls / c.rows : null;
}

export function percent(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const p = v * 100;
  return `${p === 0 || p === 100 ? p.toFixed(0) : p.toFixed(digits)}%`;
}

export function scoreTone(score: number): Tone {
  if (score >= 90) return 'success';
  if (score >= 70) return 'warning';
  return 'danger';
}

// ---------- Sizes ----------

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? String(v) : v.toFixed(v >= 100 ? 0 : 1)} ${units[i] ?? 'B'}`;
}

export const MAX_ACTIVITY_BYTES = 25 * 1024 * 1024;

/** Client-side check before reading an activity file; the API checks again. */
export function activityFileError(file: { name: string; size: number }): string | null {
  if (!/\.(jsonl|ndjson|json|csv)$/i.test(file.name)) {
    return 'Choose a .jsonl or .csv file in the activity format.';
  }
  if (file.size > MAX_ACTIVITY_BYTES) {
    return 'Imports are limited to 25 MB per file; split larger logs.';
  }
  if (file.size === 0) return 'The file is empty.';
  return null;
}

// ---------- Documents ----------

export interface DocumentGroup {
  type: string;
  count: number;
  bytes: number;
  ages: { age: string; count: number; bytes: number; entities: DocumentRow[] }[];
}

const AGE_ORDER = ['under 1 year', '1-3 years', '3-7 years', 'over 7 years', 'unknown age'];

/** Rows grouped by document type (largest first), then by age bucket in age order. */
export function groupDocuments(rows: readonly DocumentRow[]): DocumentGroup[] {
  const byType = new Map<string, DocumentRow[]>();
  for (const r of rows) byType.set(r.type, [...(byType.get(r.type) ?? []), r]);
  const groups = [...byType.entries()].map(([type, list]): DocumentGroup => {
    const byAge = new Map<string, DocumentRow[]>();
    for (const r of list) byAge.set(r.age, [...(byAge.get(r.age) ?? []), r]);
    const ages = [...byAge.entries()]
      .map(([age, entities]) => ({
        age,
        count: entities.reduce((n, e) => n + e.count, 0),
        bytes: entities.reduce((n, e) => n + e.bytes, 0),
        entities,
      }))
      .sort((a, b) => ageRank(a.age) - ageRank(b.age));
    return {
      type,
      count: list.reduce((n, e) => n + e.count, 0),
      bytes: list.reduce((n, e) => n + e.bytes, 0),
      ages,
    };
  });
  return groups.sort((a, b) => b.bytes - a.bytes || a.type.localeCompare(b.type));
}

function ageRank(age: string): number {
  const i = AGE_ORDER.indexOf(age);
  return i === -1 ? AGE_ORDER.length : i;
}

// ---------- Configuration ----------

export interface ScopeDifference {
  kind: string;
  name: string;
  /** One entry per scope (book): its definition, or null when the item is missing there. */
  cells: { scope: string; definition: string | null; variant: number | null }[];
  /** How many distinct definitions there are. */
  variants: number;
}

/**
 * Builds a per-scope comparison for every item that differs between scopes or is missing in some.
 * Definitions come from the items; the variant number groups scopes with the same definition
 * (1 = the most common), so readers can see which books agree.
 */
export function scopeDifferences(section: ConfigurationSection): ScopeDifference[] {
  const { diff, items } = section;
  const scopes = diff.scopes;
  const find = (kind: string, name: string, scope: string): ConfigItem | undefined =>
    items.find((i) => i.kind === kind && i.name === name && i.scope === scope);
  const keys = new Map<string, { kind: string; name: string }>();
  for (const d of diff.different) keys.set(`${d.kind}\u0000${d.name}`, d);
  for (const d of diff.only_in_some) keys.set(`${d.kind}\u0000${d.name}`, d);
  return [...keys.values()]
    .map(({ kind, name }) => {
      const defs = scopes.map((scope) => ({
        scope,
        definition: find(kind, name, scope)?.definition ?? null,
      }));
      const counts = new Map<string, number>();
      for (const d of defs) {
        if (d.definition !== null) counts.set(d.definition, (counts.get(d.definition) ?? 0) + 1);
      }
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([def]) => def);
      return {
        kind,
        name,
        variants: ranked.length,
        cells: defs.map((d) => ({
          ...d,
          variant: d.definition === null ? null : ranked.indexOf(d.definition) + 1,
        })),
      };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

// ---------- Coverage ----------

export const STREAM_STATUS: Record<string, { label: string; tone: Tone }> = {
  covered: { label: 'Covered', tone: 'success' },
  partial: { label: 'Partial', tone: 'warning' },
  gap: { label: 'Gap', tone: 'danger' },
  not_started: { label: 'Not started', tone: 'neutral' },
};

export function streamStatus(status: string) {
  return STREAM_STATUS[status] ?? { label: humanize(status), tone: 'neutral' as Tone };
}

export const REPORT_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'info' },
  accepted: { label: 'Accepted', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  superseded: { label: 'Superseded', tone: 'neutral' },
};

export function reportStatus(status: string) {
  return REPORT_STATUS[status] ?? { label: humanize(status), tone: 'neutral' as Tone };
}

export type GapState = 'open-blocking' | 'waived' | 'warning';

export function gapState(report: Pick<CoverageReport, 'waivers'>, gap: DiscoveryGap): GapState {
  if (report.waivers.some((w) => w.gap_id === gap.id)) return 'waived';
  return gap.severity === 'blocking' ? 'open-blocking' : 'warning';
}

/** Open blocking gaps first, then warnings, then waived; stable by id. */
export function orderGaps(
  report: Pick<CoverageReport, 'waivers'>,
  gaps: readonly DiscoveryGap[],
): DiscoveryGap[] {
  const rank: Record<GapState, number> = { 'open-blocking': 0, warning: 1, waived: 2 };
  return [...gaps].sort(
    (a, b) => rank[gapState(report, a)] - rank[gapState(report, b)] || a.id.localeCompare(b.id),
  );
}

export const WAIVER_MIN = 15;
export const DECISION_MIN = 10;

export function lengthError(value: string, min: number, what: string): string | undefined {
  const n = value.trim().length;
  return n < min ? `${what} (at least ${min} characters, ${n} so far).` : undefined;
}

// ---------- Graph ----------

export const NODE_PAGE = 50;

/** Edges grouped by type, keeping API order inside each group. */
export function groupEdges<T extends { type: string }>(edges: readonly T[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const e of edges) m.set(e.type, [...(m.get(e.type) ?? []), e]);
  return [...m.entries()];
}

export const EDGE_LABELS: Record<string, { out: string; in: string }> = {
  has_column: { out: 'has column', in: 'column of' },
  references: { out: 'references', in: 'referenced by' },
  stored_in: { out: 'stored in', in: 'stores code list' },
  depends_on: { out: 'depends on', in: 'needed by' },
  defined_in: { out: 'defined in', in: 'defines rule' },
  reads: { out: 'reads', in: 'read by' },
  sets: { out: 'sets', in: 'set by' },
  writes: { out: 'writes', in: 'written by' },
  executes: { out: 'executes', in: 'executed by' },
  found_in: { out: 'found in', in: 'evidence for' },
};

export function edgeLabel(type: string, direction: 'out' | 'in'): string {
  return EDGE_LABELS[type]?.[direction] ?? (direction === 'out' ? type : `${type} (from)`);
}

/** Usage on a node: unused flag and readable counts. */
export function nodeUsage(usage: Record<string, unknown> | null): {
  unused: boolean;
  items: [string, string][];
} {
  if (!usage) return { unused: false, items: [] };
  const items = Object.entries(usage)
    .filter(([k, v]) => k !== 'unused' && v !== null && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]): [string, string] => [
      humanize(k),
      Array.isArray(v) ? v.map(String).join(', ') : countText(v),
    ]);
  return { unused: usage.unused === true, items };
}

export const INTERFACE_KIND: Record<string, string> = {
  program: 'Program',
  report_tool: 'Report tool',
  linked_server: 'Linked server',
  external_program: 'External program',
};

export const INTERFACE_SOURCE: Record<string, string> = {
  query_log: 'Query log',
  login_log: 'Login log',
  code: 'Code',
  configuration: 'Configuration',
  session: 'Session',
};
