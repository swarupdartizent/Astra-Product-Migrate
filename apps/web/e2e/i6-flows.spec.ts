import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { me, mockApi, signInWithFixtureSession } from './support';

/**
 * Key I6 flows against FIXTURE API responses (see e2e/support.ts): the version delta with its
 * download, a blocked conversion and a failed recorded test, a duplicate test name (409), and the
 * hosting checklist. Values are synthetic.
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
  permissions: ['stage:manage', 'source:manage'],
  roles: ['migration_lead'],
};

const common = {
  '/api/v1/me': me(['tenant:read']),
  '/api/v1/health': health,
  '/api/v1/projects/pr1': project,
  '/api/v1/projects/pr1/stages': [],
};

const deltaRun = {
  id: 'd1',
  project_id: 'pr1',
  connection_id: 'c1',
  connection_name: 'fixture-source',
  baseline: 'fixture-target / v2 (2.0)',
  standard_baseline: null,
  status: 'succeeded',
  status_detail: null,
  counts: { unchanged: 7, renamed_or_moved: 2, changed_behaviour: 1, removed_in_target: 1 },
  origin_counts: { unknown: 11 },
  not_in_scope: 1,
  new_in_target: 2,
  input_digest: 'in-digest',
  result_digest: 'out-digest',
  advice: {},
  job_id: null,
  requested_by: 'Fixture User',
  created_at: '2026-11-18T10:00:00Z',
  finished_at: '2026-11-18T10:01:00Z',
};

test('Version delta: groups, origins, differences and a CSV download', async ({ page }) => {
  await signInWithFixtureSession(page);
  const { requests } = await mockApi(page, {
    ...common,
    '/api/v1/projects/pr1/pattern-advice': {
      chosen: 'cross_product',
      recommended: 'same_family_upgrade',
      agrees: false,
      reasons: [
        '9 of 11 comparable source objects (82%) exist in the target unchanged, renamed or moved.',
      ],
      delta_run_id: 'd1',
    },
    '/api/v1/projects/pr1/delta-runs': [deltaRun],
    '/api/v1/delta-runs/d1/lists': {
      not_in_scope: ['workflow:dbo.flow'],
      new_in_target: ['table:core.audit', 'view:core.v'],
      problems: [],
    },
    '/api/v1/delta-runs/d1/differences': {
      total: 1,
      offset: 0,
      groups: [],
      items: [
        {
          group: 'removed_in_target',
          type: 'table',
          source: 'dbo.legacy_notes',
          target: null,
          origin: 'unknown',
          details: { closest: 'core.notes', similarity: 0.5 },
        },
      ],
    },
    '/api/v1/delta-runs/d1/export': () => 'group,type,source,target,origin,details\n',
  });
  await page.goto('/projects/pr1?tab=delta');
  await expect(page.getByText(/A proposal went to the/)).toBeVisible();
  await expect(page.getByText(/stated as unknown, not guessed/)).toBeVisible();
  const table = page.getByRole('table', { name: 'Version delta differences' });
  await expect(table).toContainText('below the rename threshold');
  await axe(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.csv$/);
  expect(requests.some((r) => r.path === '/api/v1/delta-runs/d1/export')).toBe(true);
});

test('Conversion: a blocked run says why, a failed test shows inputs and differences', async ({
  page,
}) => {
  await signInWithFixtureSession(page);
  const run = (over: Record<string, unknown>) => ({
    id: 'r1',
    project_id: 'pr1',
    connection_id: 'c1',
    connection_name: 'fixture-source',
    baseline: 'fixture-target / v2 (2.0)',
    source_dialect: 'sqlanywhere',
    target_dialect: 'sqlserver',
    status: 'succeeded',
    status_detail: null,
    summary: {
      objects: 1,
      compiled: 1,
      compile_failed: 0,
      review: 0,
      tests: { passed: 0, failed: 1 },
      code_unreadable: 0,
      workbench_tables: 12,
    },
    job_id: null,
    requested_by: 'Fixture User',
    created_at: '2026-11-18T10:00:00Z',
    finished_at: '2026-11-18T10:02:00Z',
    ...over,
  });
  const object = {
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
  };
  await mockApi(page, {
    ...common,
    '/api/v1/projects/pr1/conversion-runs': [
      run({}),
      run({
        id: 'r0',
        status: 'blocked',
        status_detail: 'No workbench is configured on this deployment.',
        summary: {},
        created_at: '2026-11-17T10:00:00Z',
      }),
    ],
    '/api/v1/projects/pr1/conversion-tests': [],
    '/api/v1/conversion-runs/r1/objects': { total: 1, offset: 0, items: [object] },
    '/api/v1/conversion-runs/r1/object': {
      ...object,
      source: 'CREATE PROCEDURE calc AS SELECT IFNULL(a, 0)',
      converted: 'CREATE PROCEDURE dbo.calc AS SELECT ISNULL(a, 0)',
    },
    'POST /api/v1/projects/pr1/conversion-tests': {
      __problem: true,
      type: '/problems/conflict',
      title: 'A test case with this name already exists for this object.',
      status: 409,
    },
  });
  await page.goto('/projects/pr1?tab=conversion');
  await page.getByRole('row', { name: /dbo\.calc/ }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByLabel('Inputs of Base case')).toContainText('"id": 7');
  await expect(sheet.getByLabel('Differences of Base case')).toHaveText(
    'value: expected 11, got 10',
  );
  await expect(sheet.getByLabel('Converted code of dbo.calc')).toContainText('ISNULL');
  await axe(page);
  await page.keyboard.press('Escape');

  await page
    .getByRole('button', { name: /fixture-source: sqlanywhere to sqlserver/ })
    .nth(1)
    .click();
  await expect(page.getByText('No workbench is configured on this deployment.')).toBeVisible();

  await page.getByRole('button', { name: 'Record a test' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: /Source object/ }).fill('dbo.calc');
  await dialog.getByRole('textbox', { name: /Test name/ }).fill('Base case');
  await dialog.getByRole('textbox', { name: /Expected result/ }).fill('11');
  await dialog.getByRole('button', { name: 'Record test' }).click();
  await expect(
    dialog.getByText('A test case with this name already exists for this object.'),
  ).toBeVisible();
  await axe(page);
});

test('Hosting checklist: generic items are marked, sync adds the missing ones', async ({
  page,
}) => {
  await signInWithFixtureSession(page);
  const item = {
    id: 'i1',
    key: 'generic:printing',
    category: 'printing',
    category_title: 'Printing',
    title: 'Make printing work from the hosted product',
    detail: 'Confirm how documents print from the hosted product.',
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
  };
  const before = {
    items: [item],
    adapter: 'fixture-target@1.0.0',
    missing: ['adapter:SSO-1'],
    areas: ['sso', 'mfa', 'network', 'printing'],
    complete: false,
    done: 0,
    total: 1,
    can_manage: true,
  };
  const after = {
    ...before,
    missing: [],
    total: 2,
    items: [
      item,
      {
        ...item,
        id: 'i2',
        key: 'adapter:SSO-1',
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
        owner_role: 'customer_it_security_lead',
      },
    ],
  };
  await mockApi(page, {
    ...common,
    '/api/v1/projects/pr1/checklist': before,
    'POST /api/v1/projects/pr1/checklist/sync': after,
  });
  await page.goto('/projects/pr1?tab=checklist');
  await expect(page.getByText('Generic: confirm with the vendor')).toBeVisible();
  await axe(page);
  await page.getByRole('button', { name: 'Add 1 missing item' }).click();
  await expect(page.getByText('SSO-1')).toBeVisible();
  await expect(page.getByText('Fixture hosting guide')).toBeVisible();
  await axe(page);
});
