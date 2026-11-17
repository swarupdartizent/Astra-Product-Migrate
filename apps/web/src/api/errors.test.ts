import { describe, expect, it } from 'vitest';
import { ApiError, classifyProblem, toProblem } from './errors';

describe('classifyProblem', () => {
  it('maps 403 with an mfa-required type to mfa_required', () => {
    expect(
      classifyProblem({
        type: 'https://errors.example.test/mfa-required',
        title: 'MFA',
        status: 403,
      }),
    ).toBe('mfa_required');
  });

  it('maps other 403s to forbidden', () => {
    expect(classifyProblem({ type: 'about:blank', title: 'Forbidden', status: 403 })).toBe(
      'forbidden',
    );
  });

  it.each([
    [401, 'unauthorized'],
    [404, 'not_found'],
    [409, 'conflict'],
    [422, 'validation'],
    [429, 'rate_limited'],
    [503, 'server'],
    [418, 'client'],
  ] as const)('maps %i to %s', (status, kind) => {
    expect(classifyProblem({ type: 'about:blank', title: 't', status })).toBe(kind);
  });
});

describe('toProblem', () => {
  it('keeps RFC 9457 members including errors', () => {
    const problem = toProblem(
      {
        type: '/problems/validation',
        title: 'Invalid',
        status: 422,
        detail: 'Bad',
        errors: [{ a: 1 }],
      },
      422,
      'Unprocessable Content',
    );
    expect(problem).toEqual({
      type: '/problems/validation',
      title: 'Invalid',
      status: 422,
      detail: 'Bad',
      instance: null,
      errors: [{ a: 1 }],
    });
  });

  it('builds a problem from a non-JSON body using the real status', () => {
    expect(toProblem('<html>Bad gateway</html>', 502, 'Bad Gateway')).toMatchObject({
      type: 'about:blank',
      title: 'Bad Gateway',
      status: 502,
    });
  });
});

describe('ApiError', () => {
  it('treats network and 5xx failures as retryable, 4xx as final', () => {
    expect(ApiError.network(new TypeError('fetch failed')).isRetryable).toBe(true);
    expect(new ApiError({ type: 'about:blank', title: 'x', status: 500 }).isRetryable).toBe(true);
    expect(new ApiError({ type: 'about:blank', title: 'x', status: 403 }).isRetryable).toBe(false);
  });
});
