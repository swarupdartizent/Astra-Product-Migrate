import type {
  CoexistenceIn,
  CutoverOption,
  Disposition,
  GapRoute,
  WaveIn,
} from '@/api/planning-types';
import type { FieldErrors } from '@/lib/forms';
import type { Tone } from '@/ui';

// ---------- Sections ----------

export const PLAN_SECTIONS = [
  'overview',
  'workbench',
  'scope',
  'dependencies',
  'tasks',
  'controls',
  'waves',
  'risks',
  'cutover',
  'baselines',
  'gaps',
] as const;
export type PlanSection = (typeof PLAN_SECTIONS)[number];

export const SECTION_LABELS: Record<PlanSection, string> = {
  overview: 'Overview',
  workbench: 'Workbench',
  scope: 'Scope',
  dependencies: 'Dependencies',
  tasks: 'Tasks and estimates',
  controls: 'Controls',
  waves: 'Waves',
  risks: 'Risks',
  cutover: 'Cutover',
  baselines: 'Baselines and exports',
  gaps: 'Gaps',
};

// ---------- Labels ----------

export const DISPOSITION_INFO: Record<Disposition, { label: string; tone: Tone; meaning: string }> =
  {
    migrate: { label: 'Migrate', tone: 'info', meaning: 'Move it to the target as it is, mapped.' },
    rebuild: { label: 'Rebuild', tone: 'accent', meaning: 'Build it again on the target.' },
    replace_with_standard: {
      label: 'Replace with standard',
      tone: 'neutral',
      meaning: 'Use the target product’s standard way instead.',
    },
    agentify: {
      label: 'Agentify',
      tone: 'accent',
      meaning: 'Hand the work to an agent. Never proposed automatically: only a person chooses it.',
    },
    archive: {
      label: 'Archive',
      tone: 'warning',
      meaning: 'Keep it read-only outside the target.',
    },
    retire: { label: 'Retire', tone: 'danger', meaning: 'Stop using it; do not migrate it.' },
  };

export function dispositionInfo(d: string) {
  return (
    (DISPOSITION_INFO as Record<string, (typeof DISPOSITION_INFO)[Disposition] | undefined>)[d] ?? {
      label: d,
      tone: 'neutral' as Tone,
      meaning: '',
    }
  );
}

export const CUTOVER_LABELS: Record<CutoverOption, { label: string; meaning: string }> = {
  whole_estate: { label: 'Whole estate', meaning: 'Everything moves in one cutover window.' },
  phased: {
    label: 'Phased',
    meaning: 'Waves cut over one after another; systems coexist between them.',
  },
  parallel_run: {
    label: 'Parallel run',
    meaning: 'Both systems run side by side for a period before the switch.',
  },
};

export function cutoverLabel(o: string): string {
  return (CUTOVER_LABELS as Record<string, { label: string } | undefined>)[o]?.label ?? o;
}

export const GAP_ROUTE_LABELS: Record<GapRoute, string> = {
  configuration: 'Configuration',
  customer_extension: 'Customer extension',
  vendor_product_change: 'Vendor product change',
  process_change: 'Process change',
};

