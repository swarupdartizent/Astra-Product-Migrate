import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me, Project } from '@/api/types';
import type { Checklist, ConvertedObjectDetail } from '@/api/upgrade-types';
import { jsonResponse, renderWithProviders, renderWithRouter } from '@/test/utils';
import { ChecklistTab } from './checklist/ChecklistTab';
import { closeProblem, groupByArea, roleLabel } from './checklist/model';
import { ObjectDetail } from './conversion/ConversionTab';
import { buildTest, EMPTY_TEST, testFieldOf } from './conversion/model';
import { DeltaTab } from './delta/DeltaTab';
import { describeDifference, parseObjectRef, patternLabel } from './delta/model';

// Test fixtures only: shapes follow /api/v1; values are synthetic.
const fetchMock = vi.fn<typeof fetch>();
let routes: Record<string, (init?: RequestInit) => Response> = {};

beforeEach(() => {
  routes = {};
  fetchMock.mockImplementation((input, init) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).split('?')[0]!;
    const key = `${init?.method ?? 'GET'} ${url}`;
    const handler = routes[key] ?? routes[url];
    return handler
      ? Promise.resolve(handler(init))
      : Promise.reject(new TypeError(`unexpected ${key}`));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const project: Project = {
  id: 'p1',
  tenant_id: 't1',
  tenant_name: 'Fixture tenant',
  name: 'Fixture project',
  description: '',
  status: 'active',
  created_at: '2026-11-18T10:00:00Z',
  latest_version: null,
  approved_version: null,
  planning_gate: { ready: false, reason: 'No approved blueprint version yet.', version: null },
  permissions: ['stage:manage', 'source:manage'],
  roles: [],
};

const me: Me = {
  id: 'u1',
  email: 'fixture@example.test',
  display_name: 'Fixture User',
  mfa: true,
  roles: [],
  permissions: [],
};

describe('delta model', () => {
  it('describes each kind of difference readably', () => {
    expect(
      describeDifference({
        group: 'renamed_or_moved',
        details: { how: 'moved', from_schema: 'dbo', to_schema: 'core' },
      }),
    ).toEqual(['Moved from schema dbo to core.']);
    expect(
      describeDifference({
        group: 'renamed_or_moved',
        details: {
          how: 'renamed',
          similarity: 0.875,
          added_in_target: ['b'],
          missing_in_target: [],
          type_changed: ['c: int -> bigint'],
        },
      }),
    ).toEqual(['Renamed; 88% similar.', 'Added in target: b.', 'Type changed: c: int -> bigint.']);
    expect(
      describeDifference({
        group: 'changed_behaviour',
        details: { what: 'columns differ', missing_in_target: ['x'] },
      }),
    ).toEqual(['Columns differ.', 'Missing in target: x.']);
    expect(
      describeDifference({
        group: 'removed_in_target',
        details: { closest: 'dbo.near', similarity: 0.5 },
      }),
    ).toEqual(['Closest target object: dbo.near (50% similar, below the rename threshold).']);
    expect(describeDifference({ group: 'removed_in_target', details: { closest: null } })).toEqual([
      'No similar object in the target.',
    ]);
  });

  it('parses object refs and labels patterns', () => {
    expect(parseObjectRef('table:dbo.party')).toEqual({ type: 'table', name: 'dbo.party' });
    expect(patternLabel('same_family_upgrade')).toBe('Same-family upgrade');
    expect(patternLabel(null)).toBe('Not set');
  });
});

describe('conversion test form', () => {
  it('builds a valid case and normalises output names', () => {
    const r = buildTest({
      ...EMPTY_TEST,
      object_name: 'dbo.calc',
      name: 'Base case',
      inputs: '{"id": 7}',
      outputs: '@total, rate',
      setup: '{"dbo.rates": [{"id": 7, "rate": 1.1}]}',
      expectKind: 'outputs',
      expected: '{"total": 11}',
    });
    expect(r.errors).toEqual({});
    expect(r.body).toEqual({
      object_name: 'dbo.calc',
      name: 'Base case',
      inputs: { id: 7 },
      outputs: ['total', 'rate'],
      setup: { 'dbo.rates': [{ id: 7, rate: 1.1 }] },
      expected: { outputs: { total: 11 } },
    });
  });

  it('reports each invalid field', () => {
    const r = buildTest({
      ...EMPTY_TEST,
      object_name: 'calc',
      name: 'x',
      inputs: '[1]',
      setup: '{"rates": 1}',
      expectKind: 'rows',
      expected: '{"a": 1}',
    });
    expect(Object.keys(r.errors).sort()).toEqual([
      'expected',
      'inputs',
      'name',
      'object_name',
      'setup',
    ]);
    expect(r.body).toBeNull();
    expect(
      buildTest({
        ...EMPTY_TEST,
        object_name: 'a.b',
        name: 'abc',
        expectKind: 'error',
        expected: '',
      }).errors.expected,
    ).toMatch(/error must contain/);
    expect(testFieldOf('expected.rows')).toBe('expected');
    expect(testFieldOf('body')).toBeNull();
  });
});

describe('checklist model', () => {
  it('mirrors the closing rules', () => {
    const item = { owner_user_id: null, note: '' };
    expect(closeProblem(item, { status: 'done', note: 'x', owner: null })?.field).toBe(
      'owner_user_id',
    );
    expect(closeProblem(item, { status: 'done', note: ' ', owner: 'u1' })?.field).toBe('note');
    expect(closeProblem(item, { status: 'done', note: 'Tested', owner: 'u1' })).toBeNull();
    expect(closeProblem(item, { status: 'in_progress', note: '', owner: null })).toBeNull();
    expect(roleLabel('customer_it_security_lead')).toBe('Customer IT security lead');
  });

  it('groups items by area in order', () => {
    const base = {
      title: '',
      detail: '',
      source: { kind: 'generic' as const, note: '' },
      owner_user_id: null,
      owner_name: null,
      owner_role: 'x',
      status: 'open',
      note: '',
      updated_by: null,
      updated_at: null,
    };
    const g = groupByArea([
      {
        ...base,
        id: '1',
        key: 'a',
        category: 'mfa',
        category_title: 'Multi-factor authentication',
      },
      {
        ...base,
        id: '2',
        key: 'b',
        category: 'mfa',
        category_title: 'Multi-factor authentication',
      },
      { ...base, id: '3', key: 'c', category: 'sso', category_title: 'Single sign-on' },
    ]);
    expect(g.map((x) => [x.area, x.items.length])).toEqual([
      ['mfa', 2],
      ['sso', 1],
    ]);
  });
});

describe('DeltaTab', () => {
  it('shows the planner disagreeing and the explanation of unknown origin', async () => {
    routes['/api/v1/projects/p1/pattern-advice'] = () =>
      jsonResponse({
        chosen: 'cross_product',
        recommended: 'same_family_upgrade',
        agrees: false,
        reasons: [
          '9 of 10 comparable source objects (90%) exist in the target unchanged, renamed or moved.',
        ],
        delta_run_id: 'd1',
      });
    routes['/api/v1/projects/p1/delta-runs'] = () =>
      jsonResponse([
        {
          id: 'd1',
          project_id: 'p1',
          connection_id: 'c1',
          connection_name: 'fixture-source',
          baseline: 'fixture-target / v2 (2.0)',
          standard_baseline: null,
          status: 'succeeded',
          status_detail: null,
          counts: { unchanged: 7, renamed_or_moved: 2, changed_behaviour: 1, removed_in_target: 0 },
          origin_counts: { unknown: 10 },
          not_in_scope: 3,
          new_in_target: 4,
          input_digest: 'in-digest',
          result_digest: 'out-digest',
          advice: {},
          job_id: null,
          requested_by: 'Fixture User',
          created_at: '2026-11-18T10:00:00Z',
          finished_at: '2026-11-18T10:01:00Z',
        },
      ]);
    routes['/api/v1/delta-runs/d1/lists'] = () =>
      jsonResponse({ not_in_scope: ['workflow:dbo.flow'], new_in_target: [], problems: [] });
    routes['/api/v1/delta-runs/d1/differences'] = () =>
      jsonResponse({
        total: 1,
        offset: 0,
        groups: [],
        items: [
          {
            group: 'renamed_or_moved',
            type: 'table',
            source: 'dbo.party',
            target: 'core.party',
            origin: 'unknown',
            details: { how: 'moved', from_schema: 'dbo', to_schema: 'core' },
          },
        ],
      });
    renderWithRouter(<DeltaTab project={project} />);
    expect(await screen.findByText(/A proposal went to the/)).toBeInTheDocument();
    expect(screen.getByText('Same-family upgrade')).toBeInTheDocument();
    expect(await screen.findByText(/stated as unknown, not guessed/)).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Version delta differences' });
    expect(within(table).getByText('Moved from schema dbo to core.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download CSV' })).toBeInTheDocument();
  });
});

describe('ObjectDetail', () => {
  it('shows source and converted code side by side, and failed test inputs next to the differences', () => {
    const d: ConvertedObjectDetail = {
      object_type: 'procedure',
      name: 'dbo.calc',
      status: 'compiled',
      rules: ['ISNULL replaces IFNULL'],
      warnings: [],
      review: [],
      compile: { ok: true, error: null, unresolved: [] },
      tests: [
        {
          test_id: 't1',
          name: 'Base case',
          passed: false,
          inputs: { id: 7 },
          expected: { value: 11 },
          actual: { value: 10 },
          differences: ['value: expected 11, got 10'],
          error: null,
        },
      ],
      source: 'CREATE PROCEDURE calc AS SELECT IFNULL(a, 0)',
      converted: 'CREATE PROCEDURE dbo.calc AS SELECT ISNULL(a, 0)',
    };
    renderWithProviders(<ObjectDetail detail={d} />);
    expect(screen.getByLabelText('Source code of dbo.calc')).toHaveTextContent('IFNULL');
    expect(screen.getByLabelText('Converted code of dbo.calc')).toHaveTextContent('ISNULL');
    expect(screen.getByLabelText('Inputs of Base case')).toHaveTextContent('"id": 7');
    expect(screen.getByLabelText('Differences of Base case')).toHaveTextContent(
      'value: expected 11, got 10',
    );
    expect(screen.getByText('Compiles on the workbench.')).toBeInTheDocument();
  });
});

describe('ChecklistTab', () => {
  const checklist: Checklist = {
    items: [
      {
        id: 'i1',
        key: 'generic:printing',
        category: 'printing',
        category_title: 'Printing',
        title: 'Make printing work from the hosted product',
        detail: 'Confirm how documents print.',
        source: {
          kind: 'generic',
          note: 'The target adapter records nothing about this area; confirm the arrangement with the vendor.',
        },
        owner_user_id: null,
        owner_name: null,
        owner_role: 'customer_operations_manager',
        status: 'open',
        note: '',
        updated_by: null,
        updated_at: null,
      },
      {
        id: 'i2',
        key: 'adapter:TGT-SSO-1',
        category: 'sso',
        category_title: 'Single sign-on',
        title: 'Identity provider federation',
        detail: 'The hosted product federates with one identity provider.',
        source: {
          kind: 'adapter',
          adapter: 'fixture-target@1.0.0',
          constraint: 'SSO-1',
          reference: { reference: 'Fixture hosting guide' },
          recorded_on: '2026-10-01',
          confidence: 'confirmed',
        },
        owner_user_id: null,
        owner_name: null,
        owner_role: 'customer_it_security_lead',
        status: 'open',
        note: '',
        updated_by: null,
        updated_at: null,
      },
    ],
    adapter: 'fixture-target@1.0.0',
    missing: ['generic:mfa'],
    areas: ['sso', 'mfa', 'network', 'printing'],
    complete: false,
    done: 0,
    total: 2,
    can_manage: true,
  };

  it('marks generic items, shows adapter sources, and refuses closing without an owner', async () => {
    routes['/api/v1/me'] = () => jsonResponse(me);
    routes['/api/v1/projects/p1/checklist'] = () => jsonResponse(checklist);
    routes['/api/v1/users'] = () => jsonResponse([]);
    renderWithRouter(<ChecklistTab project={project} />);
    expect(await screen.findByText('Generic: confirm with the vendor')).toBeInTheDocument();
    expect(screen.getByText('SSO-1')).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add 1 missing item' })).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'Update Make printing work from the hosted product' }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Status' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Done' }));
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Note/ }),
      'Printed a test page.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByText(/Assign an owner first/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });
});
