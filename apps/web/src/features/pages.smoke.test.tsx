import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditPage as AuditPageData, Me, TraceDetail, User } from '@/api/types';
import { jsonResponse, renderWithRouter } from '@/test/utils';
import { AccessPage } from './access/AccessPage';
import { AuditPage } from './audit/AuditPage';
import { ObservabilityPage } from './observability/ObservabilityPage';
import { TraceDetailPage } from './observability/TraceDetailPage';
import { ProgrammesPage } from './programmes/ProgrammesPage';
import { TenantsPage } from './tenants/TenantsPage';

// Test fixtures only: shapes follow /api/v1; values are synthetic.
const ALL = [
  'tenant:read',
  'tenant:create',
  'access:read',
  'access:manage',
  'audit:read',
  'audit:export',
  'audit:verify',
  'observability:read',
  'programme:manage',
];

function me(permissions: string[]): Me {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'fixture.user@example.test',
    display_name: 'Fixture User',
    mfa: true,
    roles: [],
    permissions,
  };
}

const users: User[] = [
  {
    id: 'u1',
    email: 'fixture.lead@example.test',
    display_name: 'Fixture Lead',
    status: 'invited',
    last_seen_at: null,
    assignments: [
      {
        id: 'a1',
        role: 'migration_lead',
        role_label: 'Migration lead',
        scope_type: 'tenant',
        scope_id: 't1',
        scope_name: 'Fixture tenant',
        granted_at: '2026-11-17T10:00:00Z',
      },
    ],
  },
];

const auditPage: AuditPageData = {
  items: [
    {
      seq: 42,
      occurred_at: '2026-11-17T10:00:00Z',
      actor_type: 'user',
      actor_id: 'u1',
      actor_name: 'Fixture Lead',
      action: 'tenant.policy_changed',
      outcome: 'success',
      tenant_id: null,
      project_id: null,
      target_type: 'tenant',
      target_id: 't1',
      details: { loosened: false },
      trace_id: 'abc123',
      hash: 'f'.repeat(64),
    },
  ],
  next_before_seq: 42,
};

const trace: TraceDetail = {
  trace_id: 'abc123',
  jaeger_url: 'http://localhost:16686/trace/abc123',
  spans: [
    {
      span_id: 'root',
      parent_span_id: null,
      name: 'GET /api/v1/tenants',
      category: 'http',
      started_at: '2026-11-17T10:00:00.000Z',
      duration_ms: 120,
      status: 'ok',
      stage: null,
      agent: null,
      model: null,
      cost_usd: null,
      attributes: { 'http.status_code': 200 },
    },
    {
      span_id: 'db',
      parent_span_id: 'root',
      name: 'SELECT tenants',
      category: 'db',
      started_at: '2026-11-17T10:00:00.020Z',
      duration_ms: 30,
      status: 'ok',
      stage: null,
      agent: null,
      model: null,
      cost_usd: null,
      attributes: {},
    },
  ],
};

const fetchMock = vi.fn<typeof fetch>();
let permissions = ALL;

function respond(url: string): Response {
  const path = url.split('?')[0];
  switch (path) {
    case '/api/v1/me':
      return jsonResponse(me(permissions));
    case '/api/v1/tenants':
    case '/api/v1/programmes':
    case '/api/v1/audit/anchors':
    case '/api/v1/observability/traces':
      return jsonResponse([]);
    case '/api/v1/users':
      return jsonResponse(users);
    case '/api/v1/audit':
      return jsonResponse(auditPage);
    case '/api/v1/observability/summary':
      return jsonResponse([
        { key: 'http', spans: 10, errors: 1, total_ms: 500, p95_ms: 90, cost_usd: null },
        { key: null, spans: 2, errors: 0, total_ms: 50, p95_ms: 30, cost_usd: null },
      ]);
    case '/api/v1/observability/traces/abc123':
      return jsonResponse(trace);
    default:
      throw new Error(`unexpected request ${url}`);
  }
}

beforeEach(() => {
  permissions = ALL;
  fetchMock.mockImplementation((input) =>
    Promise.resolve(respond(typeof input === 'string' ? input : (input as Request).url)),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('feature pages render from the API', () => {
  it('Tenants: empty state offers creation to tenant creators', async () => {
    renderWithRouter(<TenantsPage />);
    expect(await screen.findByText('No tenants yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New tenant' }).length).toBeGreaterThan(0);
  });

  it('Tenants: no create button without tenant:create', async () => {
    permissions = ['tenant:read'];
    renderWithRouter(<TenantsPage />);
    expect(await screen.findByText('No tenants yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New tenant' })).not.toBeInTheDocument();
  });

  it('pages show permission denied when the permission is missing', async () => {
    permissions = ['tenant:read'];
    renderWithRouter(<AuditPage />);
    expect(
      await screen.findByRole('heading', { name: "You don't have permission to view this page" }),
    ).toBeInTheDocument();
  });

  it('Programmes: renders', async () => {
    renderWithRouter(<ProgrammesPage />);
    expect(await screen.findByText('No programmes')).toBeInTheDocument();
  });

  it('Access: lists people with role badges and opens the panel', async () => {
    renderWithRouter(<AccessPage />);
    expect(await screen.findByText('Fixture Lead')).toBeInTheDocument();
    expect(screen.getByText('Migration lead · Fixture tenant')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Fixture Lead'));
    const panel = await screen.findByRole('dialog', { name: 'Fixture Lead' });
    expect(within(panel).getByRole('button', { name: 'Grant role' })).toBeInTheDocument();
  });

  it('Audit: lists events, offers older pages and shows details', async () => {
    renderWithRouter(<AuditPage />);
    expect(await screen.findByText('tenant.policy_changed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load older events' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify integrity' })).toBeInTheDocument();
    await userEvent.click(screen.getByText('tenant.policy_changed'));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText(/"loosened": false/)).toBeInTheDocument();
  });

  it('Observability: summary with bars, unknown cost shown as a dash', async () => {
    renderWithRouter(<ObservabilityPage />);
    expect(await screen.findByText('http')).toBeInTheDocument();
    expect(screen.getByText('Not set')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByRole('radiogroup', { name: 'Group by' })).toBeInTheDocument();
  });

  it('Trace detail: waterfall with nested spans and attribute details', async () => {
    renderWithRouter(<TraceDetailPage traceId="abc123" />);
    const db = await screen.findByRole('button', { name: /SELECT tenants/ });
    expect(db).toHaveAccessibleName(/starts at 20 ms, lasts 30 ms, nested level 1/);
    expect(screen.getByRole('link', { name: /Open in Jaeger/ })).toHaveAttribute(
      'href',
      'http://localhost:16686/trace/abc123',
    );
    await userEvent.click(screen.getByRole('button', { name: /GET \/api\/v1\/tenants/ }));
    expect(await screen.findByText(/"http.status_code": 200/)).toBeInTheDocument();
  });
});
