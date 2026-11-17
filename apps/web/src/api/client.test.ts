import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '@/test/utils';
import {
  api,
  configureApiAuth,
  filenameFromDisposition,
  withQuery,
  type ApiAuthHandlers,
} from './client';
import { ApiError } from './errors';

const fetchMock = vi.fn<typeof fetch>();

function handlers(overrides: Partial<ApiAuthHandlers> = {}): ApiAuthHandlers {
  return {
    getAccessToken: vi.fn(() => Promise.resolve('token-1')),
    refresh: vi.fn(() => Promise.resolve(false)),
    onUnauthorized: vi.fn(),
    ...overrides,
  };
}

function headerOf(call: number, name: string): string | null {
  const init = fetchMock.mock.calls[call]?.[1];
  return new Headers(init?.headers).get(name);
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  configureApiAuth(null);
});

describe('api client', () => {
  it('calls same-origin /api/v1 paths with the bearer token', async () => {
    configureApiAuth(handlers());
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: '1' }));

    await expect(api.get('/me')).resolves.toEqual({ id: '1' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/me');
    expect(headerOf(0, 'Authorization')).toBe('Bearer token-1');
  });

  it('omits the token when auth is false', async () => {
    configureApiAuth(handlers());
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));
    await api.get('/health', { auth: false });
    expect(headerOf(0, 'Authorization')).toBeNull();
  });

  it('throws a typed ApiError for problem+json responses', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          type: 'https://astra.example.test/problems/mfa-required',
          title: 'MFA required',
          status: 403,
        },
        403,
        'application/problem+json',
      ),
    );
    const error = await api.get('/me').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('mfa_required');
    expect((error as ApiError).status).toBe(403);
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    const getAccessToken = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce('stale')
      .mockResolvedValueOnce('fresh');
    const auth = handlers({ getAccessToken, refresh: vi.fn(() => Promise.resolve(true)) });
    configureApiAuth(auth);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ type: 'about:blank', title: 'Unauthorized', status: 401 }, 401),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(api.get('/me')).resolves.toEqual({ ok: true });
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    expect(headerOf(1, 'Authorization')).toBe('Bearer fresh');
    expect(auth.onUnauthorized).not.toHaveBeenCalled();
  });

  it('reports the session as gone when refresh fails', async () => {
    const auth = handlers();
    configureApiAuth(auth);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ type: 'about:blank', title: 'Unauthorized', status: 401 }, 401),
    );
    const error = await api.get('/me').catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe('unauthorized');
    expect(auth.onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('turns fetch failures into a network ApiError', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const error = await api.get('/health', { auth: false }).catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe('network');
  });

  it('accepts listed non-2xx statuses as data', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 'degraded', version: '1.0.0', checks: [] }, 503),
    );
    await expect(api.get('/health', { auth: false, acceptStatuses: [503] })).resolves.toMatchObject(
      {
        status: 'degraded',
      },
    );
  });

  it('does not end the session for a tenant session-expiry 401', async () => {
    const auth = handlers({ refresh: vi.fn(() => Promise.resolve(true)) });
    configureApiAuth(auth);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          type: '/problems/session-expired',
          title: 'Your session has expired for this tenant',
          status: 401,
        },
        401,
        'application/problem+json',
      ),
    );
    const error = await api.get('/tenants/x').catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe('session_expired');
    expect(auth.refresh).not.toHaveBeenCalled();
    expect(auth.onUnauthorized).not.toHaveBeenCalled();
  });

  it('exposes 422 field errors keyed by field', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          type: '/problems/validation',
          title: 'Some fields need attention',
          status: 422,
          errors: [
            { field: 'slug', message: 'String should have at least 4 characters' },
            { field: 'slug', message: 'second message ignored' },
            {
              field: 'session_timeout_minutes',
              message: 'Input should be less than or equal to 1440',
            },
          ],
        },
        422,
        'application/problem+json',
      ),
    );
    const error = (await api.post('/tenants', {}).catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('validation');
    expect(error.fieldErrors).toEqual({
      slug: 'String should have at least 4 characters',
      session_timeout_minutes: 'Input should be less than or equal to 1440',
    });
  });
});

describe('helpers', () => {
  it('builds query strings without empty values', () => {
    expect(
      withQuery('/audit', { tenant_id: undefined, action: '', limit: 100, before_seq: null }),
    ).toBe('/audit?limit=100');
    expect(withQuery('/users', { q: 'a b' })).toBe('/users?q=a+b');
    expect(withQuery('/users')).toBe('/users');
  });

  it('reads filenames from Content-Disposition', () => {
    expect(filenameFromDisposition('attachment; filename="audit-20261117.csv"', 'x')).toBe(
      'audit-20261117.csv',
    );
    expect(filenameFromDisposition("attachment; filename*=UTF-8''audit%20log.jsonl", 'x')).toBe(
      'audit log.jsonl',
    );
    expect(filenameFromDisposition(null, 'fallback.csv')).toBe('fallback.csv');
  });
});
