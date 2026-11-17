import type {
  Decision,
  LooseningContext,
  SettingConflictContext,
  SettingValueType,
} from '@/api/types';
import { reasonError } from '@/lib/forms';
import { compareStrictness, isRecord } from './model';

/** Reads a conflict decision's context defensively (the API types it as an object). */
export function conflictContext(d: Decision): SettingConflictContext | null {
  const c = d.context;
  if (d.kind !== 'setting_conflict' || !Array.isArray(c.values)) return null;
  return {
    key: typeof c.key === 'string' ? c.key : d.subject,
    stricter: (typeof c.stricter === 'string'
      ? c.stricter
      : 'none') as SettingConflictContext['stricter'],
    unit: typeof c.unit === 'string' ? c.unit : null,
    strictest: (c.strictest ?? null) as SettingValueType | null,
    values: c.values.filter(isRecord).map((v) => ({
      pack: String(v.pack),
      value: v.value as SettingValueType,
      ...(typeof v.description === 'string' ? { description: v.description } : {}),
      ...(Array.isArray(v.sources)
        ? {
            sources: v.sources.filter(isRecord).map((x) => ({
              reference: String(x.reference),
              url: (x.url as string | null | undefined) ?? null,
            })),
          }
        : {}),
    })),
  };
}

export function looseningContext(d: Decision): LooseningContext | null {
  const c = d.context;
  if (d.kind !== 'loosening') return null;
  return {
    setting: typeof c.setting === 'string' ? c.setting : d.subject,
    value: c.value as SettingValueType,
    effective: (c.effective ?? null) as SettingValueType | null,
    ...(typeof c.reason === 'string' ? { reason: c.reason } : {}),
    ...(Array.isArray(c.packs) ? { packs: c.packs.map(String) } : {}),
  };
}

/** True when choosing `value` picks the less strict side of an ordered conflict. */
export function choosesLessStrict(
  ctx: SettingConflictContext,
  value: SettingValueType | null,
): boolean {
  if (value === null || ctx.strictest === null) return false;
  return compareStrictness(ctx.stricter, value, ctx.strictest) < 0;
}

export interface DecideFormErrors {
  chosen?: string;
  reason?: string;
}

export function validateDecision(
  kind: Decision['kind'],
  chosen: SettingValueType | null,
  reason: string,
): DecideFormErrors {
  const errors: DecideFormErrors = {};
  if (kind === 'setting_conflict' && chosen === null) errors.chosen = 'Choose one of the values.';
  const r = reasonError(reason);
  if (r) errors.reason = r;
  return errors;
}

/** Distinct values in pack order, each with the packs that set it. */
export function conflictOptions(ctx: SettingConflictContext) {
  const out: { value: SettingValueType; packs: string[] }[] = [];
  for (const v of ctx.values) {
    const existing = out.find((o) => o.value === v.value);
    if (existing) existing.packs.push(v.pack);
    else out.push({ value: v.value, packs: [v.pack] });
  }
  return out;
}
