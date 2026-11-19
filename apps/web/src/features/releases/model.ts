import type {
  ReleaseEvaluation,
  ReleaseImprovement,
  ReleaseRegression,
  ReleaseStatus,
  SuiteScore,
} from '@/api/releases-types';
import { type FieldErrors, reasonError } from '@/lib/forms';
import type { Tone } from '@/ui';

/** Who may open the page: platform readers and release recorders. The API refuses everyone else. */
export const RELEASES_PERMISSION = ['tenant:read', 'golden:run'] as const;

export const RELEASE_STATUS: Record<ReleaseStatus, { label: string; tone: Tone }> = {
  released: { label: 'Released', tone: 'success' },
  blocked: { label: 'Blocked', tone: 'danger' },
};

export function releaseStatus(status: string): { label: string; tone: Tone } {
  const known = (RELEASE_STATUS as Partial<Record<string, { label: string; tone: Tone }>>)[status];
  return known ?? { label: status, tone: 'neutral' };
}

// ---------- Areas and measures (docs/release-gate.md) ----------

export interface AreaInfo {
  key: string;
  label: string;
  /** The platform engine that scores the area. */
  engine: string;
}

/** The areas of a golden suite, in the order the release gate document lists them. */
export const AREAS: readonly AreaInfo[] = [
  { key: 'mapping', label: 'Mapping', engine: 'Mapping proposals' },
  { key: 'configuration', label: 'Configuration', engine: 'Configuration translator' },
  { key: 'code', label: 'Code', engine: 'SQL Anywhere converter' },
  { key: 'planning', label: 'Planning', engine: 'Scope proposals and dependency cycles' },
  {
    key: 'compliance',
    label: 'Compliance',
    engine: 'Compliance classification of review subjects',
  },
  { key: 'review', label: 'Review', engine: 'Queue priority and precedent pattern keys' },
];

/** Plain-language descriptions of each measure, after the table in docs/release-gate.md. */
export const MEASURE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'mapping.top1_accuracy': 'The first mapping proposed for a column is the expected target.',
  'mapping.auto_precision': 'Proposals that skip review are right.',
  'mapping.review_recall': 'Wrong proposals go to review.',
  'configuration.accuracy':
    'Each configuration item gets the expected target area, retirement or block.',
  'code.review_routing_accuracy': 'Code objects are sent to review, or not, as expected.',
  'code.conversion_accuracy': 'Converted code has the required text and the source text is gone.',
  'planning.disposition_accuracy': 'Scope proposals give each element the expected disposition.',
  'planning.cycle_recall': 'The expected dependency cycles are found.',
  'planning.cycle_precision': 'The dependency cycles found are expected ones.',
  'compliance.level_accuracy': 'Review subjects get the expected compliance level.',
  'compliance.approvers_accuracy': 'Review subjects get the expected approvers.',
  'review.order_agreement': 'Pairs of review items come in the expected queue order.',
  'review.grouping_agreement': 'Precedent pattern keys group review items as expected.',
};

const OTHER_AREA = 'other';

/** "mapping.top1_accuracy" → area "mapping", measure "top1_accuracy". No dot → area "other". */
export function splitMeasure(name: string): { area: string; measure: string } {
  const dot = name.indexOf('.');
  if (dot <= 0) return { area: OTHER_AREA, measure: name };
  return { area: name.slice(0, dot), measure: name.slice(dot + 1) };
}

export function areaInfo(key: string): AreaInfo {
  return (
    AREAS.find((a) => a.key === key) ?? {
      key,
      label: key === OTHER_AREA ? 'Other' : key.charAt(0).toUpperCase() + key.slice(1),
      engine: '',
    }
  );
}

export function describeMeasure(name: string): string | null {
  return MEASURE_DESCRIPTIONS[name] ?? null;
}

/**
 * Groups items by the area of their measure name: known areas in document order, then any other
 * area alphabetically. Within an area, items keep measure-name order.
 */
export function groupByArea<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
): { area: AreaInfo; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const { area } = splitMeasure(nameOf(item));
    const list = groups.get(area) ?? [];
    list.push(item);
    groups.set(area, list);
  }
  const rank = (k: string) => {
    const i = AREAS.findIndex((a) => a.key === k);
    return i === -1 ? AREAS.length : i;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([key, list]) => ({
      area: areaInfo(key),
      items: [...list].sort((x, y) => nameOf(x).localeCompare(nameOf(y))),
    }));
}

/** Measures are ratios from 0 to 1; three decimals, as the gate document quotes them. */
export function formatScore(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toFixed(3);
}

export function formatDelta(baseline: number | null, current: number | null): string {
  if (baseline === null || current === null) return '—';
  const d = current - baseline;
  const text = Math.abs(d).toFixed(3);
  if (text === '0.000') return '0.000';
  return `${d > 0 ? '+' : '−'}${text}`;
}

/** A regression's measure label: the measure name, or the whole suite when it disappeared. */
export function regressionSubject(r: ReleaseRegression): string {
  return r.measure ?? 'Whole suite';
}

