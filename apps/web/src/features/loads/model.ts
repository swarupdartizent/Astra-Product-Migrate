import type {
  BreakStatus,
  DocumentStatus,
  FailedStatus,
  LoadKind,
  LoadRun,
  ParityCaseStatus,
  ParityFieldType,
  ParityKind,
  ParitySpec,
  StartKind,
  TriageState,
} from '@/api/loads-types';
import { ACCEPTED_STATUSES, FAILED_STATUSES } from '@/api/loads-types';
import type { Tone } from '@/ui';

// ---------- Sections and URL state ----------

export const LOADS_SECTIONS = [
  'runs',
  'errors',
  'documents',
  'breaks',
  'parity',
  'coexistence',
] as const;
export type LoadsSection = (typeof LOADS_SECTIONS)[number];

export function isLoadsSection(v: unknown): v is LoadsSection {
  return typeof v === 'string' && (LOADS_SECTIONS as readonly string[]).includes(v);
}

export const LOADS_SECTION_LABELS: Record<LoadsSection, string> = {
  runs: 'Load runs',
  errors: 'Error queue',
  documents: 'Documents',
  breaks: 'Reconciliation breaks',
  parity: 'Parity',
  coexistence: 'Coexistence',
};

/** The Loads tab's view in the URL: section, the load run, and the parity run. */
export interface LoadsSearch {
  section?: LoadsSection;
  /** Load run id (runs, errors, documents, breaks). */
  run?: string;
  /** Parity run id (parity). */
  parity_run?: string;
}

// ---------- Labels ----------

export const KIND_LABELS: Record<LoadKind, string> = {
  rehearsal: 'Rehearsal',
  load: 'Load',
  delta: 'Delta load',
  reload: 'Reload',
};

export const KIND_HELP: Record<StartKind, string> = {
  rehearsal:
    'Transforms, validates and reconciles every record, and sends nothing. No target connection.',
  load: 'Sends the records that pass validation to the target. Records whose payload was loaded before unchanged are skipped.',
  delta: 'Like a load, from a delta extract: only rows changed since the previous extract.',
};

