import { parse as parseYaml } from 'yaml';
import type {
  AdapterRun,
  ConnectionCheck,
  CoverageRow,
  ExtractCount,
  ExtractedDocument,
  TargetLoadConfig,
} from '@/api/types';
import type { Tone } from '@/ui';

export const ADAPTERS_TABS = ['adapters', 'contract'] as const;
export type AdaptersTab = (typeof ADAPTERS_TABS)[number];

export const ADAPTER_DETAIL_TABS = ['overview', 'traps', 'constraints'] as const;
export type AdapterDetailTab = (typeof ADAPTER_DETAIL_TABS)[number];

export const UNVALIDATED_TEXT = 'Not yet proven on a real estate or target.';

export const SEVERITY_TONE: Record<string, Tone> = {
  high: 'danger',
  medium: 'warning',
  low: 'info',
};

export const CONFIDENCE: Record<string, { label: string; tone: Tone; meaning: string }> = {
  confirmed: {
    label: 'Confirmed',
    tone: 'success',
    meaning: 'Confirmed by the vendor or a source document.',
  },
  reported: {
    label: 'Reported',
    tone: 'info',
    meaning: 'Reported by people who have worked with the product.',
  },
  assumed: { label: 'Assumed', tone: 'warning', meaning: 'Assumed until someone confirms it.' },
};

export function confidence(c: string) {
  return CONFIDENCE[c] ?? { label: c, tone: 'neutral' as Tone, meaning: '' };
}

/** Why loads cannot run for this target adapter, or null when the load config is complete. */
export function loadBlockedReason(load: TargetLoadConfig): string | null {
  if (load.endpoints.length === 0 || load.token_path === null) {
    return "Loads are Blocked: the target's API endpoints are not yet recorded.";
  }
  return null;
}

export const RUN_KIND_LABELS: Record<string, string> = {
  check: 'Connection check',
  harvest: 'Metadata and traps',
  extract: 'Extract',
};

export const ADAPTER_RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  succeeded: { label: 'Succeeded', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  blocked: { label: 'Blocked', tone: 'warning' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export function adapterRunStatus(status: string) {
  return ADAPTER_RUN_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
}

export const WRITABLE_ACCOUNT =
  'This account can write to the source. Adapters only run with read-only accounts.';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Reads a check run's summary (ConnectionCheck) defensively; null when it has none. */
export function checkSummary(run: Pick<AdapterRun, 'kind' | 'summary'>): ConnectionCheck | null {
  const s = run.summary;
  if (run.kind !== 'check' || typeof s.read_only !== 'boolean') return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    ok: s.ok === true,
    engine: str(s.engine) ?? '',
    engine_version: str(s.engine_version),
    edition: str(s.edition),
    database: str(s.database),
    login: str(s.login),
    read_only: s.read_only,
    read_only_evidence: list(s.read_only_evidence),
    supported: s.supported !== false,
    problems: list(s.problems),
  };
}

/** objects_by_type from a harvest summary. */
export function objectsByType(summary: Record<string, unknown>): [string, number][] {
  const v = summary.objects_by_type;
  if (!isRecord(v)) return [];
  return Object.entries(v)
    .map(([k, n]): [string, number] => [k, typeof n === 'number' ? n : 0])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

export function coverageTone(row: CoverageRow): Tone {
  if (row.status === 'failed') return 'danger';
  if ((row.code_missing ?? 0) > 0) return 'warning';
  if (row.status === 'complete' || row.status === 'ok' || row.status === 'read') return 'success';
  return 'neutral';
}

export function countsMismatch(c: ExtractCount): boolean {
  return c.source_count !== null && c.source_count !== c.extracted;
}

/** Broken document links first, then by key. */
export function orderDocuments(docs: readonly ExtractedDocument[]): ExtractedDocument[] {
  return [...docs].sort((a, b) =>
    a.link_resolved === b.link_resolved
      ? a.doc_key.localeCompare(b.doc_key)
      : a.link_resolved
        ? 1
        : -1,
  );
}

/** "Blocked: ..." job errors are missing inputs, not failures. */
export function isBlockedMessage(message: string | null | undefined): boolean {
  return typeof message === 'string' && /^blocked:/i.test(message.trim());
}

/**
 * Parses a trap (or other) definition typed as YAML or JSON. YAML is a superset of JSON, so one
 * parser handles both. Returns the mapping or a readable error with the line.
 */
export function parseDefinition(
  text: string,
): { value: Record<string, unknown> } | { error: string } {
  if (!text.trim()) return { error: 'Write the definition as YAML or JSON.' };
  try {
    const value: unknown = parseYaml(text);
    if (!isRecord(value)) return { error: 'The definition must be a mapping (key: value pairs).' };
    return { value };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Not valid YAML or JSON: ${msg.split('\n')[0] ?? msg}` };
  }
}

/** Relative paths such as "trap.detect.queries.sqlserver" → "detect › queries › sqlserver". */
export function trapFieldLabel(field: string): string {
  return (
    field
      .replace(/^trap\.?/, '')
      .split('.')
      .filter(Boolean)
      .join(' › ') || 'trap'
  );
}

export const TRAP_TEMPLATE = `id: CUSTOM-EXAMPLE-1
title: Short title of the problem
description: What goes wrong in a migration when this is present.
severity: medium
stream: data
advice: What the team should do about it.
detect:
  kind: object_exists
  object_type: table
  name_pattern: "^tmp_"
sources:
  - reference: Where this knowledge comes from
`;
