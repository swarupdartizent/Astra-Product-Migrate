import { describe, expect, it } from 'vitest';
import type { Programme, RoleDef, Tenant } from '@/api/types';
import { assignmentLabel, grantableScopes, scopeOptions } from './model';

const role = (allowed: RoleDef['allowed_scopes']): RoleDef => ({
  key: 'fixture_role',
  label: 'Fixture role',
  description: '',
  permissions: [],
  allowed_scopes: allowed,
});

describe('grant role model', () => {
  it('offers only the role’s allowed scopes and never project grants', () => {
    expect(grantableScopes(role(['platform']))).toEqual(['platform']);
    expect(grantableScopes(role(['tenant', 'project', 'programme']))).toEqual([
      'programme',
      'tenant',
    ]);
    expect(grantableScopes(undefined)).toEqual([]);
  });

  it('builds scope options for each scope type', () => {
    const programmes: Programme[] = [
      {
        id: 'p1',
        name: 'Programme one',
        description: '',
        partners: [{ id: 'x1', name: 'Partner X' }],
      },
    ];
    const tenants = [{ id: 't1', name: 'Tenant one', slug: 'tenant-one' }] as Tenant[];
    expect(scopeOptions('programme', programmes, tenants)).toEqual([
      { value: 'p1', label: 'Programme one' },
    ]);
    expect(scopeOptions('partner', programmes, tenants)).toEqual([
      { value: 'x1', label: 'Partner X · Programme one' },
    ]);
    expect(scopeOptions('tenant', programmes, tenants)).toEqual([
      { value: 't1', label: 'Tenant one (tenant-one)' },
    ]);
    expect(scopeOptions('platform', programmes, tenants)).toEqual([]);
  });

  it('labels assignments as "Role · scope"', () => {
    expect(
      assignmentLabel({ role_label: 'Auditor', scope_type: 'tenant', scope_name: 'Tenant one' }),
    ).toBe('Auditor · Tenant one');
    expect(
      assignmentLabel({ role_label: 'Auditor', scope_type: 'platform', scope_name: null }),
    ).toBe('Auditor · Platform');
  });
});