export function kindLabel(kind: string): string {
  return (KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  succeeded: { label: 'Succeeded', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  blocked: { label: 'Blocked', tone: 'warning' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export function runStatus(status: string): { label: string; tone: Tone } {
  return RUN_STATUS[status] ?? { label: status, tone: 'neutral' };
}

export function isRunActive(status: string): boolean {
  return status === 'queued' || status === 'running';
}

export const RECORD_STATUS: Record<string, { label: string; tone: Tone }> = {
  loaded: { label: 'Loaded', tone: 'success' },
  unchanged: { label: 'Unchanged', tone: 'success' },
  rehearsed: { label: 'Would load', tone: 'success' },
  rejected: { label: 'Rejected by target', tone: 'danger' },
  invalid: { label: 'Invalid', tone: 'danger' },
  blocked: { label: 'Blocked', tone: 'warning' },
};

export function recordStatus(status: string): { label: string; tone: Tone } {
  return RECORD_STATUS[status] ?? { label: status, tone: 'neutral' };
}

export const FAILED_LABELS: Record<FailedStatus, string> = {
  rejected: 'Rejected',
  invalid: 'Invalid',
  blocked: 'Blocked',
};

export const TRIAGE_LABELS: Record<TriageState, string> = {
  open: 'Open',
  fixed: 'Fixed',
  wont_fix: 'Will not fix',
  reloaded: 'Reloaded',
};

export function triageLabel(t: string): string {
  return (TRIAGE_LABELS as Record<string, string>)[t] ?? t;
}

export const DOC_STATUS: Record<DocumentStatus, { label: string; tone: Tone }> = {
  linked: { label: 'Linked', tone: 'success' },
  broken: { label: 'Broken link', tone: 'danger' },
  match: { label: 'Matches source', tone: 'success' },
  mismatch: { label: 'Bytes differ', tone: 'danger' },
  missing: { label: 'Missing in target', tone: 'danger' },
  blocked: { label: 'Blocked', tone: 'warning' },
};

export function docStatus(s: string): { label: string; tone: Tone } {
  return (
    (DOC_STATUS as Record<string, { label: string; tone: Tone }>)[s] ?? {
      label: s,
      tone: 'neutral',
    }
  );
}

export const BREAK_STATUS: Record<BreakStatus, { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'warning' },
  closed: { label: 'Closed', tone: 'success' },
};

export const PARITY_KIND_LABELS: Record<ParityKind, string> = {
  rating: 'Re-rated policies',
  report: 'Report outputs',
  workflow: 'Workflow replay',
  period_close: 'Closed accounting period',
};

export const PARITY_KIND_HELP: Record<ParityKind, string> = {
  rating: 'Premium or rated amounts per policy; money totals must match to the cent.',
  report: 'Report columns per row; money totals must match to the cent.',
  workflow: 'Tasks, routing and outcome per replayed case.',
  period_close: 'Ledger, receivables, payables and commissions; totals must match to the cent.',
};

export const FIELD_TYPE_LABELS: Record<ParityFieldType, string> = {
  money: 'Money (to the cent)',
  number: 'Number (exact)',
  text: 'Text (trimmed)',
};

export const CASE_STATUS: Record<ParityCaseStatus, { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  fixed: { label: 'Fixed', tone: 'info' },
};

export function caseStatus(s: string): { label: string; tone: Tone } {
  return (
    (CASE_STATUS as Record<string, { label: string; tone: Tone }>)[s] ?? {
      label: s,
      tone: 'neutral',
    }
  );
}

export const CASE_KIND_LABELS: Record<string, string> = {
  difference: 'Difference',
  missing_in_target: 'Missing in target',
  missing_in_source: 'Missing in source',
};

// ---------- Counts ----------

export function sumStatuses(
  counts: Record<string, number> | undefined,
  statuses: readonly string[],
): number {
  if (!counts) return 0;
  return statuses.reduce((n, st) => n + (counts[st] ?? 0), 0);
}

export function acceptedOf(counts: Record<string, number> | undefined): number {
  return sumStatuses(counts, ACCEPTED_STATUSES);
}

export function failedOf(counts: Record<string, number> | undefined): number {
  return sumStatuses(counts, FAILED_STATUSES);
}

/** "Run 3 (rehearsal, succeeded)" for pickers. */
export function runLabel(r: Pick<LoadRun, 'number' | 'kind' | 'status'>): string {
  return `Run ${String(r.number)} (${kindLabel(r.kind).toLowerCase()}, ${runStatus(r.status).label.toLowerCase()})`;
}

/** Why records of this run cannot be reloaded, or null when they can. */
export function reloadBlockedReason(
  run: Pick<LoadRun, 'kind' | 'target_connection_id' | 'status'> & { can_load: boolean },
  canManage: boolean,
): string | null {
  if (run.kind === 'rehearsal' || run.target_connection_id === null) {
    return 'A rehearsal sends nothing, so there is nothing to reload: start a load instead.';
  }
  if (!run.can_load) return 'Reloading needs permission to load into this tenant’s target.';
  if (!canManage) return 'Reloading needs stage management on this project.';
  if (isRunActive(run.status)) return 'The run is still in progress.';
  return null;
}

// ---------- Exact decimals (amounts are compared to the cent) ----------

const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

function parseDecimal(v: string): { n: bigint; scale: number } | null {
  const m = DECIMAL.exec(v.trim());
  if (!m) return null;
  const frac = m[3] ?? '';
  const n = BigInt(`${m[2] ?? '0'}${frac}`);
  return { n: m[1] ? -n : n, scale: frac.length };
}

function scaled(d: { n: bigint; scale: number }, scale: number): bigint {
  return d.n * 10n ** BigInt(scale - d.scale);
}

function render(n: bigint, scale: number): string {
  const neg = n < 0n;
  const abs = (neg ? -n : n).toString().padStart(scale + 1, '0');
  const int = scale ? abs.slice(0, abs.length - scale) : abs;
  const frac = scale ? abs.slice(abs.length - scale) : '';
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/** b − a as an exact decimal string, or null when either is not a decimal. */
export function decimalDiff(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  if (!x || !y) return null;
  const scale = Math.max(x.scale, y.scale);
  return render(scaled(y, scale) - scaled(x, scale), scale);
}

/** True when the decimal string is zero (any scale). */
export function isZero(v: string | null): boolean {
  if (v === null) return true;
  const d = parseDecimal(v);
  return d !== null && d.n === 0n;
}

/** Thousands separators and at least two decimals; never rounds (amounts are exact). */
export function formatAmount(v: string | null): string {
  if (v === null) return '—';
  const d = parseDecimal(v);
  if (!d) return v;
  const scale = Math.max(2, d.scale);
  const text = render(scaled(d, scale), scale);
  const [int = '0', frac = ''] = text.replace('-', '').split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${text.startsWith('-') ? '−' : ''}${grouped}.${frac}`;
}

/** A difference with an explicit sign: +1,234.50 or −0.01, or "0.00". */
export function formatDifference(v: string | null): string {
  if (v === null) return '—';
  if (isZero(v)) return formatAmount('0');
  const f = formatAmount(v);
  return f.startsWith('−') ? f : `+${f}`;
}

export function formatPercent(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${v.toFixed(1)}%`;
}

// ---------- Start a load run ----------

export interface StartForm {
  kind: StartKind | '';
  connection: string;
  extract: string;
  target: string;
  segmentColumn: string;
  segmentValues: string;
}

export type StartField = 'kind' | 'connection' | 'extract' | 'target' | 'column' | 'values';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Segment values: one per line or comma separated, trimmed, distinct. */
export function splitValues(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}

/** Client checks mirroring the API (LoadIn and Segment in api/routes/loads.py). */
export function startErrors(f: StartForm): Partial<Record<StartField, string>> {
  const e: Partial<Record<StartField, string>> = {};
  if (!f.kind) e.kind = 'Choose what kind of run to start.';
  if (!f.connection) e.connection = 'Choose the source connection the extract came from.';
  if (!f.extract) e.extract = 'Choose a successful extract run.';
  if ((f.kind === 'load' || f.kind === 'delta') && !f.target) {
    e.target = 'A load sends records to the target: choose a target connection.';
  }
  const col = f.segmentColumn.trim();
  const values = splitValues(f.segmentValues);
  if (col && !IDENT.test(col)) {
    e.column = 'Use a column name: letters, digits and underscores, not starting with a digit.';
  }
  if (col && values.length === 0)
    e.values = 'Give at least one value to load, or clear the column.';
  if (!col && values.length > 0) e.column = 'Name the column the values are in.';
  if (values.length > 100) e.values = `At most 100 values (${String(values.length)} given).`;
  return e;
}

// ---------- Fixed payload ----------

/**
 * Parses an edited payload and checks it keeps exactly the original record's columns. Returns
 * the payload, or an error that names the columns added or removed.
 */
export function checkFixedPayload(
  text: string,
  original: Record<string, unknown>,
): { value: Record<string, unknown> } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { error: `Not valid JSON: ${e instanceof Error ? e.message : 'parse error'}.` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'The fixed record must be a JSON object of column: value.' };
  }
  const value = parsed as Record<string, unknown>;
  const was = new Set(Object.keys(original));
  const now = new Set(Object.keys(value));
  const added = [...now].filter((k) => !was.has(k));
  const removed = [...was].filter((k) => !now.has(k));
  if (added.length || removed.length) {
    const parts = [
      added.length ? `not in the original: ${added.join(', ')}` : null,
      removed.length ? `missing: ${removed.join(', ')}` : null,
    ].filter(Boolean);
    return {
      error: `A fixed record keeps the same columns as the original (${parts.join('; ')}).`,
    };
  }
  return { value };
}

// ---------- Parity ----------

export const MAX_PARITY_BYTES = 40 * 1024 * 1024;

/** Client checks for a parity result file: CSV or JSON, not empty, within the size limit. */
export function parityFileError(file: Pick<File, 'name' | 'size'>): string | undefined {
  if (!/\.(csv|json)$/i.test(file.name)) return 'Choose a .csv or .json file.';
  if (file.name.length < 5 || file.name.length > 200) {
    return 'The file name must be 5 to 200 characters long.';
  }
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_PARITY_BYTES) {
    return `The file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 40 MB.`;
  }
  return undefined;
}

export interface FieldRow {
  name: string;
  type: ParityFieldType;
  target_name: string;
}

export interface ParityForm {
  kind: ParityKind | '';
  name: string;
  keys: string;
  inputs: string;
  fields: FieldRow[];
}

export type ParityFormField = 'kind' | 'name' | 'keys' | 'inputs' | 'fields' | 'source' | 'target';

export function splitNames(text: string): string[] {
  return text
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Client checks mirroring parity.Spec and ParityIn; per-row field errors by index. */
export function parityErrors(f: ParityForm): {
  form: Partial<Record<ParityFormField, string>>;
  rows: Record<number, string>;
} {
  const form: Partial<Record<ParityFormField, string>> = {};
  const rows: Record<number, string> = {};
  if (!f.kind) form.kind = 'Choose what the files contain.';
  const name = f.name.trim();
  if (name.length < 3) form.name = 'Name the comparison (at least 3 characters).';
  else if (name.length > 200) form.name = 'At most 200 characters.';
  const keys = splitNames(f.keys);
  if (keys.length === 0) form.keys = 'Name at least one key field that identifies each case.';
  else if (keys.length > 10) form.keys = `At most 10 key fields (${String(keys.length)} given).`;
  else if (new Set(keys).size !== keys.length) form.keys = 'Each key field once.';
  const inputs = splitNames(f.inputs);
  if (inputs.length > 50) form.inputs = `At most 50 input fields (${String(inputs.length)} given).`;
  if (f.fields.length === 0) form.fields = 'Add at least one field to compare.';
  if (f.fields.length > 100) form.fields = 'At most 100 compared fields.';
  const seen = new Set<string>();
  f.fields.forEach((r, i) => {
    const n = r.name.trim();
    if (!n) rows[i] = 'Name the field.';
    else if (n.length > 200) rows[i] = 'At most 200 characters.';
    else if (keys.includes(n)) rows[i] = `${n} is a key field; compared fields are not keys.`;
    else if (seen.has(n)) rows[i] = `${n} is compared twice.`;
    else if (r.target_name.trim().length > 200) rows[i] = 'Target name: at most 200 characters.';
    seen.add(n);
  });
  return { form, rows };
}

export function specOf(f: ParityForm): ParitySpec {
  return {
    keys: splitNames(f.keys),
    inputs: splitNames(f.inputs),
    fields: f.fields.map((r) => ({
      name: r.name.trim(),
      type: r.type,
      ...(r.target_name.trim() ? { target_name: r.target_name.trim() } : {}),
    })),
  };
}

/** Identity of a parity case or load record inside a selection set. */
export function pairKey(a: string, b: string): string {
  return `${a}\u0000${b}`;
}

export function valueText(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: string): boolean {
  return UUID.test(v.trim());
}
