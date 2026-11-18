import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { me, mockApi, signInWithFixtureSession } from './support';

/**
 * Key I7 planning flows against FIXTURE API responses (see e2e/support.ts): the plan overview
 * with an uncalibrated pack, a bulk scope decision, a wave plan that does not fit, the cutover
 * comparison, and a pre-sales estimate. Values are synthetic.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const health = { status: 'ok', version: '0.0.0-fixture', checks: [] };

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

const project = {
  id: 'pr1',
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
  roles: ['migration_lead'],
};

const overview = {
  ready: true,
  blueprint_version: 3,
  notes: [],
  missing_packs: [],
  estimation: [
    {
      pack: 'fixture-pattern@1.0.0',
      calibrated: false,
      basis: 'Workshop figures from two past projects.',
      rules: 4,
    },
  ],
  compliance_packs: ['fixture-compliance@1.0.0'],
  max_task_hours: 40,
  discovery_run_id: 'd1',
  delta_run_id: null,
  target_adapter: 'fixture-target@1.0.0',
  counts: { scope: 2, task: 6 },
  scope_approved: 0,
  estimate: { low: 100, likely: 140, high: 210, tasks: 6 },
  waves_fit: false,
  cutover_choice: null,
  latest_baseline: null,
  approved_baseline_id: null,
  can_manage: true,
  can_approve: false,
};

const common = {
  '/api/v1/me': me(['tenant:read']),
  '/api/v1/health': health,
  '/api/v1/projects/pr1': project,
  '/api/v1/projects/pr1/stages': [],
  '/api/v1/projects/pr1/plan': overview,
};

const scopeItem = (key: string, element: string, proposed: string, evidence: string) => ({
  key,
  element,
  kind: 'table',
  stream: 'data',
  concept: null,
  segment: 'dbo',
  props: {},
  proposed,
  evidence: [evidence],
  delta: null,
  status: 'proposed',
  disposition: null,
  decision: null,
  effective: proposed,
});

async function openPlan(page: Page, section: string) {
  await page.goto('/projects/pr1?tab=plan');
  await expect(page.getByRole('tablist', { name: 'Plan sections' })).toBeVisible();
  if (section !== 'Overview') await page.getByRole('tab', { name: section }).click();
}

test('Plan: overview marks uncalibrated packs, scope is decided in bulk with a reason', async ({
  page,
}) => {
  await signInWithFixtureSession(page);
  const { requests } = await mockApi(page, {
    ...common,
    '/api/v1/projects/pr1/plan/scope': {
      total: 2,
      offset: 0,
      dispositions: [
        'migrate',
        'rebuild',
        'replace_with_standard',
        'agentify',
        'archive',
        'retire',
      ],
      counts: { migrate: 1, retire: 1 },
      pending: 2,
      items: [
        scopeItem(
          'table:dbo.party',
          'dbo.party',
          'migrate',
          'Version delta: unchanged; origin unknown.',
        ),
        scopeItem(
          'table:dbo.old_notes',
          'dbo.old_notes',
          'retire',
          'No direct or indirect use in the 90-day activity window.',
        ),
      ],
    },
    'POST /api/v1/projects/pr1/plan/scope/decisions': { decided: 2 },
  });
  await openPlan(page, 'Overview');
  await expect(page.getByText('UNCALIBRATED', { exact: true })).toBeVisible();
  await expect(page.getByText('100–210 h (likely 140)')).toBeVisible();
  await axe(page);

  await page.getByRole('tab', { name: 'Scope' }).click();
  await expect(page.getByText(/Agentify is never proposed automatically/)).toBeVisible();
  await expect(
    page.getByText('No direct or indirect use in the 90-day activity window.'),
  ).toBeVisible();
  await axe(page);
  await page.getByRole('checkbox', { name: 'Select every item on this page' }).click();
  await page.getByRole('button', { name: 'Decide selected' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: /Reason/ }).fill('Agreed in the scope workshop.');
  await axe(page);
  await dialog.getByRole('button', { name: 'Approve proposals' }).click();
  await expect
    .poll(() => requests.find((r) => r.method === 'POST')?.body)
    .toEqual({
      keys: ['table:dbo.party', 'table:dbo.old_notes'],
      disposition: null,
      reason: 'Agreed in the scope workshop.',
    });
});

test('Plan: waves that do not fit show broken constraints, options and load', async ({ page }) => {
  await signInWithFixtureSession(page);
  await mockApi(page, {
    ...common,
    '/api/v1/projects/pr1/plan/waves': {
      waves: [
        {
          key: 'W1',
          name: 'Wave 1',
          start: '2027-01-04',
          end: '2027-02-26',
          cutover: '2027-02-27',
          capacity: { data_sme: 100 },
        },
      ],
      pins: {},
      roles: ['migration_lead', 'data_sme'],
      plan: {
        status: 'optimal',
        fits: false,
        assignments: { 'table:dbo.party': 'W1' },
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
        vendor_dependencies: [],
        items: 2,
        solved_at: '2026-11-18T10:00:00Z',
      },
    },
  });
  await openPlan(page, 'Waves');
  await expect(page.getByRole('heading', { name: 'The plan does not fit' })).toBeVisible();
  await expect(page.getByText(/No work is dropped/)).toBeVisible();
  await expect(page.getByRole('table', { name: /Load against capacity/ })).toContainText(
    '140 of 100 h (over)',
  );
  await expect(page.getByText(/Add 40 hour\(s\) of data_sme capacity/)).toBeVisible();
  await axe(page);
});

test('Plan: cutover options are compared side by side', async ({ page }) => {
  await signInWithFixtureSession(page);
  const option = (opt: string, ok: boolean, risk: number) => ({
    option: opt,
    windows: opt === 'phased' ? 2 : 1,
    longest_window_hours: 30,
    durations_known: true,
    elapsed_days: opt === 'parallel_run' ? 28 : null,
    effort_hours: 40,
    risk,
    risk_factors: [
      {
        factor: 'blast_radius',
        value: 1,
        detail: 'Share of all rows moved in the largest single window.',
      },
    ],
    constraints: [
      { constraint: 'cutover_window', ok, detail: `Longest window 30 h against the allowed 48 h.` },
    ],
    ok,
    steps: 12,
  });
  await mockApi(page, {
    ...common,
    '/api/v1/projects/pr1/plan/runbook': {
      option: null,
      steps: [],
      planned_hours: 0,
      unknown_durations: [],
    },
    '/api/v1/projects/pr1/plan/coexistence': {
      needed: [],
      rules: {},
      warnings: [],
      complete: true,
    },
    'POST /api/v1/projects/pr1/plan/cutover/compare': {
      options: [
        option('whole_estate', true, 3),
        option('phased', false, 2),
        option('parallel_run', true, 2),
      ],
      assumptions: { extract_hours: 2 },
      inputs: {
        entities: [],
        requests_per_minute: 600,
        loads_blocked: false,
        window_hours: 48,
        waves: ['W1', 'W2'],
      },
    },
  });
  await openPlan(page, 'Cutover');
  await page.getByRole('button', { name: 'Compare options' }).click();
  await expect(page.getByRole('region', { name: 'Whole estate' })).toContainText(
    'Meets constraints',
  );
  await expect(page.getByRole('region', { name: 'Phased' })).toContainText('Breaks constraints');
  await expect(page.getByRole('region', { name: 'Parallel run' })).toContainText('28 days');
  await axe(page);
});

test('Pre-sales: an estimate is labelled ESTIMATE and lists its assumptions', async ({ page }) => {
  await signInWithFixtureSession(page);
  const estimate = {
    id: 'e1',
    name: 'Fixture prospect',
    programme_id: null,
    estimation_packs: ['fixture-pattern@1.0.0'],
    questionnaire: {},
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
      unestimated: [],
      basis: [{ pack: 'fixture-pattern@1.0.0', calibrated: false, basis: 'Workshop figures.' }],
    },
    created_by: 'Fixture User',
    created_at: '2026-11-18T10:00:00Z',
  };
  await mockApi(page, {
    '/api/v1/me': me(['presales:estimate']),
    '/api/v1/health': health,
    '/api/v1/presales-estimates': [estimate],
    '/api/v1/presales-estimates/e1': estimate,
  });
  await page.goto('/presales');
  await expect(page.getByRole('heading', { level: 1, name: 'Pre-sales estimates' })).toBeVisible();
  await expect(page.getByRole('note')).toHaveText(/^ESTIMATE:/);
  await expect(page.getByText('Rows are spread evenly: 20,833 per table.')).toBeVisible();
  await axe(page);
});
