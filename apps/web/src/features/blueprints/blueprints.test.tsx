import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlueprintValidation, Decision, Project, VersionDetail } from '@/api/types';
import { jsonResponse, renderWithProviders, renderWithRouter } from '@/test/utils';
import { BlueprintForm } from './BlueprintForm';
import { DiffList } from './CompareTab';
import { DecisionsTab } from './DecisionsTab';
import type { Content } from './model';
import { VersionsTab } from './VersionsTab';

// Test fixtures: shapes follow /api/v1; values are synthetic.
const project: Project = {
  id: 'p1',
  tenant_id: 't1',
  tenant_name: 'Fixture tenant',
  name: 'Fixture project',
  description: '',
  status: 'active',
  created_at: '2026-11-17T10:00:00Z',
  latest_version: null,
  approved_version: null,
  planning_gate: { ready: false, reason: 'No approved blueprint version yet.', version: null },
  permissions: ['blueprint:edit'],
  roles: ['migration_lead'],
};

const fetchMock = vi.fn<typeof fetch>();
let routes: Record<string, () => Response> = {};

beforeEach(() => {
  routes = {
    '/api/v1/packs': () =>
      jsonResponse([
        {
          id: 'x',
          name: 'legacy-src',
          version: '1.0.0',
          type: 'source_adapter',
          title: 'Legacy source',
          status: 'published',
          tests_passed: true,
          reviewed_by_name: null,
          published_at: null,
          created_at: '2026-11-17T10:00:00Z',
        },
      ]),
    '/api/v1/roles': () =>
      jsonResponse([
        {
          key: 'migration_lead',
          label: 'Migration lead',
          description: '',
          permissions: [],
          allowed_scopes: ['tenant'],
        },
        {
          key: 'customer_data_owner',
          label: 'Customer data owner',
          description: '',
          permissions: [],
          allowed_scopes: ['tenant'],
        },
      ]),
    '/api/v1/tenants/t1/secrets': () => jsonResponse([]),
  };
  fetchMock.mockImplementation((input) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).split('?')[0]!;
    const handler = routes[url];
    return handler
      ? Promise.resolve(handler())
      : Promise.reject(new TypeError(`unexpected ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('BlueprintForm', () => {
  const content: Content = {
    apiVersion: 'astra.blueprints/v1',
    name: 'fixture-bp',
    pattern: 'cross_product',
    cutover_strategy: 'phased',
    source: { adapter: 'legacy-src@1.0.0' },
    target: { adapter: '' },
    overrides: [
      { setting: 'retention.records.years', value: 5, reason: 'Contract term is five years' },
    ],
  };
  const validation: BlueprintValidation = {
    ok: false,
    blocking: 1,
    warnings: 0,
    issues: [
      {
        severity: 'blocking',
        code: 'override.loosening_unapproved',
        path: 'overrides[0]',
        message: "Setting 'retention.records.years' to 5 loosens the packs' value (7).",
        fix: 'Approve or tighten.',
      },
      {
        severity: 'blocking',
        code: 'schema.string_too_short',
        path: 'target.adapter',
        message: 'Choose a target adapter',
        fix: 'Correct this value.',
      },
    ],
    composition: {
      packs: [],
      controls: [],
      rules: [],
      settings: [
        {
          key: 'retention.records.years',
          stricter: 'higher',
          unit: 'years',
          conflict: false,
          strictest: 7,
          fingerprint: 'f',
          values: [{ pack: 'records@1.0.0', value: 7 }],
        },
      ],
      problems: [],
    },
    open_decisions: [],
  };

  it('maps form edits onto the content and shows inline issues and override direction', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <BlueprintForm
        content={content}
        onChange={onChange}
        tenantId="t1"
        validation={validation}
        readOnly={false}
      />,
    );
    const name = screen.getByRole('textbox', { name: /Blueprint name/ });
    expect(name).toHaveValue('fixture-bp');
    fireEvent.change(name, { target: { value: 'fixture-bp-2' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...content, name: 'fixture-bp-2' });

    await userEvent.click(screen.getByRole('radio', { name: /Consolidation/ }));
    expect(onChange).toHaveBeenLastCalledWith({ ...content, pattern: 'consolidation' });

    expect(screen.getByText('Loosens · needs approval')).toBeInTheDocument();
    // The target adapter is still empty and unedited: no inline error yet.
    expect(screen.queryByText('Choose a target adapter')).not.toBeInTheDocument();
    expect(await screen.findByRole('combobox', { name: /Source adapter/ })).toHaveTextContent(
      'Legacy source (legacy-src@1.0.0)',
    );
  });

  it('shows the inline error of an empty field once it is revealed from the problem list or by saving', () => {
    const view = renderWithProviders(
      <BlueprintForm
        content={content}
        onChange={vi.fn()}
        tenantId="t1"
        validation={validation}
        revealed={new Set(['target.adapter'])}
        readOnly={false}
      />,
    );
    expect(screen.getByText('Choose a target adapter')).toBeInTheDocument();
    view.rerender(
      <BlueprintForm
        content={content}
        onChange={vi.fn()}
        tenantId="t1"
        validation={validation}
        revealed="all"
        readOnly={false}
      />,
    );
    expect(screen.getByText('Choose a target adapter')).toBeInTheDocument();
  });

  it('is read-only without blueprint:edit', () => {
    renderWithProviders(
      <BlueprintForm
        content={content}
        onChange={vi.fn()}
        tenantId="t1"
        validation={validation}
        readOnly
      />,
    );
    expect(screen.getByRole('textbox', { name: /Blueprint name/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Add override' })).not.toBeInTheDocument();
  });
});

describe('DiffList', () => {
  it('renders added, removed and changed paths with screen-reader labels', () => {
    renderWithProviders(
      <DiffList
        diff={{
          added: [{ path: 'domain_packs[records@1.1.0]', value: true }],
          removed: [{ path: 'domain_packs[records@1.0.0]', value: true }],
          changed: [{ path: 'planning.max_task_hours', before: 40, after: 32 }],
        }}
      />,
    );
    const items = within(screen.getByRole('list', { name: 'Differences' })).getAllByRole(
      'listitem',
    );
    expect(items[0]).toHaveTextContent('Added: domain_packs[records@1.1.0]');
    expect(items[1]).toHaveTextContent('Removed: domain_packs[records@1.0.0]');
    expect(items[2]).toHaveTextContent('Changed: planning.max_task_hours: 40 → 32');
  });
});

describe('DecisionsTab', () => {
  const open: Decision = {
    id: 'd1',
    kind: 'setting_conflict',
    subject: 'retention.records.years',
    status: 'open',
    context: {
      key: 'retention.records.years',
      stricter: 'higher',
      unit: 'years',
      strictest: 10,
      values: [
        { pack: 'a@1.0.0', value: 7 },
        { pack: 'b@1.0.0', value: 10 },
      ],
    },
    chosen_value: null,
    reason: null,
    requested_by_name: 'Fixture Lead',
    decided_by_name: null,
    decided_at: null,
    created_at: '2026-11-17T10:00:00Z',
    can_decide: true,
  };

  it('warns when choosing the less strict value and posts the decision', async () => {
    routes['/api/v1/projects/p1/decisions'] = () => jsonResponse([open]);
    routes['/api/v1/decisions/d1'] = () =>
      jsonResponse({ ...open, status: 'decided', chosen_value: 7 });
    renderWithProviders(<DecisionsTab project={project} />);

    expect(await screen.findByText(/No default is applied/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Record decision' }));
    expect(screen.getByText('Choose one of the values.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: /^7 years/ }));
    expect(screen.getByText("This weakens a pack's rule")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: /10 years \(stricter\)/ }));
    expect(screen.queryByText("This weakens a pack's rule")).not.toBeInTheDocument();

    await userEvent.type(
      screen.getByRole('textbox', { name: /Reason/ }),
      'Statutory minimum applies',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Record decision' }));
    const post = fetchMock.mock.calls.find(([u]) => u === '/api/v1/decisions/d1');
    expect(JSON.parse(post![1]!.body as string)).toEqual({
      reason: 'Statutory minimum applies',
      chosen_value: 10,
    });
  });
});

describe('VersionsTab approval buttons', () => {
  function version(can_approve_as: string[]): VersionDetail {
    return {
      number: 1,
      status: 'draft',
      message: 'First draft',
      author_name: 'Fixture Lead',
      created_at: '2026-11-17T10:00:00Z',
      commit_sha: 'abcdef1234567890',
      template: null,
      yaml_text: 'name: fixture-bp\n',
      content: {},
      validation: {
        ok: true,
        blocking: 0,
        warnings: 0,
        issues: [],
        composition: null,
        open_decisions: [],
      },
      required_roles: ['migration_lead', 'customer_data_owner'],
      approvals: [],
      git_verified: true,
      can_approve_as,
    };
  }

  function setup(v: VersionDetail) {
    routes['/api/v1/projects/p1/blueprint/versions'] = () =>
      jsonResponse([
        {
          number: 1,
          status: 'draft',
          message: 'First draft',
          author_name: 'Fixture Lead',
          created_at: '2026-11-17T10:00:00Z',
          commit_sha: 'abcdef1234567890',
          template: null,
        },
      ]);
    routes['/api/v1/projects/p1/blueprint/versions/1'] = () => jsonResponse(v);
    renderWithRouter(<VersionsTab project={project} selected={null} onSelect={vi.fn()} />);
  }

  it('shows Approve/Reject only for roles the caller can still approve as', async () => {
    setup(version(['migration_lead']));
    expect(
      await screen.findByRole('button', { name: 'Approve as Migration lead' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(screen.getByText('Stored in git')).toBeInTheDocument();
    expect(screen.getByText(/0 of 2 approvals/)).toBeInTheDocument();
  });

  it('hides them when can_approve_as is empty', async () => {
    setup(version([]));
    expect(await screen.findByText(/0 of 2 approvals/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });
});
