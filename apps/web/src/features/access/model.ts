import type { Assignment, Programme, RoleDef, ScopeType, Tenant, UserStatus } from '@/api/types';
import type { SelectOption, Tone } from '@/ui';

export const USER_STATUS: Record<UserStatus, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'success' },
  invited: { label: 'Invited', tone: 'info' },
  disabled: { label: 'Disabled', tone: 'neutral' },
};

export const SCOPE_LABELS: Record<ScopeType, string> = {
  platform: 'Platform',
  programme: 'Programme',
  partner: 'Partner',
  tenant: 'Tenant',
  project: 'Project',
};

/** "Migration lead · Northwind tenant" style label for an assignment. */
export function assignmentLabel(a: Pick<Assignment, 'role_label' | 'scope_type' | 'scope_name'>) {
  const scope = a.scope_name ?? SCOPE_LABELS[a.scope_type];
  return `${a.role_label} · ${scope}`;
}

/**
 * Scope types a role may be granted at, in a stable order. Project grants are not offered yet:
 * the API rejects them until projects exist.
 */
export function grantableScopes(role: RoleDef | undefined): ScopeType[] {
  if (!role) return [];
  const order: ScopeType[] = ['platform', 'programme', 'partner', 'tenant'];
  return order.filter((scope) => role.allowed_scopes.includes(scope));
}

/** Options for the scope picker, given the scope type. Platform has no scope id. */
export function scopeOptions(
  scopeType: ScopeType | '',
  programmes: readonly Programme[],
  tenants: readonly Tenant[],
): SelectOption[] {
  switch (scopeType) {
    case 'programme':
      return programmes.map((p) => ({ value: p.id, label: p.name }));
    case 'partner':
      return programmes.flatMap((p) =>
        p.partners.map((partner) => ({ value: partner.id, label: `${partner.name} · ${p.name}` })),
      );
    case 'tenant':
      return tenants.map((t) => ({ value: t.id, label: `${t.name} (${t.slug})` }));
    default:
      return [];
  }
}
