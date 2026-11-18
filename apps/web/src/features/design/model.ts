import { isApiError } from '@/api/errors';
import {
  ACCESS_LEVELS,
  DESIGN_STREAMS,
  type AccessLevel,
  type DecisionOut,
  type DesignItemSummary,
  type DesignStatus,
  type DesignStream,
  type TestStep,
} from '@/api/design-types';
import type { FieldErrors } from '@/lib/forms';
import type { Tone } from '@/ui';

// ---------- Sections (URL state) ----------

export const DESIGN_SECTIONS = ['overview', ...DESIGN_STREAMS, 'build'] as const;
export type DesignSection = (typeof DESIGN_SECTIONS)[number];

export function isDesignSection(v: unknown): v is DesignSection {
  return typeof v === 'string' && (DESIGN_SECTIONS as readonly string[]).includes(v);
}

export function isDesignStream(v: unknown): v is DesignStream {
  return typeof v === 'string' && (DESIGN_STREAMS as readonly string[]).includes(v);
}

/** The Design tab's view in the URL: section, the selected item or artifact. */
export interface DesignSearch {
  section?: DesignSection;
  key?: string;
  artifact?: string;
}

export const STREAM_INFO: Record<DesignStream, { label: string; owner: string; about: string }> = {
  mapping: {
    label: 'Mappings',
    owner: 'Data SME',
    about:
      'Every in-scope source column with a proposed target column, the evidence for it and a confidence score. Items below the review threshold, and columns with no target, are decided in the review queue.',
  },
  configuration: {
    label: 'Configuration',
    owner: 'Solution architect',
    about:
      'Each source configuration item with the target area and method it is rebuilt with. Items the target retires are proposed for retirement with a replacement and decided in the review queue.',
  },
  form: {
    label: 'Forms',
    owner: 'Solution architect',
    about:
      'Form designs in the target’s format. A form is approved only after its converted PDF passes parity against the approved golden copy.',
  },
  code: {
    label: 'Customer code',
    owner: 'Solution architect',
    about:
      'User-defined tables and converted procedures, functions and triggers, named by the target’s rules. A user-defined table needs its key declared because the source does not report keys.',
  },
  integration: {
    label: 'Integrations',
    owner: 'Solution architect',
    about:
      'Each interface found in discovery on an approved target mechanism, with the tables it touches. A non-retired interface is approved only once it has an end-to-end test. Desktop-only links are replaced or retired in the review queue.',
  },
  report: {
    label: 'Reports',
    owner: 'Solution architect',
    about:
      'Views rebuilt as read-only procedures on the target’s report access mechanism, with tables and columns renamed to their mapped targets.',
  },
  page: {
    label: 'Pages',
    owner: 'Solution architect',
    about:
      'Page drafts for each source entity, built from its mappings. No adapter supplies legacy screen layouts yet, so fields follow the source column order. A designer approves each draft.',
  },
  security: {
    label: 'Security',
    owner: 'Customer IT security lead',
    about:
      'Each source security profile lists every new page and report. A profile is approved only when every object has an explicit access decision (none counts).',
  },
};

export const SECTION_LABELS: Record<DesignSection, string> = {
  overview: 'Overview',
  ...Object.fromEntries(DESIGN_STREAMS.map((s) => [s, STREAM_INFO[s].label])),
  build: 'Build',
} as Record<DesignSection, string>;

// ---------- Labels ----------