export const RISK_STATUS: Record<string, { label: string; tone: Tone }> = {
  proposed: { label: 'Proposed', tone: 'warning' },
  accepted: { label: 'Accepted', tone: 'info' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  closed: { label: 'Closed', tone: 'success' },
};

export function riskStatus(s: string) {
  return RISK_STATUS[s] ?? { label: s, tone: 'neutral' as Tone };
}

export function riskTone(score: number): Tone {
  if (score >= 15) return 'danger';
  if (score >= 8) return 'warning';
  return 'neutral';
}

export const BASELINE_STATUS: Record<string, { label: string; tone: Tone }> = {
  proposed: { label: 'Proposed', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  superseded: { label: 'Superseded', tone: 'neutral' },
};

export function baselineStatus(s: string) {
  return BASELINE_STATUS[s] ?? { label: s, tone: 'neutral' as Tone };
}

/** "customer_it_security_lead" → "Customer IT security lead"; "data" → "Data". */
export function humanize(key: string): string {
  const w = key
    .replace(/_/g, ' ')
    .replace(/\bit\b/g, 'IT')
    .replace(/\bsme\b/g, 'SME');
  return w.charAt(0).toUpperCase() + w.slice(1);
}

// ---------- Numbers ----------

function h(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/** A range, never a single number: "80–120 h (likely 95)". */
export function formatRange(
  r: { low?: number | null; likely?: number | null; high?: number | null } | null | undefined,
): string {
  if (r?.likely === undefined || r.likely === null) return 'Not estimated';
  const low = r.low ?? r.likely;
  const high = r.high ?? r.likely;
  return `${h(low)}–${h(high)} h (likely ${h(r.likely)})`;
}

/** Share of capacity used, and whether it is over. */
export function loadRatio(hours: number, capacity: number): { pct: number | null; over: boolean } {
  if (capacity <= 0) return { pct: null, over: hours > 0 };
  return { pct: Math.round((100 * hours) / capacity), over: hours > capacity };
}

// ---------- Validation ----------

export function minLength(value: string, min: number, what: string): string | undefined {
  const n = value.trim().length;
  return n < min ? `${what} (at least ${String(min)} characters, ${String(n)} so far).` : undefined;
}

const WAVE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export interface WaveForm {
  key: string;
  name: string;
  start: string;
  end: string;
  cutover: string;
  capacity: Record<string, string>;
}

export function validateWave(f: WaveForm): {
  errors: FieldErrors<'key' | 'name' | 'start' | 'end' | 'cutover' | 'capacity'>;
  body: WaveIn | null;
} {
  const errors: FieldErrors<'key' | 'name' | 'start' | 'end' | 'cutover' | 'capacity'> = {};
  if (!WAVE_KEY.test(f.key))
    errors.key = 'Use letters, digits, - or _ (up to 40), starting with a letter or digit.';
  if (f.name.trim().length < 2) errors.name = 'Use at least 2 characters.';
  if (!f.start) errors.start = 'Choose a start date.';
  if (!f.end) errors.end = 'Choose an end date.';
  else if (f.start && f.end < f.start) errors.end = 'A wave ends on or after its start.';
  const capacity: Record<string, number> = {};
  for (const [role, v] of Object.entries(f.capacity)) {
    if (!v.trim()) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      errors.capacity = `Capacity for ${humanize(role)} must be zero or more hours.`;
    } else capacity[role] = n;
  }
  const ok = Object.keys(errors).length === 0;
  return {
    errors,
    body: ok
      ? { name: f.name.trim(), start: f.start, end: f.end, cutover: f.cutover || null, capacity }
      : null,
  };
}

export function validateCoexistence(
  f: Partial<CoexistenceIn>,
): FieldErrors<'end_date' | 'exit_reconciliation' | 'system_of_record'> {
  const e: FieldErrors<'end_date' | 'exit_reconciliation' | 'system_of_record'> = {};
  if (!f.system_of_record) e.system_of_record = 'Name the system of record.';
  if (!f.end_date) e.end_date = 'Choose the end date.';
  const m = minLength(f.exit_reconciliation ?? '', 10, 'Describe the exit reconciliation');
  if (m) e.exit_reconciliation = m;
  return e;
}

/** "A:5, B:12.5" or one value per line → step key to minutes. */
export function parseTimings(
  text: string,
  known: readonly string[],
): { timings: Record<string, number>; error: string | null } {
  const timings: Record<string, number> = {};
  const lines = text
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const l of lines) {
    const i = l.lastIndexOf('=');
    if (i <= 0) return { timings, error: `Write each line as step = minutes: "${l}"` };
    const key = l.slice(0, i).trim();
    const n = Number(l.slice(i + 1).trim());
    if (!known.includes(key)) return { timings, error: `Not a runbook step: ${key}` };
    if (!Number.isFinite(n) || n < 0)
      return { timings, error: `Minutes must be zero or more: ${key}` };
    timings[key] = n;
  }
  if (Object.keys(timings).length === 0) return { timings, error: 'Enter at least one timing.' };
  return { timings, error: null };
}
