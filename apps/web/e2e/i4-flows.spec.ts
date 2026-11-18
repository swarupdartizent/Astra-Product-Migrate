import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { me, mockApi, signInWithFixtureSession } from './support';

/**
 * Key I4 flows against FIXTURE API responses (see e2e/support.ts): a blocked load, a failing
 * golden measure, a writable-account check and harvest coverage. Values are synthetic.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const ALL = ['tenant:read', 'audit:read', 'access:read'];
const health = { status: 'ok', version: '0.0.0-fixture', checks: [] };

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

const tenant = {
  id: 't1',
  slug: 'fixture-tenant',
  name: 'Fixture tenant',
  region_code: 'local-a',
  region_name: 'Local A',
  programme_id: null,
  programme_name: null,
  partner_id: null,
  partner_name: null,
  status: 'active',
  status_detail: null,
  key_name: 'fixture-key',
  mfa_required: true,
  session_timeout_minutes: 60,
  created_at: '2026-11-18T10:00:00Z',
  deleted_at: null,
  permissions: ['tenant:read', 'target:load'],
  active_job: null,
};

function adapterRun(over: Record<string, unknown>) {
  return {
    id: 'r1',
    connection_id: 'c1',
    kind: 'check',
    mode: null,
    adapter: 'fixture-source@1.0.0',
    status: 'succeeded',
    status_detail: null,
    summary: {},
    job_id: null,
    requested_by: 'Fixture User',
    created_at: '2026-11-18T10:00:00Z',
    finished_at: '2026-11-18T10:00:05Z',
    ...over,
  };
}

const BLOCKED_ERROR = "Blocked: the target's API endpoints are not yet recorded.";

test('Targets: a load whose job fails with "Blocked:" reads as Blocked', async ({ page }) => {
  await signInWithFixtureSession(page);
  const load = {
    method: 'rest_api',
    auth: 'oauth2_client_credentials',
    token_path: null,
    scopes: [],
    // Endpoints are recorded but the token path is not, so the API blocks the load.
    endpoints: [{ entity: 'party', method: 'POST', path: '/parties', batch_size: 50 }],
    rate_limit: {
      requests_per_minute: 60,
      burst: 5,
      source: { reference: 'Fixture source' },
      recorded_on: '2026-11-01',
    },
    approved_tools: [],
  };
  const { requests } = await mockApi(page, {
    '/api/v1/me': me(ALL),
    '/api/v1/health': health,
    '/api/v1/tenants/t1': tenant,
    '/api/v1/tenants/t1/target-connections': [
      {
        id: 'tc1',
        tenant_id: 't1',
        name: 'fixture-target',
        adapter: 'fixture-target@1.0.0',
        base_url: 'https://target.example.test',
        client_id: 'fixture-client',
        client_secret_ref: 'secret://fixture/target',
        created_at: '2026-11-18T10:00:00Z',
      },
    ],
    '/api/v1/target-connections/tc1/calls': [],
    '/api/v1/adapters/fixture-target/1.0.0/constraints': {
      adapter: 'fixture-target@1.0.0',
      validated: false,
      load,
      constraints: [],
    },
    'POST /api/v1/target-connections/tc1/loads': { job_id: 'j1' },
    '/api/v1/jobs/j1': {
      id: 'j1',
      kind: 'target.load',
      title: 'Load party',
      status: 'failed',
      progress: 0,
      progress_message: null,
      can_cancel: false,
      result: null,
      error: BLOCKED_ERROR,
      attempts: 1,
      max_attempts: 1,
      tenant_id: 't1',
      project_id: null,
      requested_by: 'Fixture User',
      trace_id: null,
      created_at: '2026-11-18T10:00:00Z',
      started_at: '2026-11-18T10:00:01Z',
      finished_at: '2026-11-18T10:00:02Z',
    },
  });
  await page.goto('/tenants/t1?tab=targets');
  await expect(page.getByText(/Loads are Blocked: the target's API endpoints/)).toBeVisible();
  await axe(page);
  await page.getByRole('button', { name: 'Load records' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Entity' })).toContainText('party');
  await dialog.getByRole('textbox', { name: /Records/ }).fill('[{"name": "Fixture"}]');
  await dialog.getByRole('textbox', { name: /Reason/ }).fill('Fixture load to check blocking');
  await axe(page);
  await dialog.getByRole('button', { name: 'Start load' }).click();
  await expect.poll(() => requests.some((r) => r.method === 'POST')).toBe(true);
  await expect(page.getByText(BLOCKED_ERROR)).toBeVisible();
  await expect(page.getByText('Failed', { exact: true })).toHaveCount(0);
  await axe(page);
});

test('Golden datasets: a failing measure shows expected vs actual', async ({ page }) => {
  await signInWithFixtureSession(page);
  const dataset = 'fixture-source@1.0.0:small';
  const goldenRun = {
    id: 'g1',
    dataset,
    packs: { 'fixture-source@1.0.0': 'sha256:fixture' },
    status: 'failed',
    status_detail: null,
    scorecard: {
      dataset,
      database: 'golden_fixture',
      passed: false,
      measures: [
        {
          name: 'object_count',
          passed: true,
          expected: 10,
          actual: 10,
          precision: null,
          recall: null,
          detail: 'Matches.',
        },
        {
          name: 'trap_hits',
          passed: false,
          expected: ['T-1', 'T-2'],
          actual: ['T-1'],
          precision: 1,
          recall: 0.5,
          detail: 'Missed T-2.',
        },
      ],
    },
    keep: false,
    job_id: null,
    started_by: 'Fixture User',
    started_at: '2026-11-18T10:00:00Z',
    finished_at: '2026-11-18T10:02:00Z',
  };
  await mockApi(page, {
    '/api/v1/me': me([...ALL, 'golden:run']),
    '/api/v1/health': health,
    '/api/v1/golden-datasets': [
      {
        dataset,
        adapter: 'fixture-source@1.0.0',
        adapter_status: 'published',
        name: 'small',
        engine: 'sqlserver',
        description: 'A small synthetic estate.',
        last_run: { id: 'g1', status: 'failed', started_at: '2026-11-18T10:00:00Z' },
      },
    ],
    '/api/v1/golden-datasets/fixture-source/1.0.0/small/files': {
      dataset: { description: 'A small synthetic estate.' },
      expected: { trap_hits: ['T-1', 'T-2'] },
      files: ['dataset.yaml', 'expected.yaml'],
    },
    '/api/v1/golden-runs': [goldenRun],
    '/api/v1/golden-runs/g1': goldenRun,
    '/api/v1/packs': [],
  });
  await page.goto(`/golden?dataset=${encodeURIComponent(dataset)}`);
  const table = page.getByRole('table', { name: /Golden run scorecard/ });
  const row = table.getByRole('row', { name: /trap_hits/ });
  await expect(row.getByText('Fail', { exact: true })).toBeVisible();
  await expect(row).toContainText('Missed T-2.');
  await expect(row).toContainText('50.0%');
  await expect(page.getByLabel('Expected Trap hits')).toContainText('T-2');
  await axe(page);
});

test('Sources: a check on a writable account says adapters need read-only accounts', async ({
  page,
}) => {
  await signInWithFixtureSession(page);
  await mockApi(page, {
    '/api/v1/me': me(ALL),
    '/api/v1/health': health,
    '/api/v1/adapter-runs/r1': {
      run: adapterRun({
        status: 'failed',
        status_detail: 'The connection check found problems.',
        summary: {
          ok: false,
          engine: 'sqlserver',
          engine_version: '16.0',
          edition: 'Developer',
          database: 'fixture_db',
          login: 'fixture_login',
          read_only: false,
          read_only_evidence: ['member of db_datawriter'],
          supported: true,
          problems: ['The login can write.'],
        },
      }),
    },
  });
  await page.goto('/adapter-runs/r1');
  await expect(
    page.getByText(
      'This account can write to the source. Adapters only run with read-only accounts.',
    ),
  ).toBeVisible();
  await expect(page.getByText('The login can write.')).toBeVisible();
  await axe(page);
});

test('Sources: a harvest shows its coverage table', async ({ page }) => {
  await signInWithFixtureSession(page);
  await mockApi(page, {
    '/api/v1/me': me(ALL),
    '/api/v1/health': health,
    '/api/v1/adapter-runs/r1': {
      run: adapterRun({
        kind: 'harvest',
        summary: {
          objects: 12,
          objects_by_type: { table: 10, procedure: 2 },
          coverage_complete: false,
        },
      }),
      coverage: [
        {
          object_type: 'table',
          label: 'Tables',
          required: true,
          status: 'complete',
          count: 10,
          error: null,
          dependencies: null,
          code_missing: null,
        },
        {
          object_type: 'procedure',
          label: 'Procedures',
          required: true,
          status: 'failed',
          count: 2,
          error: 'Permission denied on the catalogue view.',
          dependencies: 0,
          code_missing: 2,
        },
      ],
      traps: [
        {
          trap_id: 'T-1',
          origin: 'pack',
          title: 'Temporary tables in use',
          severity: 'medium',
          stream: 'data',
          advice: 'Check before extract.',
          hits: ['dbo.tmp_one'],
        },
      ],
    },
    '/api/v1/adapter-runs/r1/objects': {
      total: 1,
      offset: 0,
      items: [
        {
          object_type: 'procedure',
          schema: 'dbo',
          name: 'fixture_proc',
          owner: null,
          modified_at: null,
          has_code: true,
          definition_sha256: null,
          depends_on: [],
          detail: null,
        },
      ],
    },
  });
  await page.goto('/adapter-runs/r1');
  const table = page.getByRole('table', { name: /Coverage by object type/ });
  await expect(table.getByRole('row', { name: /Procedures/ })).toContainText(
    'Permission denied on the catalogue view.',
  );
  await expect(page.getByLabel('Hits for T-1')).toHaveText('dbo.tmp_one');
  await axe(page);
});
