import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Health, Me } from '@/api/types';
import { jsonResponse, renderWithProviders } from '@/test/utils';
import { HomePage } from './HomePage';

// Test fixtures only: shapes follow the /api/v1 contract; values are synthetic.
const me: Me = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'fixture.user@example.test',
  display_name: 'Fixture User',
  mfa: false,
  roles: [
    {
      role: 'platform_admin',
      role_label: 'Platform administrator',
      scope_type: 'platform',
      scope_id: null,
      scope_name: null,
    },
  ],
  permissions: [],
};

const health: Health = {
  status: 'ok',
  version: '0.0.0-test',
  checks: [{ name: 'control_db', status: 'ok', detail: null }],
};

const fetchMock = vi.fn<typeof fetch>();

function route(handlers: Record<string, () => Response | Promise<Response>>) {
  fetchMock.mockImplementation((input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const handler = handlers[url];
    return handler ? Promise.resolve(handler()) : Promise.reject(new TypeError('Failed to fetch'));
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('HomePage', () => {
  it('greets the user and lists role assignments and platform status from the API', async () => {
    route({
      '/api/v1/me': () => jsonResponse(me),
      '/api/v1/health': () => jsonResponse(health),
    });
    renderWithProviders(<HomePage />);

    expect(
      await screen.findByRole('heading', { level: 1, name: /Fixture User/ }),
    ).toBeInTheDocument();
    const roles = await screen.findByRole('table', { name: 'Your role assignments' });
    expect(within(roles).getByText('Platform administrator')).toBeInTheDocument();
    expect(within(roles).getByText('Entire platform')).toBeInTheDocument();
    expect(await screen.findByText('Operational')).toBeInTheDocument();
    expect(screen.getByText('0.0.0-test')).toBeInTheDocument();
  });

  it('shows a real error with retry when the API is unreachable, never invented data', async () => {
    route({});
    renderWithProviders(<HomePage />);

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('Operational')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
