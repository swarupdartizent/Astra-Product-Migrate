import type { ConversionTestIn, TestExpected } from '@/api/upgrade-types';
import type { FieldErrors } from '@/lib/forms';
import type { Tone } from '@/ui';

export const OBJECT_STATUS: Record<string, { label: string; tone: Tone }> = {
  compiled: { label: 'Compiled', tone: 'success' },
  compile_failed: { label: 'Does not compile', tone: 'danger' },
  review: { label: 'Needs review', tone: 'warning' },
};

export function objectStatus(status: string) {
  return OBJECT_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
}

/** Target dialects the API accepts today (ConversionIn.target_dialect). */
export const TARGET_DIALECTS = ['sqlserver'] as const;

export const OBJECT_PAGE = 50;

/** Readable JSON for inputs, expected and actual values. */
export function show(v: unknown): string {
  if (v === undefined) return '—';
  if (typeof v === 'string') return JSON.stringify(v);
  return JSON.stringify(v, null, 2);
}

// ---------- Recorded test form ----------

export type ExpectKind = 'value' | 'outputs' | 'rows' | 'error';

export const EXPECT_KINDS: { value: ExpectKind; label: string; help: string }[] = [
  { value: 'value', label: 'Return value', help: 'Any JSON value, for example 42 or "A".' },
  {
    value: 'outputs',
    label: 'Output parameters',
    help: 'A JSON object of OUTPUT parameter names to values.',
  },
  {
    value: 'rows',
    label: 'Result rows',
    help: 'A JSON array of rows, each an array of column values.',
  },
  {
    value: 'error',
    label: 'An error',
    help: 'Text the error must contain, when the case must fail.',
  },
];

export interface TestForm {
  object_name: string;
  name: string;
  inputs: string;
  outputs: string;
  setup: string;
  expectKind: ExpectKind;
  expected: string;
}

export const EMPTY_TEST: TestForm = {
  object_name: '',
  name: '',
  inputs: '{}',
  outputs: '',
  setup: '{}',
  expectKind: 'value',
  expected: '',
};

type TestField = 'object_name' | 'name' | 'inputs' | 'outputs' | 'setup' | 'expected';

function parse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not valid JSON.' };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validates the form and builds the request body; mirrors the API's rules. */
export function buildTest(f: TestForm): {
  errors: FieldErrors<TestField>;
  body: ConversionTestIn | null;
} {
  const errors: FieldErrors<TestField> = {};
  const objectName = f.object_name.trim();
  if (!/^[^.\s]+\.[^.\s]+$/.test(objectName)) {
    errors.object_name = 'Use schema.name, for example dbo.calculate_premium.';
  }
  const name = f.name.trim();
  if (name.length < 3 || name.length > 200) errors.name = 'Use 3 to 200 characters.';

  let inputs: Record<string, unknown> = {};
  const pi = parse(f.inputs.trim() || '{}');
  if (!pi.ok) errors.inputs = `Not valid JSON: ${pi.error}`;
  else if (!isRecord(pi.value)) errors.inputs = 'Use a JSON object of parameter name to value.';
  else inputs = pi.value;

  const outputs = f.outputs
    .split(',')
    .map((s) => s.trim().replace(/^@/, ''))
    .filter(Boolean);

  let setup: Record<string, Record<string, unknown>[]> = {};
  const ps = parse(f.setup.trim() || '{}');
  if (!ps.ok) errors.setup = `Not valid JSON: ${ps.error}`;
  else if (
    !isRecord(ps.value) ||
    !Object.entries(ps.value).every(
      ([k, rows]) => /^[^.\s]+\.[^.\s]+$/.test(k) && Array.isArray(rows) && rows.every(isRecord),
    )
  ) {
    errors.setup = 'Use {"schema.table": [{"column": value}, …]}.';
  } else setup = ps.value as Record<string, Record<string, unknown>[]>;

  const expected: TestExpected = {};
  if (f.expectKind === 'error') {
    if (!f.expected.trim()) errors.expected = 'Enter the text the error must contain.';
    else expected.error = f.expected.trim();
  } else {
    const pe = parse(f.expected.trim());
    if (!f.expected.trim()) errors.expected = 'Enter the expected result as JSON.';
    else if (!pe.ok) errors.expected = `Not valid JSON: ${pe.error}`;
    else if (f.expectKind === 'outputs') {
      if (!isRecord(pe.value)) errors.expected = 'Use a JSON object of parameter name to value.';
      else expected.outputs = pe.value;
    } else if (f.expectKind === 'rows') {
      if (!Array.isArray(pe.value) || !pe.value.every(Array.isArray)) {
        errors.expected = 'Use a JSON array of rows, each an array.';
      } else expected.rows = pe.value as unknown[][];
    } else {
      expected.value = pe.value;
    }
  }

  const ok = Object.keys(errors).length === 0;
  return {
    errors,
    body: ok ? { object_name: objectName, name, inputs, outputs, setup, expected } : null,
  };
}

/** Server 422 paths such as "expected.rows" or "setup.dbo.t.0" → the form field. */
export function testFieldOf(path: string): TestField | null {
  const head = path.split('.')[0] ?? '';
  return ['object_name', 'name', 'inputs', 'outputs', 'setup', 'expected'].includes(head)
    ? (head as TestField)
    : null;
}