export const DESIGN_STATUS: Record<DesignStatus, { label: string; tone: Tone }> = {
  proposed: { label: 'Proposed', tone: 'info' },
  in_review: { label: 'In review', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  blocked: { label: 'Blocked', tone: 'neutral' },
};

export function designStatus(s: string) {
  return (
    (DESIGN_STATUS as Record<string, { label: string; tone: Tone } | undefined>)[s] ?? {
      label: s,
      tone: 'neutral' as Tone,
    }
  );
}

export const ARTIFACT_STATUS: Record<string, { label: string; tone: Tone }> = {
  generated: { label: 'Generated, not tested', tone: 'neutral' },
  tests_failed: { label: 'Tests failed', tone: 'danger' },
  tests_passed: { label: 'Tests passed', tone: 'info' },
  approved: { label: 'Approved', tone: 'success' },
  superseded: { label: 'Superseded', tone: 'neutral' },
};

export function artifactStatus(s: string) {
  return ARTIFACT_STATUS[s] ?? { label: s.replace(/_/g, ' '), tone: 'neutral' as Tone };
}

export const ARTIFACT_KIND: Record<string, string> = {
  transformation: 'Transformation',
  code_object: 'Customer code or report',
};

export const ACCESS_LABELS: Record<AccessLevel, string> = {
  none: 'None',
  view: 'View',
  edit: 'Edit',
  full: 'Full',
};

export const MECHANISM_KIND: Record<string, string> = {
  rest_api: 'REST API',
  read_query: 'Read query',
  webhook: 'Webhook',
  integration_vendor: 'Integration vendor',
  file_exchange: 'File exchange',
};

export const METHOD_LABELS: Record<string, string> = {
  api: 'Through the configuration API',
  import_file: 'By import file',
  manual: 'By hand, from this specification',
};

export const CONFIDENCE_TONE: Record<string, Tone> = {
  confirmed: 'success',
  reported: 'info',
  assumed: 'warning',
};

/** "0.82" → "0.82 (82%)". */
export function confidenceText(c: number | null | undefined): string {
  if (c === null || c === undefined) return 'Not scored';
  return `${c.toFixed(2)} (${String(Math.round(c * 100))}%)`;
}

// ---------- Reading items ----------

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function str(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

export function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => str(x)).filter((x): x is string => x !== null) : [];
}

/** source.table.column, or null when the target has none. */
export function mappingTargetText(target: unknown): string | null {
  const t = rec(target);
  const table = str(t.table);
  const column = str(t.column);
  return table && column ? `${table}.${column}` : null;
}

/** A short, readable name for an item, from its source. */
export function itemTitle(item: Pick<DesignItemSummary, 'stream' | 'key' | 'source'>): string {
  const s = rec(item.source);
  switch (item.stream) {
    case 'mapping':
      return str(s.table) && str(s.column) ? `${str(s.table)}.${str(s.column)}` : item.key;
    case 'configuration':
      return str(s.kind) && str(s.name) ? `${str(s.kind)}: ${str(s.name)}` : item.key;
    case 'form':
    case 'code':
    case 'integration':
    case 'report':
      return str(s.name) ?? item.key;
    case 'page':
      return str(s.entity) ?? item.key;
    case 'security':
      return str(s.profile) ?? item.key;
    default:
      return item.key;
  }
}

/** One line under the title: what it becomes in the target. */
export function itemSubtitle(item: DesignItemSummary): string | null {
  const t = rec(item.target);
  const s = rec(item.source);
  if (item.target && t.retire === true) return `Retire: ${str(t.replacement) ?? ''}`;
  switch (item.stream) {
    case 'mapping':
      return item.target ? `→ ${mappingTargetText(item.target) ?? '?'}` : 'No target proposed';
    case 'configuration':
      return item.target ? `→ ${str(t.label) ?? str(t.area) ?? ''} (${str(t.method) ?? ''})` : null;
    case 'form':
      return item.target
        ? `${str(t.conversion) === 'carry_over' ? 'Carried over' : 'Converted'} to ${(str(t.format) ?? '').toUpperCase()}`
        : null;
    case 'code':
    case 'report':
      return str(t.qualified) ? `→ ${str(t.qualified)}` : null;
    case 'integration':
      return item.target
        ? `${str(s.direction) ?? ''} on ${str(t.label) ?? str(t.mechanism) ?? ''}`
        : null;
    case 'page':
      return str(t.title) ? `Page “${str(t.title)}”` : null;
    case 'security':
      return item.missing && item.missing.length > 0
        ? `${String(item.missing.length)} object(s) without an access decision`
        : 'Every object has an access decision';
    default:
      return null;
  }
}

