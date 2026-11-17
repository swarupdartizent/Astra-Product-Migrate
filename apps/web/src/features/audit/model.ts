import type { ActorType, AuditFilters } from '@/api/types';
import type { Tone } from '@/ui';

export const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  success: { label: 'Success', tone: 'success' },
  denied: { label: 'Denied', tone: 'warning' },
  failure: { label: 'Failure', tone: 'danger' },
};

export function outcome(value: string): { label: string; tone: Tone } {
  return OUTCOME[value] ?? { label: value, tone: 'neutral' };
}

export const ACTOR_TYPES: readonly ActorType[] = ['user', 'agent', 'system'];

export interface AuditFilterForm {
  tenant_id: string;
  actor_type: ActorType | '';
  action: string;
  /** Value of <input type="datetime-local">, in the viewer's local time. */
  since: string;
  until: string;
}

export const EMPTY_FILTERS: AuditFilterForm = {
  tenant_id: '',
  actor_type: '',
  action: '',
  since: '',
  until: '',
};

/** datetime-local (local wall time) → ISO 8601 UTC, or undefined when empty/invalid. */
export function localToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Turns the form into API query filters, dropping empty values. */
export function toApiFilters(form: AuditFilterForm): AuditFilters {
  const filters: AuditFilters = {};
  if (form.tenant_id) filters.tenant_id = form.tenant_id;
  if (form.actor_type) filters.actor_type = form.actor_type;
  const action = form.action.trim();
  if (action) filters.action = action;
  const since = localToIso(form.since);
  if (since) filters.since = since;
  const until = localToIso(form.until);
  if (until) filters.until = until;
  return filters;
}

export function rangeError(form: AuditFilterForm): string | undefined {
  const since = localToIso(form.since);
  const until = localToIso(form.until);
  if (since && until && since > until) return 'The start must be before the end.';
  return undefined;
}
