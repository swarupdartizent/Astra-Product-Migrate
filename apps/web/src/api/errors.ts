import type { ProblemDetails, ProblemFieldError } from './types';

/**
 * How the UI should react to an error. Derived from HTTP status and problem type.
 * - unauthorized: no valid session; the client re-authenticates.
 * - session_expired: the sign-in is older than a tenant's session timeout; only that tenant's
 *   requests fail, so the user is asked to sign in again rather than being signed out.
 * - mfa_required: the session is valid but the action needs a multi-factor sign-in.
 * - forbidden: the user lacks permission.
 * - network: the request never got a response (API down, offline, proxy error).
 */
export type ApiErrorKind =
  | 'unauthorized'
  | 'session_expired'
  | 'mfa_required'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'invalid_response'
  | 'client';

export const MFA_REQUIRED_TYPE_SUFFIX = '/mfa-required';
export const SESSION_EXPIRED_TYPE_SUFFIX = '/session-expired';

export function classifyProblem(problem: ProblemDetails): ApiErrorKind {
  const { status, type } = problem;
  if (status === 401) {
    return type.endsWith(SESSION_EXPIRED_TYPE_SUFFIX) ? 'session_expired' : 'unauthorized';
  }
  if (status === 403) return type.endsWith(MFA_REQUIRED_TYPE_SUFFIX) ? 'mfa_required' : 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'validation';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'client';
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails, kind: ApiErrorKind = classifyProblem(problem)) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.problem = problem;
    this.status = problem.status;
    this.kind = kind;
  }

  get title(): string {
    return this.problem.title;
  }

  get detail(): string | null {
    return this.problem.detail ?? null;
  }

  /** Field-level validation messages keyed by request field (empty when there are none). */
  get fieldErrors(): Record<string, string> {
    return fieldErrorsOf(this.problem.errors);
  }

  /** Errors worth retrying automatically: transient server/network failures. */
  get isRetryable(): boolean {
    return this.kind === 'network' || this.kind === 'rate_limited' || this.status >= 500;
  }

  static network(cause: unknown): ApiError {
    const err = new ApiError(
      {
        type: 'about:blank',
        title: 'Cannot reach the Astra Migrate API',
        status: 0,
        detail:
          'The request did not get a response. The API may be down or your connection may have dropped.',
      },
      'network',
    );
    (err as { cause?: unknown }).cause = cause;
    return err;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalises any error body into ProblemDetails. Non-conforming bodies (HTML from a proxy,
 * empty bodies) still produce a usable problem with the real status code.
 */
export function toProblem(body: unknown, status: number, statusText: string): ProblemDetails {
  if (isRecord(body)) {
    const title = typeof body.title === 'string' && body.title ? body.title : null;
    const problem: ProblemDetails = {
      type: typeof body.type === 'string' && body.type ? body.type : 'about:blank',
      title: title ?? (statusText || `Request failed with status ${status}`),
      status: typeof body.status === 'number' ? body.status : status,
      detail: typeof body.detail === 'string' ? body.detail : null,
      instance: typeof body.instance === 'string' ? body.instance : null,
    };
    if ('errors' in body) problem.errors = body.errors;
    return problem;
  }
  return {
    type: 'about:blank',
    title: statusText || `Request failed with status ${status}`,
    status,
    detail: null,
    instance: null,
  };
}

function isFieldError(value: unknown): value is ProblemFieldError {
  return isRecord(value) && typeof value.field === 'string' && typeof value.message === 'string';
}

/**
 * Maps a problem's `errors: [{field, message}]` onto form fields. The first message per field
 * wins. Unknown shapes produce an empty map.
 */
export function fieldErrorsOf(errors: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(errors)) return out;
  for (const item of errors) {
    if (isFieldError(item) && !(item.field in out)) out[item.field] = item.message;
  }
  return out;
}
