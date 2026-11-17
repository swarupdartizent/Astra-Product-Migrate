import { describe, expect, it } from 'vitest';
import type { Decision } from '@/api/types';
import {
  choosesLessStrict,
  conflictContext,
  conflictOptions,
  looseningContext,
  validateDecision,
} from './decisions';

function decision(overrides: Partial<Decision>): Decision {
  return {
    id: 'd1',
    kind: 'setting_conflict',
    subject: 'retention.records.years',
    status: 'open',
    context: {},
    chosen_value: null,
    reason: null,
    requested_by_name: 'Fixture Lead',
    decided_by_name: null,
    decided_at: null,
    created_at: '2026-11-17T10:00:00Z',
    can_decide: true,
    ...overrides,
  };
}

const conflict = decision({
  context: {
    key: 'retention.records.years',
    stricter: 'higher',
    unit: 'years',
    strictest: 10,
    values: [
      { pack: 'a@1.0.0', value: 7, description: 'Pack A' },
      { pack: 'b@1.0.0', value: 10, sources: [{ reference: 'Rule 4', url: null }] },
      { pack: 'c@1.0.0', value: 7 },
    ],
  },
});

describe('setting conflict decisions', () => {
  it('reads the context and groups packs by value', () => {
    const ctx = conflictContext(conflict)!;
    expect(ctx.stricter).toBe('higher');
    expect(ctx.values[1]?.sources).toEqual([{ reference: 'Rule 4', url: null }]);
    expect(conflictOptions(ctx)).toEqual([
      { value: 7, packs: ['a@1.0.0', 'c@1.0.0'] },
      { value: 10, packs: ['b@1.0.0'] },
    ]);
  });

  it('warns when the less strict value is chosen', () => {
    const ctx = conflictContext(conflict)!;
    expect(choosesLessStrict(ctx, 7)).toBe(true);
    expect(choosesLessStrict(ctx, 10)).toBe(false);
    expect(choosesLessStrict(ctx, null)).toBe(false);
    expect(choosesLessStrict({ ...ctx, strictest: null }, 7)).toBe(false);
  });

  it('needs a chosen value and a 10-character reason', () => {
    expect(validateDecision('setting_conflict', null, '')).toEqual({
      chosen: 'Choose one of the values.',
      reason: 'Give a reason. It is recorded in the audit log.',
    });
    expect(validateDecision('setting_conflict', 10, 'Statutory minimum applies')).toEqual({});
    expect(validateDecision('loosening', null, 'Statutory minimum applies')).toEqual({});
  });
});

describe('loosening requests', () => {
  it('reads requested and effective values', () => {
    const d = decision({
      kind: 'loosening',
      context: {
        setting: 'retention.records.years',
        value: 5,
        effective: 7,
        reason: 'Contract term',
        packs: ['a@1.0.0'],
      },
    });
    expect(looseningContext(d)).toEqual({
      setting: 'retention.records.years',
      value: 5,
      effective: 7,
      reason: 'Contract term',
      packs: ['a@1.0.0'],
    });
    expect(conflictContext(d)).toBeNull();
  });
});
