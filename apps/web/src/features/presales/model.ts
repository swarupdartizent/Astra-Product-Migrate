import type { PresalesIn, Questionnaire } from '@/api/planning-types';

type QKey = keyof Questionnaire;

export const QUESTION_FIELDS: {
  key: QKey;
  label: string;
  help?: string;
  required?: boolean;
  integer: boolean;
  min: number;
  max: number;
}[] = [
  { key: 'tables', label: 'Product tables', required: true, integer: true, min: 0, max: 1_000_000 },
  { key: 'customer_tables', label: 'Customer-built tables', integer: true, min: 0, max: 1_000_000 },
  {
    key: 'code_objects',
    label: 'Code objects',
    help: 'Procedures, functions and triggers.',
    integer: true,
    min: 0,
    max: 1_000_000,
  },
  { key: 'reports', label: 'Reports', integer: true, min: 0, max: 1_000_000 },
  { key: 'interfaces', label: 'Interfaces', integer: true, min: 0, max: 100_000 },
  {
    key: 'configuration_items',
    label: 'Configuration items',
    integer: true,
    min: 0,
    max: 1_000_000,
  },
  { key: 'rows_millions', label: 'Rows (millions)', integer: false, min: 0, max: 1_000_000 },
  {
    key: 'avg_columns',
    label: 'Average columns per table',
    help: 'Optional; 15 is assumed when empty.',
    integer: false,
    min: 1,
    max: 5000,
  },
  {
    key: 'team_hours_per_week',
    label: 'Team hours per week',
    required: true,
    integer: false,
    min: 0.01,
    max: 100_000,
  },
  { key: 'wave_weeks', label: 'Weeks per wave', required: true, integer: true, min: 1, max: 104 },
];

export const EMPTY_QUESTIONNAIRE: Record<QKey, string> = {
  tables: '0',
  customer_tables: '0',
  code_objects: '0',
  reports: '0',
  interfaces: '0',
  configuration_items: '0',
  rows_millions: '0',
  avg_columns: '',
  team_hours_per_week: '200',
  wave_weeks: '8',
};

export interface PresalesForm {
  name: string;
  programme_id: string;
  estimation_packs: string[];
  questionnaire: Record<QKey, string>;
  sample_extract_yaml: string;
}

/** Mirrors the API's limits; error keys use the API's field paths (questionnaire.tables …). */
export function validatePresales(f: PresalesForm): {
  errors: Record<string, string>;
  body: PresalesIn | null;
} {
  const errors: Record<string, string> = {};
  const name = f.name.trim();
  if (name.length < 3 || name.length > 200) errors.name = 'Use 3 to 200 characters.';
  if (f.estimation_packs.length < 1 || f.estimation_packs.length > 5) {
    errors.estimation_packs = 'Choose 1 to 5 estimation packs.';
  }
  const q: Partial<Questionnaire> = {};
  for (const field of QUESTION_FIELDS) {
    const raw = f.questionnaire[field.key].trim();
    if (!raw) {
      if (field.key === 'avg_columns') {
        q.avg_columns = null;
        continue;
      }
      errors[`questionnaire.${field.key}`] = 'Enter a number.';
      continue;
    }
    const n = Number(raw);
    if (
      !Number.isFinite(n) ||
      n < field.min ||
      n > field.max ||
      (field.integer && !Number.isInteger(n))
    ) {
      errors[`questionnaire.${field.key}`] =
        `Use ${field.integer ? 'a whole number' : 'a number'} from ${String(field.min)} to ${field.max.toLocaleString()}.`;
      continue;
    }
    (q as Record<string, number>)[field.key] = n;
  }
  const ok = Object.keys(errors).length === 0;
  return {
    errors,
    body: ok
      ? {
          name,
          programme_id: f.programme_id || null,
          estimation_packs: f.estimation_packs,
          questionnaire: q as Questionnaire,
          sample_extract_yaml: f.sample_extract_yaml.trim() || null,
        }
      : null,
  };
}
