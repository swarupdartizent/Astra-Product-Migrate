import { describe, expect, it } from 'vitest';
import type { BlueprintValidation, ComposedSetting } from '@/api/types';
import {
  approvalProgress,
  approvalSummary,
  decisionReasonError,
  emptyBlueprint,
  getIn,
  overrideStatus,
  parseValueText,
  pathCandidates,
  recordToRows,
  rowsToRecord,
  setIn,
  slugify,
} from './model';

describe('form ↔ content mapping', () => {
  it('sets nested values without mutating and creates parents', () => {
    const a = { name: 'x' };
    const b = setIn(a, ['constraints', 'cutover_window'], 'weekend');
    expect(a).toEqual({ name: 'x' });
    expect(b).toEqual({ name: 'x', constraints: { cutover_window: 'weekend' } });
    expect(getIn(b, ['constraints', 'cutover_window'])).toBe('weekend');
  });

  it('removes keys when the value is undefined, so empty optional fields leave the YAML', () => {
    const c = setIn({ cutover_strategy: 'phased', name: 'x' }, ['cutover_strategy'], undefined);
    expect(c).toEqual({ name: 'x' });
    expect('cutover_strategy' in c).toBe(false);
  });

  it('edits list items and nested objects in lists', () => {
    const base = { constraints: { freeze_periods: [{ start: '2026-12-20', end: '2027-01-02' }] } };
    const next = setIn(base, ['constraints', 'freeze_periods', 0, 'reason'], 'Year end');
    expect(getIn(next, ['constraints', 'freeze_periods', 0])).toEqual({
      start: '2026-12-20',
      end: '2027-01-02',
      reason: 'Year end',
    });
    expect(getIn(setIn(next, ['overrides', 1], { setting: 'a.b' }), ['overrides', 1])).toEqual({
      setting: 'a.b',
    });
  });

  it('starts new blueprints with a valid name and empty pack lists', () => {
    const bp = emptyBlueprint('Policy Admin Move 2027');
    expect(bp.apiVersion).toBe('astra.blueprints/v1');
    expect(bp.name).toBe('policy-admin-move-2027');
    expect(bp.domain_packs).toEqual([]);
    expect(slugify('A')).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(slugify('A').length).toBeGreaterThanOrEqual(3);
  });

  it('round-trips stream key/value rows with types', () => {
    const record = { batch_size: 500, dry_run: true, label: 'nightly', tags: ['a', 'b'] };
    const rows = recordToRows(record);
    expect(rows).toEqual([
      { key: 'batch_size', value: '500' },
      { key: 'dry_run', value: 'true' },
      { key: 'label', value: 'nightly' },
      { key: 'tags', value: '["a","b"]' },
    ]);
    expect(rowsToRecord(rows)).toEqual(record);
    expect(rowsToRecord([{ key: '', value: 'ignored' }])).toEqual({});
    expect(parseValueText('{not json')).toBe('{not json');
    expect(parseValueText('1.5')).toBe(1.5);
  });

  it('lists focus candidates from most to least specific', () => {
    expect(pathCandidates('constraints.freeze_periods[0].end')).toEqual([
      'constraints.freeze_periods[0].end',
      'constraints.freeze_periods[0]',
      'constraints.freeze_periods',
      'constraints',
    ]);
    expect(pathCandidates('name')).toEqual(['name']);
  });
});

const retention: ComposedSetting = {
  key: 'retention.records.years',
  stricter: 'higher',
  unit: 'years',
  conflict: false,
  strictest: 7,
  fingerprint: 'x',
  values: [{ pack: 'records@1.0.0', value: 7 }],
};

function validation(issues: BlueprintValidation['issues'] = []): BlueprintValidation {
  return {
    ok: issues.every((i) => i.severity !== 'blocking'),
    blocking: issues.filter((i) => i.severity === 'blocking').length,
    warnings: issues.filter((i) => i.severity !== 'blocking').length,
    issues,
    composition: { packs: [], controls: [], rules: [], settings: [retention], problems: [] },
    open_decisions: [],
  };
}

describe('override tighten / loosen badge', () => {
  const o = (value: unknown) => ({ setting: 'retention.records.years', value });

  it('uses the server issue for unapproved loosening', () => {
    const v = validation([
      {
        severity: 'blocking',
        code: 'override.loosening_unapproved',
        path: 'overrides[0]',
        message: 'loosens',
        fix: 'approve',
      },
    ]);
    expect(overrideStatus(o(5), 0, v)).toMatchObject({
      direction: 'loosen_pending',
      tone: 'danger',
    });
  });

  it('flags settings no selected pack defines', () => {
    const v = validation([
      {
        severity: 'warning',
        code: 'override.unknown_setting',
        path: 'overrides[1]',
        message: '',
        fix: '',
      },
    ]);
    expect(overrideStatus({ setting: 'x.y', value: 1 }, 1, v).direction).toBe('no_effect');
  });

  it('works out tightening, same and approved loosening from the composition', () => {
    const v = validation();
    expect(overrideStatus(o(10), 0, v)).toMatchObject({
      direction: 'tighten',
      label: 'Tightens',
      effective: 7,
    });
    expect(overrideStatus(o(7), 0, v).direction).toBe('same');
    expect(overrideStatus(o(5), 0, v).direction).toBe('loosen_approved');
    expect(overrideStatus(o(5), 0, undefined).direction).toBe('unknown');
  });
});

describe('approval progress', () => {
  const roleLabel = (k: string) =>
    ({ migration_lead: 'Migration lead', customer_data_owner: 'Customer data owner' })[k] ?? k;

  it('summarises who approved and who is pending', () => {
    const p = approvalProgress(
      ['migration_lead', 'customer_data_owner'],
      [
        {
          user_name: 'Fixture Lead',
          role: 'migration_lead',
          decision: 'approve',
          reason: '',
          decided_at: '2026-11-17T10:00:00Z',
        },
      ],
    );
    expect(p).toMatchObject({ approved: 1, total: 2, rejected: false });
    expect(approvalSummary(p, roleLabel)).toBe(
      '1 of 2 approvals: Migration lead ✓, Customer data owner pending',
    );
  });

  it('marks rejections', () => {
    const p = approvalProgress(
      ['migration_lead'],
      [
        {
          user_name: 'X',
          role: 'migration_lead',
          decision: 'reject',
          reason: 'r',
          decided_at: '2026-11-17T10:00:00Z',
        },
      ],
    );
    expect(p.rejected).toBe(true);
    expect(p.items[0]).toEqual({ role: 'migration_lead', status: 'rejected', by: 'X' });
  });

  it('requires a 10-character reason only to reject', () => {
    expect(decisionReasonError(true, '')).toBeUndefined();
    expect(decisionReasonError(false, 'too short')).toMatch(/10 characters/);
    expect(decisionReasonError(false, 'Missing the retention override')).toBeUndefined();
  });
});