/** Can this item be picked for a bulk decision here? */
export function decidableHere(item: Pick<DesignItemSummary, 'status'>): boolean {
  return item.status === 'proposed';
}

/** Why an item cannot be decided in this tab, in words (list rows and disabled selection). */
export function notDecidableReason(item: Pick<DesignItemSummary, 'status'>): string | null {
  switch (item.status) {
    case 'in_review':
      return 'In the review queue: decide it there.';
    case 'blocked':
      return 'Blocked: it cannot be approved.';
    case 'approved':
      return 'Already approved.';
    case 'rejected':
      return 'Already rejected.';
    default:
      return null;
  }
}

/** Pretty JSON for definitions; plain text stays as it is. */
export function pretty(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 2);
}

// ---------- Decisions ----------

export const TARGET_PATTERN = /^\s*\[?[^.\s[\]]+\]?(\s*\.\s*\[?[^.\s[\]]+\]?){1,2}\s*$/;

/** Client-side shape check of a changed mapping target; the API checks it exists. */
export function targetError(value: string): string | undefined {
  if (!value.trim()) return 'Give the target column as schema.table.column.';
  if (!TARGET_PATTERN.test(value)) return 'Use schema.table.column (or table.column for dbo).';
  return undefined;
}

export interface DecisionLine {
  tone: 'success' | 'info' | 'warning';
  text: string;
}

/** What the API recorded, in words, one line per outcome. */
export function decisionLines(
  out: DecisionOut,
  action: 'approve' | 'reject' | 'change',
): DecisionLine[] {
  const lines: DecisionLine[] = [];
  const verb =
    action === 'reject' ? 'rejected' : action === 'change' ? 'changed and approved' : 'approved';
  if (out.decided.length) {
    lines.push({ tone: 'success', text: `${String(out.decided.length)} item(s) ${verb}.` });
  }
  if (out.awaiting_second_approval.length) {
    lines.push({
      tone: 'info',
      text: `${String(out.awaiting_second_approval.length)} item(s) need a second approval: your approval is recorded (1 of ${String(out.required_approvals)}); a different person must approve before the item is approved.`,
    });
  }
  if (out.refused.length) {
    lines.push({
      tone: 'warning',
      text: `${String(out.refused.length)} item(s) were refused and not changed.`,
    });
  }
  if (lines.length === 0) lines.push({ tone: 'info', text: 'Nothing was changed.' });
  return lines;
}

// ---------- Forms ----------

export const MAX_PDF_BYTES = 20 * 1024 * 1024;

/** Checks a chosen file before it is read: a PDF of at most 20 MB. */
export function pdfFileError(file: Pick<File, 'name' | 'size' | 'type'>): string | undefined {
  const looksPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!looksPdf) return 'Choose a PDF file.';
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_PDF_BYTES) {
    return `The file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 20 MB.`;
  }
  return undefined;
}

/** A PDF starts with "%PDF-". */
export function hasPdfHeader(bytes: Uint8Array): boolean {
  const head = [0x25, 0x50, 0x44, 0x46, 0x2d];
  return head.every((b, i) => bytes[i] === b);
}

// ---------- Integration test steps ----------

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethodName = (typeof HTTP_METHODS)[number];

export interface StepForm {
  name: string;
  method: HttpMethodName;
  path: string;
  body: string;
  expect_status: string;
  expect_keys: string;
}

export type StepField = 'name' | 'method' | 'path' | 'body' | 'expect_status' | 'expect_keys';

export const EMPTY_STEP: StepForm = {
  name: '',
  method: 'GET',
  path: '/',
  body: '',
  expect_status: '200',
  expect_keys: '',
};

const TESTABLE = /^\/[A-Za-z0-9_\-/{}.?=&%]*$/;

