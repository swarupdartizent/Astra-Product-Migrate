import type {
  Band,
  MciSettings,
  ProgrammeDetail,
  ProgrammePartner,
  SetupIn,
} from '@/api/programmes-types';
import type { FieldErrors } from '@/lib/forms';
import type { Tone } from '@/ui';

// ---------- Sections and URL state ----------

export const PROGRAMME_SECTIONS = ['overview', 'setup', 'fleet', 'portfolio', 'metering'] as const;
export type ProgrammeSection = (typeof PROGRAMME_SECTIONS)[number];

export const PROGRAMME_SECTION_LABELS: Record<ProgrammeSection, string> = {
  overview: 'Overview',
  setup: 'Set-up',
  fleet: 'Fleet',
  portfolio: 'Portfolio',
  metering: 'Metering',
};

export function isProgrammeSection(v: unknown): v is ProgrammeSection {
  return typeof v === 'string' && (PROGRAMME_SECTIONS as readonly string[]).includes(v);
}

/** The programme page's view in the URL: section and, in the fleet, the selected customer. */
export interface ProgrammeSearch {
  section?: ProgrammeSection;
  customer?: string;
}

export function parseProgrammeSearch(search: Record<string, unknown>): ProgrammeSearch {
  const out: ProgrammeSearch = {};
  if (isProgrammeSection(search.section)) out.section = search.section;
  if (typeof search.customer === 'string' && search.customer) out.customer = search.customer;
  return out;
}

// ---------- Labels ----------

const BAND_INFO: Record<Band, { label: string; tone: Tone }> = {
  simple: { label: 'Simple', tone: 'success' },
  medium: { label: 'Medium', tone: 'warning' },
  complex: { label: 'Complex', tone: 'danger' },
};

export function bandInfo(band: string | null | undefined): { label: string; tone: Tone } {
  if (!band) return { label: 'Not scanned', tone: 'neutral' };
  return (
    (BAND_INFO as Record<string, { label: string; tone: Tone }>)[band] ?? {
      label: band,
      tone: 'neutral',
    }
  );
}

/** gates.py GATES, in order. */
export const GATE_TITLES: Record<string, string> = {
  configure: 'Configure',
  discover: 'Discover',
  plan: 'Plan',
  design: 'Design',
  build_rehearse: 'Build and rehearse',
  cutover: 'Cutover',
  stabilise: 'Stabilise',
  decommission: 'Decommission',
};

export function gateTitle(key: string): string {
  return GATE_TITLES[key] ?? key.replace(/_/g, ' ');
}

const SCAN_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  succeeded: { label: 'Succeeded', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  blocked: { label: 'Blocked', tone: 'warning' },
};

export function scanStatus(status: string): { label: string; tone: Tone } {
  return SCAN_STATUS[status] ?? { label: status, tone: 'neutral' };
}

/** "Partner A's customers" or "the customers of Partner A and Partner B". */
export function partnerScopeText(partners: readonly ProgrammePartner[]): string {
  const names = partners.map((p) => p.name);
  const last = names.at(-1);
  if (last === undefined) return 'You see no partner’s customers in this programme.';
  if (names.length === 1) return `You see only ${last}’s customers.`;
  return `You see only the customers of ${names.slice(0, -1).join(', ')} and ${last}.`;
}

export function fmt(n: number, digits = 1): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

// ---------- Set-up form ----------

/** Text state of the set-up form; numbers are parsed on validation. */
export interface SetupDraft {
  source_adapter: string;
  target_adapter: string;
  blueprint_template: string;
  packs: string[];
  segments: string;
  weights: Record<string, string>;
  lows: Record<string, string>;
  highs: Record<string, string>;
  bandSimple: string;
  bandMedium: string;
  weeks: Record<Band, string>;
}

export function setupDraft(p: ProgrammeDetail): SetupDraft {
  const m = p.mci;
  const by = (f: (k: string) => number) =>
    Object.fromEntries(m.measures.map((x) => [x.key, String(f(x.key))]));
  return {
    source_adapter: p.source_adapter ?? '',
    target_adapter: p.target_adapter ?? '',
    blueprint_template: p.blueprint_template ?? '',
    packs: [...p.packs],
    segments: p.segments.join('\n'),
    weights: by((k) => m.weights[k] ?? 0),
    lows: by((k) => m.ranges[k]?.[0] ?? 0),
    highs: by((k) => m.ranges[k]?.[1] ?? 0),
    bandSimple: String(m.bands.simple),
    bandMedium: String(m.bands.medium),
    weeks: {
      simple: String(p.band_effort_weeks.simple ?? 8),
      medium: String(p.band_effort_weeks.medium ?? 16),
      complex: String(p.band_effort_weeks.complex ?? 26),
    },
  };
}