// ---------- Side-by-side comparison (Check now) ----------

export type CompareKind = 'fell' | 'missing' | 'improved' | 'same' | 'new';

export interface CompareRow {
  suite: string;
  measure: string;
  baseline: number | null;
  current: number | null;
  kind: CompareKind;
}

export interface SuiteComparison {
  suite: string;
  /** The suite disappeared: a regression on its own. */
  missing: boolean;
  /** The suite file changed since the baseline. */
  changed: boolean;
  rows: CompareRow[];
}

const key = (suite: string, measure: string | null) => `${suite}\u0000${measure ?? ''}`;

/**
 * Baseline beside now, per suite and measure. The server's regressions and improvements are the
 * authority for each row's kind; `baseline` is the baseline release's full scorecard when it is
 * available. Without it, baseline values come from the regressions and improvements only, and
 * the other rows are unchanged (kind "same", baseline null).
 */
export function compareScorecards(
  evaluation: ReleaseEvaluation,
  baseline: Record<string, SuiteScore> | null,
): SuiteComparison[] {
  const fell = new Map<string, ReleaseRegression>();
  for (const r of evaluation.regressions) fell.set(key(r.suite, r.measure), r);
  const rose = new Map<string, ReleaseImprovement>();
  for (const r of evaluation.improved) rose.set(key(r.suite, r.measure), r);
  const firstRelease = evaluation.baseline_release === null;

  const suiteNames = new Set([
    ...Object.keys(evaluation.suites),
    ...Object.keys(baseline ?? {}),
    ...evaluation.regressions.map((r) => r.suite),
  ]);
  return [...suiteNames].sort().map((suite) => {
    const now = evaluation.suites[suite]?.measures ?? {};
    const before = baseline?.[suite]?.measures ?? null;
    const names = new Set([
      ...Object.keys(now),
      ...Object.keys(before ?? {}),
      ...evaluation.regressions.flatMap((r) =>
        r.suite === suite && r.measure !== null ? [r.measure] : [],
      ),
      ...evaluation.improved.filter((r) => r.suite === suite).map((r) => r.measure),
    ]);
    const rows = [...names].sort().map((measure): CompareRow => {
      const current = now[measure] ?? null;
      const reg = fell.get(key(suite, measure));
      const imp = rose.get(key(suite, measure));
      const base = before?.[measure] ?? reg?.baseline ?? imp?.baseline ?? null;
      let kind: CompareKind;
      if (reg) kind = reg.current === null ? 'missing' : 'fell';
      else if (imp) kind = 'improved';
      else if (firstRelease || (before !== null && !(measure in before))) kind = 'new';
      else kind = 'same';
      return { suite, measure, baseline: base, current, kind };
    });
    return {
      suite,
      missing: fell.has(key(suite, null)),
      changed: evaluation.changed_suites.includes(suite),
      rows,
    };
  });
}

export const COMPARE_KIND: Record<CompareKind, { label: string; tone: Tone }> = {
  fell: { label: 'Fell', tone: 'danger' },
  missing: { label: 'No longer produced', tone: 'danger' },
  improved: { label: 'Improved', tone: 'success' },
  same: { label: 'Unchanged', tone: 'neutral' },
  new: { label: 'New', tone: 'info' },
};

// ---------- Record a release ----------

/** The API's rules for POST /releases (api/routes/releases.py ReleaseIn). */
export const RELEASE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const RELEASE_NAME_MIN = 2;
export const RELEASE_NAME_MAX = 60;
export const RELEASE_REASON_MIN = 10;
export const RELEASE_REASON_MAX = 2000;

export type ReleaseField = 'name' | 'reason';

export function releaseErrors(v: Record<ReleaseField, string>): FieldErrors<ReleaseField> {
  const out: FieldErrors<ReleaseField> = {};
  const name = v.name.trim();
  if (name.length === 0) out.name = 'Give the release a name.';
  else if (name.length < RELEASE_NAME_MIN || name.length > RELEASE_NAME_MAX) {
    out.name = `Use ${String(RELEASE_NAME_MIN)}–${String(RELEASE_NAME_MAX)} characters (${String(name.length)} so far).`;
  } else if (!RELEASE_NAME_PATTERN.test(name)) {
    out.name =
      'Start with a letter or digit, then use only letters, digits, dots, underscores or hyphens.';
  }
  const reason = reasonError(v.reason, RELEASE_REASON_MIN);
  if (reason) out.reason = reason;
  else if (v.reason.trim().length > RELEASE_REASON_MAX) {
    out.reason = `Keep it under ${String(RELEASE_REASON_MAX)} characters.`;
  }
  return out;
}

/** The commands from docs/release-gate.md. */
export const GATE_COMMANDS = [
  'python -m astra_migrate.evaluation gate            # exit 1 when anything fell; CI runs this',
  'python -m astra_migrate.evaluation run --out x.json',
  'python -m astra_migrate.evaluation record --release R2 --reason "..."',
].join('\n');
