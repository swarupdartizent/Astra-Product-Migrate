import type { Tenant } from '@/api/types';
import { reasonError, type FieldErrors } from '@/lib/forms';
import type { Tone } from '@/ui';

// ---------- Detail tabs ----------

export const TENANT_TABS = [
  'overview',
  'projects',
  'policy',
  'secrets',
  'sources',
  'targets',
  'region',
  'danger',
] as const;
export type TenantTab = (typeof TENANT_TABS)[number];

// ---------- Status ----------

const STATUS: Record<string, { label: string; tone: Tone; busy: boolean }> = {
  provisioning: { label: 'Provisioning', tone: 'info', busy: true },
  active: { label: 'Active', tone: 'success', busy: false },
  migrating: { label: 'Moving region', tone: 'info', busy: true },
  deleting: { label: 'Deleting', tone: 'warning', busy: true },
  deleted: { label: 'Deleted', tone: 'neutral', busy: false },
  failed: { label: 'Failed', tone: 'danger', busy: false },
};

export function tenantStatus(status: string): { label: string; tone: Tone; busy: boolean } {
  return STATUS[status] ?? { label: status, tone: 'neutral', busy: false };
}

export function can(tenant: Pick<Tenant, 'permissions'>, permission: string): boolean {
  return tenant.permissions.includes(permission);
}

// ---------- Create ----------

/** Mirrors the API rule: 4–32 chars, lowercase letters, digits, hyphens; starts with a letter. */
export const SLUG_PATTERN = /^[a-z][a-z0-9-]{2,30}[a-z0-9]$/;

export const TIMEOUT_MIN = 5;
export const TIMEOUT_MAX = 1440;
export const TIMEOUT_DEFAULT = 480;

export interface CreateTenantForm {
  slug: string;
  name: string;
  region_code: string;
  programme_id: string;
  partner_id: string;
  mfa_required: boolean;
  session_timeout_minutes: string;
}

export function timeoutError(value: string): string | undefined {
  if (!/^\d+$/.test(value.trim())) return 'Enter a whole number of minutes.';
  const n = Number(value);
  if (n < TIMEOUT_MIN || n > TIMEOUT_MAX) {
    return `Use between ${TIMEOUT_MIN} and ${TIMEOUT_MAX} minutes (24 hours).`;
  }
  return undefined;
}

export function validateCreateTenant(form: CreateTenantForm): FieldErrors<keyof CreateTenantForm> {
  const errors: FieldErrors<keyof CreateTenantForm> = {};
  if (!SLUG_PATTERN.test(form.slug)) {
    errors.slug =
      'Use 4–32 characters: lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen.';
  }
  const name = form.name.trim();
  if (name.length < 2 || name.length > 200) errors.name = 'Use 2–200 characters.';
  if (!form.region_code) errors.region_code = 'Choose a region.';
  const timeout = timeoutError(form.session_timeout_minutes);
  if (timeout) errors.session_timeout_minutes = timeout;
  return errors;
}

// ---------- Security policy ----------

export interface PolicyValues {
  mfa_required: boolean;
  session_timeout_minutes: number;
}

/**
 * True when the change weakens the policy: turning multi-factor sign-in off or lengthening the
 * session timeout. Same rule as the API, which then requires a reason of 10+ characters.
 */
export function isLoosening(current: PolicyValues, next: PolicyValues): boolean {
  return (
    (current.mfa_required && !next.mfa_required) ||
    next.session_timeout_minutes > current.session_timeout_minutes
  );
}

export interface PolicyForm {
  mfa_required: boolean;
  session_timeout_minutes: string;
  reason: string;
}

export function validatePolicy(
  current: PolicyValues,
  form: PolicyForm,
): { errors: FieldErrors<keyof PolicyForm>; loosening: boolean; changed: boolean } {
  const errors: FieldErrors<keyof PolicyForm> = {};
  const timeout = timeoutError(form.session_timeout_minutes);
  if (timeout) errors.session_timeout_minutes = timeout;
  const next: PolicyValues = {
    mfa_required: form.mfa_required,
    session_timeout_minutes: timeout
      ? current.session_timeout_minutes
      : Number(form.session_timeout_minutes),
  };
  const loosening = !timeout && isLoosening(current, next);
  if (loosening) {
    const reason = reasonError(form.reason);
    if (reason) errors.reason = reason;
  }
  const changed =
    next.mfa_required !== current.mfa_required ||
    next.session_timeout_minutes !== current.session_timeout_minutes ||
    Boolean(timeout);
  return { errors, loosening, changed };
}

/** "8 hours", "1 hour 30 minutes", "45 minutes". */
export function formatMinutes(total: number): string {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (minutes || !hours) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  return parts.join(' ');
}

// ---------- Region moves ----------

export interface TableCount {
  table: string;
  source: number;
  target: number;
}

/** Reads detail.tables ({ name: {source, target} }) defensively; the API types detail loosely. */
export function regionMoveTables(detail: Record<string, unknown>): TableCount[] {
  const tables = detail.tables;
  if (typeof tables !== 'object' || tables === null) return [];
  return Object.entries(tables as Record<string, unknown>)
    .map(([table, value]) => {
      const v = (value ?? {}) as { source?: unknown; target?: unknown };
      return {
        table,
        source: typeof v.source === 'number' ? v.source : NaN,
        target: typeof v.target === 'number' ? v.target : NaN,
      };
    })
    .sort((a, b) => a.table.localeCompare(b.table));
}

/** Region moves run as background jobs; detail.job_id names the job. */
export function regionMoveJobId(detail: Record<string, unknown>): string | null {
  return typeof detail.job_id === 'string' && detail.job_id ? detail.job_id : null;
}

export function regionMoveError(detail: Record<string, unknown>): string | null {
  return typeof detail.error === 'string' && detail.error ? detail.error : null;
}

// ---------- Connector secrets ----------

/** Mirrors the API rule for connector secret names. */
export const SECRET_NAME_PATTERN = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;

export interface SecretForm {
  name: string;
  description: string;
  value: string;
}

export function validateSecret(form: SecretForm): FieldErrors<keyof SecretForm> {
  const errors: FieldErrors<keyof SecretForm> = {};
  if (!SECRET_NAME_PATTERN.test(form.name)) {
    errors.name =
      'Use 3–64 characters: lowercase letters, digits and hyphens, starting with a letter.';
  }
  if (form.description.length > 500) errors.description = 'Use at most 500 characters.';
  if (!form.value) errors.value = 'Enter the secret value.';
  else if (form.value.length > 8192) errors.value = 'Use at most 8192 characters.';
  return errors;
}
