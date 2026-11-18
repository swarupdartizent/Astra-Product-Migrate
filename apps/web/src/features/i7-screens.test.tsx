import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PlanBaseline,
  PlanOverview,
  PresalesEstimate,
  Risk,
  ScopePage,
  WavePlan,
} from '@/api/planning-types';
import type { Project } from '@/api/types';
import { jsonResponse, renderWithProviders, renderWithRouter } from '@/test/utils';
import { BaselinesView } from './plan/BaselinesView';
import {
  formatRange,
  loadRatio,
  parseTimings,
  validateCoexistence,
  validateWave,
} from './plan/model';
import { PlanTab } from './plan/PlanTab';
import { RisksView } from './plan/RisksView';
import { ScopeView } from './plan/ScopeView';
import { PlanResult } from './plan/WavesView';
import { EMPTY_QUESTIONNAIRE, validatePresales } from './presales/model';
import { EstimateResult } from './presales/PresalesPage';

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
  permissions: ['stage:manage', 'blueprint:edit'],
  roles: [],
};

function bodyOf(method: string, path: string): unknown {
  const call = fetchMock.mock.calls.find(
    ([input, init]) =>
      init?.method === method &&
      (typeof input === 'string' ? input : (input as Request).url).split('?')[0] === path,
  );
  const body = call?.[1]?.body;
  return typeof body === 'string' ? (JSON.parse(body) as unknown) : undefined;
}

describe('plan model', () => {
  it('always shows a range', () => {
    expect(formatRange({ low: 80, likely: 95, high: 120 })).toBe('80–120 h (likely 95)');
    expect(formatRange({ low: null, likely: null, high: null })).toBe('Not estimated');
    expect(formatRange(null)).toBe('Not estimated');
  });

  it('measures load against capacity', () => {
    expect(loadRatio(50, 100)).toEqual({ pct: 50, over: false });
    expect(loadRatio(120, 100)).toEqual({ pct: 120, over: true });
    expect(loadRatio(5, 0)).toEqual({ pct: null, over: true });
  });

  it('validates waves like the API', () => {
    const ok = validateWave({
      key: 'W1',
      name: 'Wave 1',
      start: '2027-01-04',
      end: '2027-02-26',
      cutover: '',
      capacity: { data_sme: '120', test_engineer: '' },
    });
    expect(ok.body).toEqual({
      name: 'Wave 1',
      start: '2027-01-04',
      end: '2027-02-26',
      cutover: null,
      capacity: { data_sme: 120 },
    });
    const bad = validateWave({
      key: '-x',
      name: 'W',
      start: '2027-02-01',
      end: '2027-01-01',
      cutover: '',
      capacity: { data_sme: '-1' },
    });
    expect(Object.keys(bad.errors).sort()).toEqual(['capacity', 'end', 'key', 'name']);
  });

  it('parses rehearsal timings and checks coexistence rules', () => {
    expect(parseTimings('a = 5\nb=12.5', ['a', 'b'])).toEqual({
      timings: { a: 5, b: 12.5 },
      error: null,
    });
    expect(parseTimings('c = 5', ['a']).error).toMatch(/Not a runbook step/);
    expect(parseTimings('a = -1', ['a']).error).toMatch(/zero or more/);
    expect(parseTimings('', ['a']).error).toMatch(/at least one/);
    expect(Object.keys(validateCoexistence({ exit_reconciliation: 'short' })).sort()).toEqual([
      'end_date',
      'exit_reconciliation',
      'system_of_record',
    ]);
  });

  it('validates the pre-sales questionnaire with the API field paths', () => {
    const r = validatePresales({
      name: 'Fixture prospect',
      programme_id: '',
      estimation_packs: ['fixture-pattern@1.0.0'],
      questionnaire: { ...EMPTY_QUESTIONNAIRE, tables: '120', rows_millions: '2.5' },
      sample_extract_yaml: '',
    });
    expect(r.body?.questionnaire).toMatchObject({
      tables: 120,
      rows_millions: 2.5,
      avg_columns: null,
    });
    const bad = validatePresales({
      name: 'x',
      programme_id: '',
      estimation_packs: [],
      questionnaire: { ...EMPTY_QUESTIONNAIRE, tables: '1.5', wave_weeks: '0' },
      sample_extract_yaml: '',
    });
    expect(Object.keys(bad.errors).sort()).toEqual([
      'estimation_packs',
      'name',
      'questionnaire.tables',
      'questionnaire.wave_weeks',
    ]);
  });
});

