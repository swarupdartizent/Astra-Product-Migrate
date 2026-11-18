import type { Page, Route } from '@playwright/test';

/**
 * E2E test support. Everything here is a TEST FIXTURE: the browser gets a synthetic signed-in
 * session and the API is answered by `page.route` with fixture JSON, so key flows can be checked
 * without the identity provider or the backend. The product itself never uses this.
 */

const AUTHORITY = process.env.VITE_OIDC_AUTHORITY ?? 'http://localhost:18080/realms/astra';
const CLIENT_ID = process.env.VITE_OIDC_CLIENT_ID ?? 'astra-web';

/** Puts a synthetic, unexpired OIDC user in sessionStorage before the app loads. */
export async function signInWithFixtureSession(page: Page): Promise<void> {
  const user = {
    id_token: 'fixture.id.token',
    access_token: 'fixture-access-token',
    token_type: 'Bearer',
    scope: 'openid profile email',
    profile: {
      sub: 'fixture-subject',
      iss: AUTHORITY,
      aud: CLIENT_ID,
      name: 'Fixture User',
      email: 'fixture.user@example.test',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };
  await page.addInitScript(
    ({ key, value }) => {
      // Runs in the browser page.
      (
        globalThis as unknown as { sessionStorage: { setItem: (k: string, v: string) => void } }
      ).sessionStorage.setItem(key, value);
    },
    { key: `oidc.user:${AUTHORITY}:${CLIENT_ID}`, value: JSON.stringify(user) },
  );
}

export type FixtureHandler = (route: Route, body: unknown) => unknown;

/** "GET /api/v1/me" or "/api/v1/me" (any method) → JSON body, or a handler function. */
export type ApiFixtures = Record<string, unknown>;

/** Answers /api/v1 requests from fixtures; anything unknown gets a 404 problem. */
export async function mockApi(
  page: Page,
  fixtures: ApiFixtures,
): Promise<{ requests: { method: string; path: string; body: unknown }[] }> {
  const requests: { method: string; path: string; body: unknown }[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = req.postData();
    }
    requests.push({ method, path: url.pathname, body });
    const fixture = fixtures[`${method} ${url.pathname}`] ?? fixtures[url.pathname];
    if (fixture === undefined) {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: '/problems/not-found',
          title: 'Not found (no fixture)',
          status: 404,
        }),
      });
      return;
    }
    const value =
      typeof fixture === 'function' ? (fixture as FixtureHandler)(route, body) : fixture;
    if (value && typeof value === 'object' && 'status' in value && '__problem' in value) {
      const { __problem: _ignored, ...problem } = value as Record<string, unknown>;
      await route.fulfill({
        status: Number(problem.status),
        contentType: 'application/problem+json',
        body: JSON.stringify(problem),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(value),
    });
  });
  return { requests };
}

export function me(permissions: string[]) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'fixture.user@example.test',
    display_name: 'Fixture User',
    mfa: true,
    roles: [
      {
        role: 'platform_admin',
        role_label: 'Platform administrator',
        scope_type: 'platform',
        scope_id: null,
        scope_name: 'Whole platform',
      },
    ],
    permissions,
  };
}
