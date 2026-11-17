import { describe, expect, it } from 'vitest';
import {
  formatMinutes,
  isLoosening,
  regionMoveError,
  regionMoveTables,
  validateCreateTenant,
  validatePolicy,
  validateSecret,
  type CreateTenantForm,
} from './model';

const validCreate: CreateTenantForm = {
  slug: 'acme-test',
  name: 'Fixture tenant',
  region_code: 'local-a',
  programme_id: '',
  partner_id: '',
  mfa_required: true,
  session_timeout_minutes: '480',
};

describe('validateCreateTenant', () => {
  it('accepts a valid form', () => {
    expect(validateCreateTenant(validCreate)).toEqual({});
  });

  it.each(['abc', 'Acme', '1acme', 'acme-', 'acme_test', 'a'.repeat(33)])(
    'rejects slug %s',
    (slug) => {
      expect(validateCreateTenant({ ...validCreate, slug }).slug).toBeDefined();
    },
  );

  it('requires a region and a timeout between 5 and 1440', () => {
    const errors = validateCreateTenant({
      ...validCreate,
      region_code: '',
      session_timeout_minutes: '1441',
    });
    expect(errors.region_code).toBeDefined();
    expect(errors.session_timeout_minutes).toMatch(/5 and 1440/);
    expect(
      validateCreateTenant({ ...validCreate, session_timeout_minutes: '4' })
        .session_timeout_minutes,
    ).toBeDefined();
    expect(
      validateCreateTenant({ ...validCreate, session_timeout_minutes: '7.5' })
        .session_timeout_minutes,
    ).toBeDefined();
  });
});

describe('policy loosening', () => {
  const current = { mfa_required: true, session_timeout_minutes: 480 };

  it('treats turning MFA off or a longer timeout as loosening', () => {
    expect(isLoosening(current, { mfa_required: false, session_timeout_minutes: 480 })).toBe(true);
    expect(isLoosening(current, { mfa_required: true, session_timeout_minutes: 481 })).toBe(true);
  });

  it('does not treat tightening or no change as loosening', () => {
    expect(isLoosening(current, { mfa_required: true, session_timeout_minutes: 60 })).toBe(false);
    expect(isLoosening(current, current)).toBe(false);
    expect(
      isLoosening(
        { mfa_required: false, session_timeout_minutes: 60 },
        { mfa_required: true, session_timeout_minutes: 60 },
      ),
    ).toBe(false);
  });

  it('requires a reason of at least 10 characters only when loosening', () => {
    const loosen = validatePolicy(current, {
      mfa_required: false,
      session_timeout_minutes: '480',
      reason: 'short',
    });
    expect(loosen.loosening).toBe(true);
    expect(loosen.errors.reason).toMatch(/at least 10/);

    const ok = validatePolicy(current, {
      mfa_required: false,
      session_timeout_minutes: '480',
      reason: 'Vendor kiosk accounts cannot use a second factor',
    });
    expect(ok.errors).toEqual({});

    const tighten = validatePolicy(current, {
      mfa_required: true,
      session_timeout_minutes: '60',
      reason: '',
    });
    expect(tighten.loosening).toBe(false);
    expect(tighten.changed).toBe(true);
    expect(tighten.errors).toEqual({});
  });

  it('reports unchanged forms', () => {
    expect(
      validatePolicy(current, { mfa_required: true, session_timeout_minutes: '480', reason: '' })
        .changed,
    ).toBe(false);
  });
});

describe('region move detail', () => {
  it('reads per-table counts and errors defensively', () => {
    expect(
      regionMoveTables({ tables: { b: { source: 2, target: 2 }, a: { source: 5, target: 4 } } }),
    ).toEqual([
      { table: 'a', source: 5, target: 4 },
      { table: 'b', source: 2, target: 2 },
    ]);
    expect(regionMoveTables({})).toEqual([]);
    expect(regionMoveTables({ tables: 'nope' })).toEqual([]);
    expect(regionMoveError({ error: 'Row count mismatch in a: 5 vs 4' })).toMatch(/mismatch/);
    expect(regionMoveError({})).toBeNull();
  });
});

describe('formatMinutes', () => {
  it('formats durations', () => {
    expect(formatMinutes(480)).toBe('8 hours');
    expect(formatMinutes(90)).toBe('1 hour 30 minutes');
    expect(formatMinutes(5)).toBe('5 minutes');
  });
});

describe('validateSecret', () => {
  it('mirrors the API name rule and requires a value', () => {
    expect(validateSecret({ name: 'erp-db', description: '', value: 'x' })).toEqual({});
    expect(validateSecret({ name: 'ab', description: '', value: 'x' }).name).toBeDefined();
    expect(validateSecret({ name: 'Erp', description: '', value: 'x' }).name).toBeDefined();
    expect(validateSecret({ name: 'erp-db', description: '', value: '' }).value).toBeDefined();
  });
});