function num(v: string): number | null {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function splitSegments(text: string): string[] {
  return text
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Sum of the weights; null when any weight is not a number. */
export function weightSum(draft: SetupDraft, measures: MciSettings['measures']): number | null {
  let total = 0;
  for (const m of measures) {
    const n = num(draft.weights[m.key] ?? '');
    if (n === null) return null;
    total += n;
  }
  return total;
}

export const WEIGHT_TOLERANCE = 1e-6;

/**
 * Mirrors the API (programme.validate_config and setup): weights 0 or more adding up to 1,
 * low < high, 0 < simple < medium < 100, weeks per band in (0, 104], distinct segments, and
 * segments still used by customers kept.
 */
export function setupErrors(
  draft: SetupDraft,
  measures: MciSettings['measures'],
  segmentsInUse: readonly string[],
): FieldErrors {
  const out: FieldErrors = {};
  for (const m of measures) {
    const w = num(draft.weights[m.key] ?? '');
    if (w === null || w < 0) out[`weight.${m.key}`] = 'Enter a weight of 0 or more.';
    const lo = num(draft.lows[m.key] ?? '');
    const hi = num(draft.highs[m.key] ?? '');
    if (lo === null) out[`low.${m.key}`] = 'Enter a number.';
    if (hi === null) out[`high.${m.key}`] = 'Enter a number.';
    else if (lo !== null && !(lo < hi)) out[`high.${m.key}`] = 'High must be above low.';
  }
  const sum = weightSum(draft, measures);
  if (sum !== null && Math.abs(sum - 1) > WEIGHT_TOLERANCE) {
    out.weights = `The weights add up to ${sum.toFixed(3)}; they must add up to 1.`;
  }
  const simple = num(draft.bandSimple);
  const medium = num(draft.bandMedium);
  if (simple === null || simple <= 0 || simple >= 100) out.bandSimple = 'Between 0 and 100.';
  if (medium === null || medium <= 0 || medium >= 100) out.bandMedium = 'Between 0 and 100.';
  else if (simple !== null && !(simple < medium)) {
    out.bandMedium = 'The medium limit must be above the simple limit.';
  }
  for (const b of ['simple', 'medium', 'complex'] as const) {
    const w = num(draft.weeks[b]);
    if (w === null || w <= 0 || w > 104) out[`weeks.${b}`] = 'Between 0 and 104 weeks.';
  }
  const segs = splitSegments(draft.segments);
  if (segs.some((x) => x.length > 100)) out.segments = 'Keep each segment under 100 characters.';
  else if (new Set(segs).size !== segs.length) out.segments = 'Segment names must be distinct.';
  else if (segs.length > 50) out.segments = 'Use at most 50 segments.';
  else {
    const missing = segmentsInUse.filter((x) => !segs.includes(x));
    if (missing.length > 0) out.segments = `Customers still use: ${missing.join(', ')}.`;
  }
  return out;
}

export function setupBody(draft: SetupDraft, measures: MciSettings['measures']): SetupIn {
  const n = (v: string | undefined) => Number(v ?? '');
  return {
    source_adapter: draft.source_adapter || null,
    target_adapter: draft.target_adapter || null,
    blueprint_template: draft.blueprint_template || null,
    packs: draft.packs,
    segments: splitSegments(draft.segments),
    mci_config: {
      weights: Object.fromEntries(measures.map((m) => [m.key, n(draft.weights[m.key])])),
      ranges: Object.fromEntries(
        measures.map((m): [string, [number, number]] => [
          m.key,
          [n(draft.lows[m.key]), n(draft.highs[m.key])],
        ]),
      ),
      bands: { simple: n(draft.bandSimple), medium: n(draft.bandMedium) },
    },
    band_effort_weeks: {
      simple: n(draft.weeks.simple),
      medium: n(draft.weeks.medium),
      complex: n(draft.weeks.complex),
    },
  };
}

// ---------- Pods, waves, consent ----------

export function podErrors(name: string, capacity: string): FieldErrors<'name' | 'capacity'> {
  const out: FieldErrors<'name' | 'capacity'> = {};
  const n = name.trim().length;
  if (n < 2 || n > 100) out.name = 'Use 2–100 characters.';
  const c = Number(capacity);
  if (capacity.trim() === '' || !Number.isInteger(c) || c < 1 || c > 50) {
    out.capacity = 'A whole number from 1 to 50.';
  }
  return out;
}

export const WAVE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export function waveErrors(
  key: string,
  name: string,
  start: string,
  end: string,
  existingKeys: readonly string[] | null,
): FieldErrors<'key' | 'name' | 'start' | 'end'> {
  const out: FieldErrors<'key' | 'name' | 'start' | 'end'> = {};
  if (!WAVE_KEY_RE.test(key)) {
    out.key = 'Up to 40 letters, digits, - or _, starting with a letter or digit.';
  } else if (existingKeys?.includes(key)) {
    out.key = 'A wave with this key exists. Edit it instead.';
  }
  const n = name.trim().length;
  if (n < 2 || n > 100) out.name = 'Use 2–100 characters.';
  if (!start) out.start = 'Choose the start date.';
  if (!end) out.end = 'Choose the end date.';
  else if (start && end < start) out.end = 'A wave ends on or after its start.';
  return out;
}

/** Whole weeks from start to end (ISO dates), as the planner counts them. */
export function waveWeeks(start: string, end: string): number {
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Math.round((ms / 86_400_000 / 7) * 10) / 10;
}

export type ConsentField = 'signatory_name' | 'signatory_title' | 'scope' | 'reference';
export const CONSENT_SCOPE_MIN = 20;

export function consentErrors(v: Record<ConsentField, string>): FieldErrors<ConsentField> {
  const out: FieldErrors<ConsentField> = {};
  const len = (k: ConsentField) => v[k].trim().length;
  if (len('signatory_name') < 2 || len('signatory_name') > 200) {
    out.signatory_name = 'Use 2–200 characters.';
  }
  if (len('signatory_title') < 2 || len('signatory_title') > 200) {
    out.signatory_title = 'Use 2–200 characters.';
  }
  const s = len('scope');
  if (s < CONSENT_SCOPE_MIN) {
    out.scope = `Describe what may be read in at least ${String(CONSENT_SCOPE_MIN)} characters (${String(s)} so far).`;
  } else if (s > 4000) out.scope = 'Keep it under 4000 characters.';
  if (len('reference') < 3 || len('reference') > 1000) {
    out.reference = 'Say where the signed consent is kept (3–1000 characters).';
  }
  return out;
}