export function stepFormsOf(steps: TestStep[] | undefined): StepForm[] {
  return (steps ?? []).map((st) => ({
    name: st.name,
    method: st.method,
    path: st.path,
    body: st.body === null || st.body === undefined ? '' : JSON.stringify(st.body, null, 2),
    expect_status: String(st.expect_status),
    expect_keys: st.expect_keys.join(', '),
  }));
}

/** Mirrors the API's rules; returns the steps to send only when every row is valid. */
export function validateSteps(forms: StepForm[]): {
  errors: FieldErrors<StepField>[];
  form: string | undefined;
  steps: TestStep[] | null;
} {
  const errors: FieldErrors<StepField>[] = [];
  const steps: TestStep[] = [];
  let form: string | undefined;
  if (forms.length === 0) form = 'Add at least one step.';
  if (forms.length > 20) form = 'A test has at most 20 steps.';
  forms.forEach((f, i) => {
    const e: FieldErrors<StepField> = {};
    const name = f.name.trim();
    if (name.length < 3) e.name = 'Name the step (at least 3 characters).';
    else if (name.length > 200) e.name = 'Use at most 200 characters.';
    const path = f.path.trim();
    if (!TESTABLE.test(path) || path.length > 500) {
      e.path = 'A path starts with / and holds no host (letters, digits, _ - / { } . ? = & %).';
    }
    let body: unknown = null;
    if (f.body.trim()) {
      try {
        body = JSON.parse(f.body) as unknown;
      } catch {
        e.body = 'The body is not valid JSON.';
      }
    }
    const status = Number(f.expect_status);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      e.expect_status = 'Give an HTTP status from 100 to 599.';
    }
    const keys = f.expect_keys
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    if (keys.length > 50) e.expect_keys = 'List at most 50 keys.';
    errors[i] = e;
    steps.push({ name, method: f.method, path, body, expect_status: status, expect_keys: keys });
  });
  const ok = !form && errors.every((e) => Object.keys(e).length === 0);
  return { errors, form, steps: ok ? steps : null };
}

/** The API's `steps.{n}.{field}` messages, per step row. */
export function stepErrorsFromApi(error: unknown): FieldErrors<StepField>[] {
  const out: FieldErrors<StepField>[] = [];
  if (!isApiError(error)) return out;
  for (const fe of error.fieldErrorList) {
    const m = /^steps\.(\d+)\.(\w+)/.exec(fe.field);
    if (!m) continue;
    const i = Number(m[1]);
    const field = m[2] as StepField;
    out[i] = { ...out[i], [field]: out[i]?.[field] ?? fe.message };
  }
  return out;
}

// ---------- Security ----------

/** Sets every listed object to one access level. */
export function bulkSet(
  entries: Record<string, AccessLevel | null>,
  objects: readonly string[],
  access: AccessLevel,
): Record<string, AccessLevel | null> {
  const next = { ...entries };
  for (const o of objects) if (o in next) next[o] = access;
  return next;
}

/** Objects still without an access decision. */
export function missingOf(entries: Record<string, AccessLevel | null>): string[] {
  return Object.entries(entries)
    .filter(([, a]) => a === null || !(ACCESS_LEVELS as readonly string[]).includes(a))
    .map(([o]) => o);
}

/** Only the entries changed from what is saved. */
export function changedEntries(
  saved: Record<string, AccessLevel | null>,
  current: Record<string, AccessLevel | null>,
): Record<string, AccessLevel> {
  const out: Record<string, AccessLevel> = {};
  for (const [o, a] of Object.entries(current)) {
    if (a !== null && saved[o] !== a) out[o] = a;
  }
  return out;
}

/** "page:Policy holder" → { kind: 'Page', name: 'Policy holder' }. */
export function objectParts(obj: string): { kind: string; name: string } {
  const i = obj.indexOf(':');
  if (i < 0) return { kind: 'Object', name: obj };
  const kind = obj.slice(0, i);
  return { kind: kind.charAt(0).toUpperCase() + kind.slice(1), name: obj.slice(i + 1) };
}
