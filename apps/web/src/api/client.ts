import { ApiError, SESSION_EXPIRED_TYPE_SUFFIX, toProblem } from './errors';

/** Every API call is same-origin under this prefix. Vite proxies it in development. */
export const API_BASE = '/api/v1';

/**
 * Bridges the API client to the auth layer without importing it, which keeps the client
 * framework-free and easy to test. AuthProvider registers these on mount.
 */
export interface ApiAuthHandlers {
  /** Current access token, or null when signed out. */
  getAccessToken: () => Promise<string | null>;
  /** Tries to obtain a fresh access token (refresh-token grant). Resolves true on success. */
  refresh: () => Promise<boolean>;
  /** The API rejected the session and a refresh did not help. */
  onUnauthorized: () => void;
}

let authHandlers: ApiAuthHandlers | null = null;

export function configureApiAuth(handlers: ApiAuthHandlers | null): () => void {
  authHandlers = handlers;
  return () => {
    if (authHandlers === handlers) authHandlers = null;
  };
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  method?: HttpMethod;
  /** Serialised as JSON unless it is FormData, Blob or a string. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Attach the bearer token (default true). */
  auth?: boolean;
  /**
   * Non-2xx statuses whose body is a normal response for this endpoint rather than a problem
   * (for example a health endpoint answering 503 with its usual payload).
   */
  acceptStatuses?: readonly number[];
}

function buildUrl(path: string): string {
  if (!path.startsWith('/')) throw new Error(`API paths must start with "/": ${path}`);
  return `${API_BASE}${path}`;
}

function encodeBody(body: unknown, headers: Headers): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (body instanceof FormData || body instanceof Blob || typeof body === 'string') return body;
  headers.set('Content-Type', 'application/json');
  return JSON.stringify(body);
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  const contentType = response.headers.get('Content-Type') ?? '';
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

async function send(
  path: string,
  options: RequestOptions,
  token: string | null,
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json, application/problem+json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers,
    credentials: 'same-origin',
  };
  const body = encodeBody(options.body, headers);
  if (body !== undefined) init.body = body;
  if (options.signal) init.signal = options.signal;
  try {
    return await fetch(buildUrl(path), init);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw ApiError.network(cause);
  }
}

/**
 * A tenant's own session timeout answers 401 /problems/session-expired. Refreshing the token does
 * not help (the original sign-in time is what counts) and the rest of the app still works, so
 * that case is surfaced to the screen instead of ending the whole session.
 */
async function isTenantSessionExpiry(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.clone().json();
    return (
      typeof body === 'object' &&
      body !== null &&
      'type' in body &&
      typeof body.type === 'string' &&
      body.type.endsWith(SESSION_EXPIRED_TYPE_SUFFIX)
    );
  } catch {
    return false;
  }
}

/** Query parameters: undefined, null and empty strings are omitted. */
export type QueryParams = Record<string, string | number | boolean | null | undefined>;

/** Appends a query string to an API path. */
export function withQuery(path: string, params: QueryParams = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * Typed fetch wrapper for the Astra Migrate API.
 *
 * - Attaches the access token as a Bearer header.
 * - On 401, tries one token refresh and retries once; if that fails the auth layer is told the
 *   session is gone (toast + redirect to sign-in).
 * - Non-2xx responses throw ApiError built from the RFC 9457 problem body.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const useAuth = options.auth !== false;
  const token = useAuth && authHandlers ? await authHandlers.getAccessToken() : null;
  let response = await send(path, options, token);

  if (
    response.status === 401 &&
    useAuth &&
    authHandlers &&
    !(await isTenantSessionExpiry(response))
  ) {
    const refreshed = await authHandlers.refresh().catch(() => false);
    if (refreshed) {
      response = await send(path, options, await authHandlers.getAccessToken());
    }
    if (response.status === 401) authHandlers.onUnauthorized();
  }

  const body = await readBody(response);
  if (response.ok || options.acceptStatuses?.includes(response.status)) {
    return body as T;
  }
  throw new ApiError(toProblem(body, response.status, response.statusText));
}

export interface DownloadResult {
  blob: Blob;
  /** From Content-Disposition, or the fallback. */
  filename: string;
}

/** Parses the filename from a Content-Disposition header (RFC 6266, incl. filename*). */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // fall through to the plain parameter
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() ?? fallback;
}

/**
 * Authenticated file download (e.g. audit export). Same auth, refresh and problem handling as
 * apiRequest, but returns the body as a Blob plus the server's filename.
 */
export async function apiDownload(path: string, fallbackName: string): Promise<DownloadResult> {
  const token = authHandlers ? await authHandlers.getAccessToken() : null;
  let response = await send(path, {}, token);
  if (response.status === 401 && authHandlers && !(await isTenantSessionExpiry(response))) {
    const refreshed = await authHandlers.refresh().catch(() => false);
    if (refreshed) response = await send(path, {}, await authHandlers.getAccessToken());
    if (response.status === 401) authHandlers.onUnauthorized();
  }
  if (!response.ok) {
    throw new ApiError(toProblem(await readBody(response), response.status, response.statusText));
  }
  return {
    blob: await response.blob(),
    filename: filenameFromDisposition(response.headers.get('Content-Disposition'), fallbackName),
  };
}

/** Saves a Blob through a temporary object URL. */
export function saveBlob({ blob, filename }: DownloadResult): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'DELETE' }),
};
