import { isApiError } from '@/api/errors';

/** Validation messages keyed by field name. */
export type FieldErrors<K extends string = string> = Partial<Record<K, string>>;

/**
 * Merges client-side validation (shown once the user has tried to submit) with the server's
 * 422 field errors. The server wins when both exist: it is the authority.
 */
export function mergeFieldErrors<K extends string>(
  client: FieldErrors<K>,
  serverError: unknown,
  showClient: boolean,
): FieldErrors<K> {
  const server = isApiError(serverError) ? (serverError.fieldErrors as FieldErrors<K>) : {};
  return { ...(showClient ? client : {}), ...server };
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.values(errors).some(Boolean);
}

export const MIN_REASON_LENGTH = 10;

/** Shared rule for audited actions that need a written reason. */
export function reasonError(reason: string, min = MIN_REASON_LENGTH): string | undefined {
  const length = reason.trim().length;
  if (length === 0) return 'Give a reason. It is recorded in the audit log.';
  if (length < min) return `Write at least ${min} characters (${length} so far).`;
  return undefined;
}
