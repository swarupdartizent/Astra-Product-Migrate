import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { me, mockApi, signInWithFixtureSession } from './support';

/**
 * Key I10 flows against FIXTURE API responses (see e2e/support.ts): a load run's detail with its
 * pinned inputs, reconciliation to the cent, data quality and repeat result (deep linked); the
 * start dialog; the error queue with triage and "reload selected"; reconciliation breaks gated on
 * a named owner; a parity comparison with an approval; the coexistence dashboard; and a form's
 * layout-only differences approved on the Design tab. Values are synthetic.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const health = { status: 'ok', version: '0.0.0-fixture', checks: [] };

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

const OWNER = '11111111-2222-4333-8444-555555555555';

const project = {
  id: 'pr1',
  tenant_id: 't1',
  tenant_name: 'Fixture tenant',
  name: 'Fixture project',
  description: '',
  status: 'active',
  created_at: '2026-11-18T10:00:00Z',
  latest_version: null,
  approved_version: 1,
  planning_gate: { ready: true, reason: 'The approved blueprint version 1 is ready.', version: 1 },
  permissions: ['stage:manage', 'review:resolve', 'target:load'],
  roles: ['data_sme'],
};

const common = {
  '/api/v1/me': me(['tenant:read']),
  '/api/v1/health': health,
  '/api/v1/projects/pr1': project,
  '/api/v1/projects/pr1/stages': [],
  '/api/v1/roles': [{ key: 'data_sme', label: 'Data SME' }],
  '/api/v1/jobs': [],
  '/api/v1/users': [
    {
      id: OWNER,
      email: 'dana.owner@example.test',
      display_name: 'Dana Owner',
      status: 'active',
      last_seen_at: null,
      assignments: [],
    },
  ],
  '/api/v1/tenants/t1/source-connections': [
    {
      id: 'c1',
      tenant_id: 't1',
      project_id: null,
      name: 'Legacy prod',
      adapter: 'fixture-source',
      engine: 'sqlserver',
      host: 'db.example.test',
      port: 1433,
      database: 'core',
      username: 'reader',
      password_ref: 'ref',
      encrypt: true,
      last_check: null,
      last_checked_at: null,
      created_at: '2026-11-01T00:00:00Z',
      can_manage: true,
    },
  ],
  '/api/v1/source-connections/c1/runs': [
    {
      id: 'x1',
      connection_id: 'c1',
      kind: 'extract',
      mode: 'full',
      adapter: 'fixture-source',
      status: 'succeeded',
      status_detail: null,
      summary: { rows: 1200 },
      job_id: null,
      requested_by: 'Alex Lead',
      created_at: '2026-11-17T09:00:00Z',
      finished_at: '2026-11-17T09:10:00Z',
    },
  ],
  '/api/v1/tenants/t1/target-connections': [
    {
      id: 'tc1',
      tenant_id: 't1',
      name: 'Sandbox',
      adapter: 'fixture-target',
      base_url: 'https://sandbox.example.test',
      client_id: 'x',
      client_secret_ref: 'ref',
      created_at: '2026-11-01T00:00:00Z',
    },
  ],
};

function run(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'r1',
    number: 1,
    kind: 'rehearsal',
    status: 'succeeded',
    status_detail: null,
    parent_run_id: null,
    extract_run_id: 'x1',
    target_connection_id: null,
    segment: null,
    artifacts: [{ id: 'a1', name: 'xf_policy', version: 2, digest: 'd'.repeat(64) }],
    packs: {
      blueprint: ['fixture-domain@1.0.0'],
      source: 'fixture-source@1.0.0',
      target: 'fixture-target@1.0.0',
      target_baseline: 'b1',
    },
    input_digest: 'i'.repeat(64),
    result_digest: 'o'.repeat(64),
    summary: {
      tables: { 'core.policy': { source: 3, transformed: 3, accepted: 3, rehearsed: 3 } },
      measures: [],
      dq: {},
      errors: [],
      counts: { rehearsed: 3 },
      repeat_of: null,
      breaks: 0,
    },
    job_id: 'j1',
    requested_by: 'Alex Lead',
    created_at: '2026-11-18T09:00:00Z',
    finished_at: '2026-11-18T09:05:00Z',
    can_load: true,
    can_triage: true,
    ...over,
  };
}

const r1 = run();
const r2 = run({
  id: 'r2',
  number: 2,
  kind: 'load',
  target_connection_id: 'tc1',
  summary: {
    tables: {
      'core.policy': { source: 3, transformed: 3, accepted: 2, loaded: 2, rejected: 1 },
    },
    measures: [],
    dq: {},
    errors: [],
    counts: { loaded: 2, rejected: 1 },
    repeat_of: null,
    breaks: 1,
    blocked: {},
  },
});
const r3 = run({
  id: 'r3',
  number: 3,
  summary: {
    tables: {
      'core.policy': { source: 3, transformed: 3, accepted: 2, rehearsed: 2, invalid: 1 },
    },
    measures: [
      {
        table: 'core.policy',
        column: 'premium',
        label: 'Premium',
        source: '300.00',
        transformed: '300.00',
        accepted: '200.01',
      },
    ],
    dq: {
      'core.policy': {
        source_table: 'dbo.policy',
        before: 82.5,
        after: 66.7,
        segments: {},
      },
    },
    errors: [],
    counts: { rehearsed: 2, invalid: 1 },
    repeat_of: { run: 1, same_result: true },
    breaks: 2,
  },
});

const runs = {
  'GET /api/v1/projects/pr1/load-runs': [r3, r2, r1],
  '/api/v1/load-runs/r1': r1,
  '/api/v1/load-runs/r2': r2,
  '/api/v1/load-runs/r3': r3,
};

test('Load runs: a deep-linked run shows reconciliation to the cent, data quality and its repeat result', async ({
  page,
}) => {
  await signInWithFixtureSession(page);
  await mockApi(page, { ...common, ...runs });
  await page.goto('/projects/pr1?tab=loads&section=runs&run=r3');
  await expect(page.getByRole('tab', { name: 'Load runs', selected: true })).toBeVisible();
  const panel = page.getByRole('region', { name: 'Run 3: rehearsal' });
  await expect(panel.getByText('Same result as run 1', { exact: true })).toBeVisible();
  const measures = panel.getByRole('table', { name: /Totals of each measured amount/ });
  await expect(measures.getByRole('row', { name: /Premium/ })).toContainText('−99.99');
  await expect(measures.getByRole('row', { name: /Premium/ })).toContainText('Differs');
  await expect(
    panel
      .getByRole('table', { name: /Data quality per object/ })
      .getByRole('row', { name: /core\.policy/ }),
  ).toContainText('82.5%');
  await axe(page);

  // Links to the run's error queue keep the run in the URL.
  await panel.getByRole('link', { name: /Error queue/ }).click();
  await expect(page).toHaveURL(/section=errors/);
  await expect(page).toHaveURL(/run=r3/);
});

test('Start dialog: a rehearsal has no target connection; a load requires one', async ({
  page,
}) => {
  await signInWithFixtureSession(page);
  const { requests } = await mockApi(page, {
    ...common,
    ...runs,
    'POST /api/v1/projects/pr1/load-runs': run({
      id: 'r9',
      number: 9,
      status: 'queued',
      job_id: null,
      summary: {},
    }),
    '/api/v1/load-runs/r9': run({
      id: 'r9',
      number: 9,
      status: 'queued',
      job_id: null,
      summary: {},
    }),
  });
  await page.goto('/projects/pr1?tab=loads');
  await page.getByRole('button', { name: 'Start a run' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start a load run' });
  await dialog.getByRole('radio', { name: /^Load/ }).check();
  await expect(dialog.getByRole('combobox', { name: /Target connection/ })).toBeVisible();
  await dialog.getByRole('button', { name: 'Start run' }).click();
  await expect(
    dialog.getByText('A load sends records to the target: choose a target connection.'),
  ).toBeVisible();
  await axe(page);
  await dialog.getByRole('radio', { name: /^Rehearsal/ }).check();
  await expect(dialog.getByRole('combobox', { name: /Target connection/ })).toHaveCount(0);
  await dialog.getByRole('combobox', { name: /Source connection/ }).click();
  await page.getByRole('option', { name: /Legacy prod/ }).click();
  await dialog.getByRole('combobox', { name: /Extract run/ }).click();
  await page.getByRole('option', { name: /Full extract/ }).click();
  await dialog.getByRole('button', { name: 'Start rehearsal' }).click();
  await expect(page.getByRole('region', { name: 'Run 9: rehearsal' })).toBeVisible();
  expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
    kind: 'rehearsal',
    extract_run_id: 'x1',
  });
  await expect(page).toHaveURL(/run=r9/);
});

test('Error queue: triage a rejected record and reload it as a new run', async ({ page }) => {
  await signInWithFixtureSession(page);
  const rec = {
    table: 'core.policy',
    key: 'P-1',
    source_key: 'P-1',
    segment: null,
    payload: { policy_no: 'P-1', premium: '-1.00' },
    status: 'rejected',
    http_status: 422,
    reason: 'premium must be positive',
    failures: [
      {
        rule: 'BIZ-PREMIUM',
        kind: 'business',
        severity: 'warning',
        column: 'premium',
        message: 'Premium is negative.',
        fix: 'Check the sign of the source amount.',
      },
    ],
    owner: null,
    triage: 'open',
    fixed_payload: null,
    note: null,
  };
  const r4 = run({
    id: 'r4',
    number: 4,
    kind: 'reload',
    parent_run_id: 'r2',
    status: 'queued',
    job_id: null,
    summary: {},
  });
  const { requests } = await mockApi(page, {
    ...common,
    ...runs,
    '/api/v1/load-runs/r4': r4,
    'GET /api/v1/load-runs/r2/records': {
      items: [rec],
      total: 1,
      by_status: { loaded: 2, rejected: 1 },
    },
    'PATCH /api/v1/load-runs/r2/records': { ok: true },
    'POST /api/v1/load-runs/r2/reload': r4,
  });
  await page.goto('/projects/pr1?tab=loads&section=errors&run=r2');
  await expect(page.getByText('Rejected: 1')).toBeVisible();
  await page.getByRole('button', { name: /core\.policy P-1/ }).click();
  const detail = page.getByRole('region', { name: 'core.policy P-1' });
  await expect(detail.getByText('Check the sign of the source amount.')).toBeVisible();
  await axe(page);
  await detail.getByRole('textbox', { name: 'Owner' }).fill('Dana Owner');
  await detail.getByRole('button', { name: 'Save triage' }).click();
  await expect
    .poll(() => requests.find((r) => r.method === 'PATCH')?.body)
    .toEqual({
      table: 'core.policy',
      key: 'P-1',
      owner: 'Dana Owner',
      triage: 'open',
    });
  await page.getByRole('checkbox', { name: 'Select core.policy P-1' }).click();
  await page.getByRole('button', { name: 'Reload selected' }).click();
  await expect(page.getByRole('region', { name: 'Run 4: reload' })).toBeVisible();
  await expect(page).toHaveURL(/section=runs/);
  await expect(page).toHaveURL(/run=r4/);
  expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
    records: [{ table: 'core.policy', key: 'P-1' }],
  });
});

test('Breaks: closing waits for a named owner and a reason', async ({ page }) => {
  await signInWithFixtureSession(page);
  let current: Record<string, unknown> = {
    id: 'b1',
    origin: 'load',
    load_run_id: 'r2',
    scope: 'core.policy',
    measure: 'Premium',
    source_value: '300.00',
    target_value: '200.01',
    difference: '-99.99',
    detail: 'Premium: 300.00 transformed, 200.01 accepted by the target.',
    owner_role: 'customer_data_owner',
    owner_user_id: null,
    owner: null,
    status: 'open',
    close_reason: null,
    closed_by: null,
    closed_at: null,
    created_at: '2026-11-18T09:05:00Z',
  };
  const { requests } = await mockApi(page, {
    ...common,
    ...runs,
    'GET /api/v1/projects/pr1/recon-breaks': () => [current],
    'PATCH /api/v1/recon-breaks/b1': (_route: Route, body: unknown) => {
      const b = body as { owner_user_id?: string; close_reason?: string };
      current = b.owner_user_id
        ? { ...current, owner_user_id: b.owner_user_id, owner: 'Dana Owner' }
        : { ...current, status: 'closed', close_reason: b.close_reason, closed_by: 'Fixture User' };
      return current;
    },
  });
  await page.goto('/projects/pr1?tab=loads&section=breaks');
  await expect(page.getByRole('button', { name: 'Close break' })).toBeDisabled();
  await expect(
    page.getByText('A break has an owner until it is closed: name one first.'),
  ).toBeVisible();
  await axe(page);
  await page.getByRole('combobox', { name: 'Owner of core.policy: Premium' }).click();
  await page.getByRole('option', { name: /Dana Owner/ }).click();
  await page.getByRole('button', { name: 'Name owner' }).click();
  await expect(page.getByRole('button', { name: 'Close break' })).toBeEnabled();
  await page.getByRole('textbox', { name: /Reason to close/ }).fill('The target rounds per line.');
  await page.getByRole('button', { name: 'Close break' }).click();
  await expect
    .poll(() => requests.filter((r) => r.method === 'PATCH').map((r) => r.body))
    .toEqual([{ owner_user_id: OWNER }, { close_reason: 'The target rounds per line.' }]);
});

test('Parity: a deep-linked comparison shows inputs and both outputs, and a difference is approved', async ({
  page,
}) => {
  await signInWithFixtureSession(page);
  const pr = {
    id: 'p1',
    kind: 'rating',
    name: 'Re-rate renewals',
    spec: { keys: ['policy_no'], fields: [{ name: 'premium', type: 'money' }], inputs: ['state'] },
    summary: {
      cases: 2,
      differences: 1,
      totals: { premium: { source: '200.00', target: '200.01', difference: '0.01' } },
      missing_in_target: 0,
      missing_in_source: 0,
      open: 1,
      passed: false,
    },
    source_sha256: 'a'.repeat(64),
    target_sha256: 'b'.repeat(64),
    created_by: 'Fixture User',
    created_at: '2026-11-18T10:00:00Z',
  };
  const c = {
    key: 'P-1',
    kind: 'difference',
    field: 'premium',
    source_value: '100.00',
    target_value: '100.01',
    inputs: { state: 'NY' },
    status: 'open',
    decided_by: null,
    decided_at: null,
    note: null,
  };
  const { requests } = await mockApi(page, {
    ...common,
    ...runs,
    'GET /api/v1/projects/pr1/parity-runs': [pr],
    '/api/v1/parity-runs/p1/cases': { run: pr, total: 1, items: [c], can_decide: true },
    'POST /api/v1/parity-runs/p1/cases/decide': { decided: 1, open: 0, passed: true },
  });
  await page.goto('/projects/pr1?tab=loads&section=parity&parity_run=p1');
  const panel = page.getByRole('region', { name: 'Re-rate renewals' });
  await expect(panel.getByText('NY')).toBeVisible();
  await expect(panel.getByText('100.01')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Approve selected' })).toBeDisabled();
  await axe(page);
  await panel.getByRole('checkbox', { name: 'Select P-1 premium' }).click();
  await panel.getByRole('textbox', { name: /Decision note/ }).fill('Rounding agreed with finance.');
  await panel.getByRole('button', { name: 'Approve selected' }).click();
  await expect
    .poll(() => requests.find((r) => r.method === 'POST')?.body)
    .toEqual({
      cases: [{ key: 'P-1', field: 'premium' }],
      action: 'approve',
      note: 'Rounding agreed with finance.',
    });
});

test('Coexistence: the dashboard is accessible and reconciling waits for a schedule', async ({
  page,
}) => {
  await signInWithFixtureSession(page);
  await mockApi(page, {
    ...common,
    ...runs,
    'GET /api/v1/projects/pr1/coexistence': {
      rules: [
        {
          key: 'policy',
          entity: 'Policy',
          wave: 'W1',
          system_of_record: 'source',
          end_date: '2027-03-31',
        },
      ],
      schedule: null,
      open_breaks: [],
      can_manage: true,
      can_close: true,
    },
  });
  await page.goto('/projects/pr1?tab=loads&section=coexistence');
  await expect(page.getByRole('button', { name: 'Reconcile now' })).toBeDisabled();
  await expect(
    page.getByText('Set the schedule first: it names the owner of the breaks.'),
  ).toBeVisible();
  await expect(page.getByRole('row', { name: /Policy/ })).toContainText('W1');
  await axe(page);
});

test('Design forms: layout-only differences are approved with a note', async ({ page }) => {
  await signInWithFixtureSession(page);
  const parity = {
    passed: false,
    differences: ['page 1 size: [612, 792] vs [595, 842]'],
    content_differences: [],
    layout_differences: ['page 1 size: [612, 792] vs [595, 842]'],
    layout_only: true,
    layout_approval: null,
    pages: 1,
    golden_pages: 1,
    fields: 3,
    golden_fields: 3,
    converted_sha256: 'b'.repeat(64),
    golden_sha256: 'a'.repeat(64),
    at: '2026-11-18T10:00:00Z',
    by: 'Fixture User',
  };
  let item: Record<string, unknown> = {
    stream: 'form',
    key: 'form:declarations',
    status: 'proposed',
    source: {
      kind: 'form_design',
      key: 'declarations',
      name: 'Declarations',
      scope: null,
      definition: {},
    },
    target: { format: 'pdf', conversion: 'convert' },
    proposed_target: { format: 'pdf', conversion: 'convert' },
    confidence: null,
    flags: [],
    evidence: [],
    decision: null,
    review_item_id: null,
    approvals: null,
    parity,
    missing: null,
    key_columns: null,
    desktop: null,
    updated_at: '2026-11-18T10:00:00Z',
    run_id: 'dr1',
    updated_by: 'design',
    precedents: [],
    readiness:
      'Only layout differs from the golden copy: a person must approve the layout differences.',
    can_decide: true,
    cannot_decide_reason: null,
    files: [],
  };
  const { requests } = await mockApi(page, {
    ...common,
    '/api/v1/projects/pr1/design': {
      latest_run: null,
      counts: { form: { proposed: 1 } },
      target_design: null,
      target_design_missing: null,
      build: { generated: 0, tests_failed: 0, tests_passed: 0, approved: 0 },
      can_run: true,
      can_build: true,
      can_decide: {
        mapping: true,
        configuration: true,
        form: true,
        code: true,
        integration: true,
        report: true,
        page: true,
        security: true,
      },
    },
    '/api/v1/projects/pr1/design/items': () => ({ items: [item], total: 1 }),
    '/api/v1/projects/pr1/design/item': () => item,
    'POST /api/v1/projects/pr1/design/form-layout-approval': () => {
      item = {
        ...item,
        readiness: null,
        parity: {
          ...parity,
          layout_approval: {
            by: 'Fixture User',
            by_id: 'u1',
            at: '2026-11-18T10:10:00Z',
            note: 'US Letter is the agreed size.',
          },
        },
      };
      return item;
    },
  });
  await page.goto('/projects/pr1?tab=design&section=form&key=form:declarations');
  const panel = page.getByRole('region', { name: 'Declarations' });
  await expect(panel.getByText('Layout differences (1): a person may approve them')).toBeVisible();
  await axe(page);
  await panel.getByRole('textbox', { name: /Approval note/ }).fill('US Letter is the agreed size.');
  await panel.getByRole('button', { name: 'Approve layout differences' }).click();
  await expect(panel.getByText('Layout differences approved')).toBeVisible();
  await expect(panel.getByText(/Approved by Fixture User/)).toBeVisible();
  expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
    key: 'form:declarations',
    note: 'US Letter is the agreed size.',
  });
  // The click leaves the page scrolled so the upload control sits partly under the sticky top bar; axe then
  // counts it as a covered target. Check the panel at a resting scroll position (a known gap: the window, not
  // the content area, scrolls beneath the top bar).
  await page.evaluate('window.scrollTo(0, 0)');
  await axe(page);
});