describe('PlanTab overview', () => {
  it('says why the plan cannot be produced', async () => {
    routes['/api/v1/projects/p1/plan'] = () =>
      jsonResponse({
        ready: false,
        problem: 'The project has no blueprint yet.',
        can_manage: true,
      });
    renderWithRouter(<PlanTab project={project} />);
    expect(await screen.findByText('The project has no blueprint yet.')).toBeInTheDocument();
  });

  it('marks uncalibrated estimation packs and shows the estimate as a range', async () => {
    const o: PlanOverview = {
      ready: true,
      blueprint_version: 3,
      notes: ['Blueprint version 3 is not approved yet.'],
      missing_packs: [],
      estimation: [
        { pack: 'fixture-pattern@1.0.0', calibrated: false, basis: 'Workshop figures.', rules: 4 },
      ],
      compliance_packs: [],
      max_task_hours: 40,
      discovery_run_id: null,
      delta_run_id: null,
      target_adapter: null,
      counts: { scope: 10, task: 22 },
      scope_approved: 4,
      estimate: { low: 100, likely: 140, high: 210, tasks: 22 },
      waves_fit: false,
      cutover_choice: null,
      latest_baseline: null,
      approved_baseline_id: null,
      baseline_awaiting_approval: false,
      can_approve_waiting: false,
      can_manage: true,
      can_approve: false,
    };
    routes['/api/v1/projects/p1/plan'] = () => jsonResponse(o);
    renderWithRouter(<PlanTab project={project} />);
    expect(await screen.findByText('UNCALIBRATED')).toBeInTheDocument();
    expect(screen.getByText('100–210 h (likely 140)')).toBeInTheDocument();
    expect(screen.getByText('Blueprint version 3 is not approved yet.')).toBeInTheDocument();
    expect(screen.getByText('4 of 10')).toBeInTheDocument();
  });
});

describe('ScopeView', () => {
  const page: ScopePage = {
    total: 2,
    offset: 0,
    dispositions: ['migrate', 'rebuild', 'replace_with_standard', 'agentify', 'archive', 'retire'],
    counts: { migrate: 1, retire: 1 },
    pending: 2,
    items: [
      {
        key: 'table:dbo.party',
        element: 'dbo.party',
        kind: 'table',
        stream: 'data',
        concept: null,
        segment: 'dbo',
        props: {},
        proposed: 'migrate',
        evidence: ['Version delta: unchanged; origin unknown.'],
        delta: null,
        status: 'proposed',
        disposition: null,
        decision: null,
        effective: 'migrate',
      },
      {
        key: 'table:dbo.old_notes',
        element: 'dbo.old_notes',
        kind: 'table',
        stream: 'data',
        concept: null,
        segment: 'dbo',
        props: {},
        proposed: 'retire',
        evidence: ['No direct or indirect use in the 90-day activity window.'],
        delta: null,
        status: 'proposed',
        disposition: null,
        decision: null,
        effective: 'retire',
      },
    ],
  };

  it('decides selected items with a reason, and says agentify is never proposed', async () => {
    routes['/api/v1/projects/p1/plan/scope'] = () => jsonResponse(page);
    routes['POST /api/v1/projects/p1/plan/scope/decisions'] = () => jsonResponse({ decided: 2 });
    renderWithProviders(<ScopeView project={project} canManage />);
    expect(await screen.findByText(/Agentify is never proposed automatically/)).toBeInTheDocument();
    expect(
      await screen.findByText('No direct or indirect use in the 90-day activity window.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select every item on this page' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Decide selected' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve proposals' }));
    expect(within(dialog).getByText(/at least 10 characters/)).toBeInTheDocument();
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      'Agreed in the scope workshop.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve proposals' }));
    await waitFor(() =>
      expect(bodyOf('POST', '/api/v1/projects/p1/plan/scope/decisions')).toEqual({
        keys: ['table:dbo.party', 'table:dbo.old_notes'],
        disposition: null,
        reason: 'Agreed in the scope workshop.',
      }),
    );
  });
});

describe('PlanResult', () => {
  it('shows every broken constraint, the options and the load over capacity', () => {
    const p: WavePlan = {
      status: 'optimal',
      fits: false,
      assignments: {},
      broken: [
        {
          constraint: 'capacity',
          wave: 'W1',
          role: 'data_sme',
          over_by_hours: 40,
          detail: 'Wave W1 needs 40 more data_sme hour(s) than its capacity.',
        },
      ],
      options: [
        {
          option: 'add_capacity',
          wave: 'W1',
          role: 'data_sme',
          hours: 40,
          detail: 'Add 40 hour(s) of data_sme capacity to wave W1.',
        },
      ],
      load: { W1: { data_sme: { hours: 140, capacity: 100 } } },
      items: 12,
    };
    renderWithProviders(<PlanResult plan={p} roles={['migration_lead', 'data_sme']} />);
    expect(screen.getByText('The plan does not fit')).toBeInTheDocument();
    expect(screen.getByText(/No work is dropped/)).toBeInTheDocument();
    expect(screen.getByText(/needs 40 more data_sme/)).toBeInTheDocument();
    expect(screen.getByText(/Add 40 hour\(s\)/)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: /Load against capacity/ });
    expect(table).toHaveTextContent('140 of 100 h (over)');
  });
});

