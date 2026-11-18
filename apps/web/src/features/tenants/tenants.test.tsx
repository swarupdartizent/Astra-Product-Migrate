import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Region, Tenant } from '@/api/types';
import { jsonResponse, renderWithProviders, renderWithRouter } from '@/test/utils';
import { CreateTenantDialog } from './CreateTenantDialog';
import { PolicyTab } from './PolicyTab';
import { RegionTab } from './RegionTab';
import { SecretsTab } from './SecretsTab';

// Test fixtures: shapes follow the /api/v1 contract; values are synthetic.
function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    slug: 'fixture-one',
    name: 'Fixture tenant',
    region_code: 'local-a',
    region_name: 'Local A',
    programme_id: null,
    programme_name: null,
    partner_id: null,
    partner_name: null,
    status: 'active',
    status_detail: null,
    key_name: 'tenant-fixture-key',
    mfa_required: true,
    session_timeout_minutes: 480,
    created_at: '2026-11-17T10:00:00Z',
    deleted_at: null,
    permissions: ['tenant:read'],
    active_job: null,
    ...overrides,
  };
}

const regions: Region[] = [
  { code: 'local-a', name: 'Local A', jurisdiction: 'Test', model_endpoints: {} },
];

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

describe('PolicyTab', () => {
  it('is read-only without tenant:update_policy', () => {
    renderWithProviders(<PolicyTab tenant={tenant()} />);
    expect(screen.getByText('Read only')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /multi-factor/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save policy' })).not.toBeInTheDocument();
  });

  it('requires a reason before saving a change that weakens the policy', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(tenant())));
    renderWithProviders(
      <PolicyTab tenant={tenant({ permissions: ['tenant:read', 'tenant:update_policy'] })} />,
    );
    const save = screen.getByRole('button', { name: 'Save policy' });
    expect(save).toBeDisabled();

    await userEvent.click(screen.getByRole('switch', { name: /multi-factor/i }));
    expect(screen.getByText('This weakens the security policy')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Reason/ })).toBeRequired();

    await userEvent.click(save);
    expect(screen.getByText(/Give a reason/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await userEvent.type(
      screen.getByRole('textbox', { name: /Reason/ }),
      'Shared kiosk without phones',
    );
    await userEvent.click(save);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(urlOf(url)).toBe(`/api/v1/tenants/${tenant().id}/policy`);
    expect(JSON.parse(init!.body as string)).toEqual({
      mfa_required: false,
      session_timeout_minutes: 480,
      reason: 'Shared kiosk without phones',
    });
  });

  it('does not ask for a reason when tightening', async () => {
    renderWithProviders(
      <PolicyTab tenant={tenant({ permissions: ['tenant:read', 'tenant:update_policy'] })} />,
    );
    const timeout = screen.getByRole('spinbutton', { name: /Session timeout/ });
    await userEvent.clear(timeout);
    await userEvent.type(timeout, '60');
    expect(screen.queryByText('This weakens the security policy')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Reason/ })).not.toBeRequired();
  });
});

describe('SecretsTab permission gating', () => {
  it('hides add, rotate and delete without secrets:manage', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse([
          {
            id: 's1',
            name: 'erp-db',
            reference: 'secret://erp-db',
            description: 'Fixture',
            current_version: 2,
            created_at: '2026-11-17T10:00:00Z',
            created_by_name: 'Fixture User',
            rotated_at: null,
            last_read_at: null,
            last_read_by: null,
          },
        ]),
      ),
    );
    renderWithProviders(
      <SecretsTab tenant={tenant({ permissions: ['tenant:read', 'secrets:read'] })} />,
    );
    expect(await screen.findByText('secret://erp-db')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Copy reference secret://erp-db' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add secret/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rotate erp-db/ })).not.toBeInTheDocument();
  });

  it('shows manage actions with secrets:manage', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse([])));
    renderWithProviders(
      <SecretsTab
        tenant={tenant({ permissions: ['tenant:read', 'secrets:read', 'secrets:manage'] })}
      />,
    );
    expect(await screen.findByText('No connector secrets')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Add secret/ }).length).toBeGreaterThan(0);
  });
});

describe('CreateTenantDialog', () => {
  it('validates before submitting and maps 422 field errors onto fields', async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = urlOf(input);
      if (url === '/api/v1/regions') return Promise.resolve(jsonResponse(regions));
      if (url === '/api/v1/programmes') return Promise.resolve(jsonResponse([]));
      if (url === '/api/v1/tenants' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            {
              type: '/problems/validation',
              title: 'Some fields need attention',
              status: 422,
              detail: 'Correct the fields listed and try again.',
              errors: [{ field: 'name', message: 'Name is reserved' }],
            },
            422,
            'application/problem+json',
          ),
        );
      }
      return Promise.reject(new TypeError('unexpected ' + url));
    });

    renderWithRouter(<CreateTenantDialog open onOpenChange={() => undefined} />);
    const dialog = await screen.findByRole('dialog', { name: 'New tenant' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create tenant' }));
    expect(within(dialog).getByRole('textbox', { name: /Short name/ })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(within(dialog).getByText('Choose a region.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(false);

    await userEvent.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Fixture tenant');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Short name/ }),
      'fixture-one',
    );
    await userEvent.click(within(dialog).getByRole('combobox', { name: /Region/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Local A/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create tenant' }));

    expect(await within(dialog).findByText('Name is reserved')).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: /^Name/ })).toHaveAccessibleDescription(
      'Name is reserved',
    );
  });
});

function fieldProblem(field: string, message: string) {
  return jsonResponse(
    {
      type: '/problems/validation',
      title: 'Some fields need attention',
      status: 422,
      detail: message,
      errors: [{ field, message }],
    },
    422,
    'application/problem+json',
  );
}

describe('server field errors land on the right field', () => {
  it('secret creation: name', async () => {
    fetchMock.mockImplementation((_input, init) =>
      Promise.resolve(
        init?.method === 'POST'
          ? fieldProblem('name', 'A secret with this name already exists in this tenant.')
          : jsonResponse([]),
      ),
    );
    renderWithProviders(
      <SecretsTab
        tenant={tenant({ permissions: ['tenant:read', 'secrets:read', 'secrets:manage'] })}
      />,
    );
    await userEvent.click((await screen.findAllByRole('button', { name: /Add secret/ }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add connector secret' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'erp-db');
    await userEvent.type(within(dialog).getByLabelText(/^Value/), 'fixture-value');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add secret' }));
    expect(
      await within(dialog).findByText('A secret with this name already exists in this tenant.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: /^Name/ })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('region move: to_region', async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = urlOf(input);
      if (init?.method === 'POST')
        return Promise.resolve(fieldProblem('to_region', "Region 'local-b' is not offered"));
      if (url === '/api/v1/regions') {
        return Promise.resolve(
          jsonResponse([
            ...regions,
            { code: 'local-b', name: 'Local B', jurisdiction: 'Test', model_endpoints: {} },
          ]),
        );
      }
      return Promise.resolve(jsonResponse([]));
    });
    renderWithProviders(
      <RegionTab tenant={tenant({ permissions: ['tenant:read', 'tenant:region_migrate'] })} />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Move region' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('combobox', { name: /Destination region/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Local B/ }));
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      'Customer moved data centre',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move region' }));
    expect(await within(dialog).findByText("Region 'local-b' is not offered")).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: /Destination region/ })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });
});
