import type { DeltaDifference, DeltaGroup, Origin } from '@/api/upgrade-types';
import type { Tone } from '@/ui';

export const GROUP_INFO: Record<DeltaGroup, { label: string; tone: Tone; meaning: string }> = {
  unchanged: {
    label: 'Unchanged',
    tone: 'success',
    meaning: 'Same type and name in the target, with the same columns or code.',
  },
  renamed_or_moved: {
    label: 'Renamed or moved',
    tone: 'info',
    meaning: 'The same object under another schema, or another name with the same columns or code.',
  },
  changed_behaviour: {
    label: 'Changed behaviour',
    tone: 'warning',
    meaning:
      'Same name, different signature: columns added, removed or retyped, or different code.',
  },
  removed_in_target: {
    label: 'Removed in target',
    tone: 'danger',
    meaning: 'No counterpart in the target.',
  },
};

export function groupInfo(group: string) {
  return (
    (GROUP_INFO as Record<string, (typeof GROUP_INFO)[DeltaGroup] | undefined>)[group] ?? {
      label: group,
      tone: 'neutral' as Tone,
      meaning: '',
    }
  );
}

export const ORIGIN_INFO: Record<Origin, { label: string; tone: Tone; meaning: string }> = {
  standard: {
    label: 'Standard',
    tone: 'neutral',
    meaning: 'In the source product’s standard baseline, unchanged.',
  },
  customized_standard: {
    label: 'Customized standard',
    tone: 'warning',
    meaning: 'In the standard baseline, but changed for this customer.',
  },
  customer_specific: {
    label: 'Customer-specific',
    tone: 'accent',
    meaning: 'Not in the standard baseline: built for this customer.',
  },
  unknown: {
    label: 'Unknown',
    tone: 'neutral',
    meaning:
      'No standard baseline was given, so the origin is not known. It is stated as unknown, not guessed.',
  },
};

export function originInfo(origin: string) {
  return (
    (ORIGIN_INFO as Record<string, (typeof ORIGIN_INFO)[Origin] | undefined>)[origin] ?? {
      label: origin,
      tone: 'neutral' as Tone,
      meaning: '',
    }
  );
}

export const PATTERN_LABELS: Record<string, string> = {
  cross_product: 'Cross-product',
  same_family_upgrade: 'Same-family upgrade',
  consolidation: 'Consolidation',
};

export function patternLabel(p: string | null | undefined): string {
  if (!p) return 'Not set';
  return PATTERN_LABELS[p] ?? p;
}

/** "type:schema.name" → parts. */
export function parseObjectRef(ref: string): { type: string; name: string } {
  const i = ref.indexOf(':');
  return i > 0 ? { type: ref.slice(0, i), name: ref.slice(i + 1) } : { type: '', name: ref };
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** One-line, readable explanation of a difference's details. */
export function describeDifference(d: Pick<DeltaDifference, 'group' | 'details'>): string[] {
  const x = d.details ?? {};
  const out: string[] = [];
  if (x.how === 'moved') {
    out.push(`Moved from schema ${str(x.from_schema) ?? '?'} to ${str(x.to_schema) ?? '?'}.`);
  } else if (x.how === 'renamed') {
    out.push(
      typeof x.similarity === 'number'
        ? `Renamed; ${String(Math.round(x.similarity * 100))}% similar.`
        : 'Renamed.',
    );
  } else if (str(x.what)) {
    out.push(`${String(x.what).charAt(0).toUpperCase()}${String(x.what).slice(1)}.`);
  }
  const added = list(x.added_in_target);
  const missing = list(x.missing_in_target);
  const retyped = list(x.type_changed);
  if (added.length) out.push(`Added in target: ${added.join(', ')}.`);
  if (missing.length) out.push(`Missing in target: ${missing.join(', ')}.`);
  if (retyped.length) out.push(`Type changed: ${retyped.join('; ')}.`);
  if (d.group === 'removed_in_target') {
    const closest = str(x.closest);
    out.push(
      closest
        ? `Closest target object: ${closest}${
            typeof x.similarity === 'number'
              ? ` (${String(Math.round(x.similarity * 100))}% similar, below the rename threshold)`
              : ''
          }.`
        : 'No similar object in the target.',
    );
  }
  return out;
}

export const DIFF_PAGE = 50;