describe('RisksView', () => {
  it('asks a person to accept or reject a planner proposal, with a note', async () => {
    const risk: Risk = {
      key: 'planner:unestimated',
      title: '3 scope item(s) have no estimation rule',
      detail: 'Found by the planner when tasks were generated.',
      likelihood: 4,
      impact: 2,
      score: 8,
      owner_user_id: null,
      owner_name: null,
      mitigation_task: null,
      status: 'proposed',
      source: 'planner',
      decision: null,
    };
    routes['/api/v1/projects/p1/plan/risks'] = () => jsonResponse([risk]);
    routes['/api/v1/users'] = () => jsonResponse([]);
    renderWithProviders(<RisksView project={project} canManage />);
    expect(await screen.findByText(/proposed by the planner/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Decide risk/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByText('Accept or reject the proposed risk.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });
});

describe('BaselinesView', () => {
  it('lists the coexistence problems when approving a phased plan is refused', async () => {
    const b: PlanBaseline = {
      id: 'b1',
      number: 2,
      digest: 'abc',
      summary: { items: { task: 10 }, hours: { low: 80, likely: 100, high: 130 } },
      changes: {},
      reason: 'Ready for steering committee.',
      status: 'proposed',
      proposed_by: 'Someone Else',
      decided_by: null,
      decided_at: null,
      decision_note: null,
      created_at: '2026-11-18T10:00:00Z',
    };
    routes['/api/v1/projects/p1/plan/baselines'] = () => jsonResponse([b]);
    routes['POST /api/v1/plan-baselines/b1/decision'] = () =>
      jsonResponse(
        {
          type: '/problems/coexistence',
          title: 'A phased plan needs coexistence rules',
          status: 409,
          detail: 'Name a system of record for every shared entity in every phase.',
          errors: [
            { field: 'policy:W1', message: 'No coexistence rule for policy after wave W1.' },
          ],
        },
        409,
        'application/problem+json',
      );
    renderWithProviders(<BaselinesView project={project} canManage={false} canApprove />);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Note/ }),
      'Looks right to me.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve baseline' }));
    expect(
      await within(dialog).findByText('A phased plan needs coexistence rules'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/No coexistence rule for policy after wave W1/),
    ).toBeInTheDocument();
  });
});

describe('EstimateResult', () => {
  it('shows the ESTIMATE label and every assumption', () => {
    const e: PresalesEstimate = {
      id: 'e1',
      name: 'Fixture prospect',
      programme_id: null,
      estimation_packs: ['fixture-pattern@1.0.0'],
      questionnaire: { ...({} as PresalesEstimate['questionnaire']) },
      sample: null,
      result: {
        label: 'ESTIMATE: pre-sales sizing from a questionnaire, not a delivery plan',
        scope_outline: [
          {
            elements: 'tables',
            count: 120,
            stream: 'data',
            disposition: 'migrate',
            hours: { low: 100, likely: 150, high: 220 },
            rule: 'data-table',
          },
        ],
        effort_hours: { low: 100, likely: 150, high: 220 },
        waves: [{ wave: 'W1', weeks: 8, likely_hours: 150 }],
        duration_weeks: 8,
        assumptions: [
          'Columns per table: 15 assumed (no sample extract and none given).',
          'Rows are spread evenly: 20,833 per table.',
        ],
        unestimated: ['reports/rebuild'],
        basis: [{ pack: 'fixture-pattern@1.0.0', calibrated: false, basis: 'Workshop figures.' }],
      },
      created_by: 'Fixture User',
      created_at: '2026-11-18T10:00:00Z',
    };
    renderWithProviders(<EstimateResult estimate={e} />);
    expect(screen.getByRole('note')).toHaveTextContent(/^ESTIMATE:/);
    expect(screen.getByText('Rows are spread evenly: 20,833 per table.')).toBeInTheDocument();
    expect(screen.getByText(/Columns per table: 15 assumed/)).toBeInTheDocument();
    expect(screen.getByText(/reports\/rebuild/)).toBeInTheDocument();
    expect(screen.getByText('UNCALIBRATED')).toBeInTheDocument();
  });
});
