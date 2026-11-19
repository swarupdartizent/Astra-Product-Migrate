import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { me, mockApi, signInWithFixtureSession } from './support';

/**
 * Key I12 flows against FIXTURE API responses (see e2e/support.ts): a partner's view of the
 * programme; the owner's set-up with the weight check and a new pod; recording consent and
 * running a light scan with its index breakdown; and running the portfolio planner then
 * exporting gate evidence. Names and values are synthetic.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const health = { status: 'ok', version: '0.0.0-fixture', checks: [] };

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

const PR = '/api/v1/programmes/p1';

const common = {
  '/api/v1/me': me(['tenant:read', 'programme:manage']),
  '/api/v1/health': health,
  '/api/v1/roles': [],
  '/api/v1/jobs': [],
};

const MEASURES: [string, string, number, number, number][] = [
  ['tables', 'Tables', 0.1, 50, 1500],
  ['columns', 'Columns', 0.05, 500, 30000],
  ['custom_tables', 'Customer-specific tables', 0.15, 0, 100],
  ['code_objects', 'Code objects', 0.15, 0, 800],
  ['code_lines', 'Lines of code', 0.1, 0, 200000],
  ['interfaces', 'Interface objects', 0.15, 0, 60],
  ['configuration_items', 'Configuration items', 0.1, 0, 3000],
  ['data_volume_log10', 'Data volume (log10 of rows)', 0.1, 4, 9],
  ['documents_log10', 'Documents (log10)', 0.05, 2, 7],
  ['traps', 'Known traps that apply', 0.05, 0, 20],
];

type Detail = Record<string, unknown> & {
  partners: { id: string; name: string; pods: { id: string; name: string; capacity: number }[] }[];
};

function detail(over: Record<string, unknown> = {}): Detail {
  return {
    id: 'p1',
    name: 'Fixture programme',
    description: 'Installed base upgrade',
    source_adapter: null,
    target_adapter: null,
    blueprint_template: null,
    packs: [],
    segments: ['Region north', 'Region south'],
    band_effort_weeks: { simple: 8, medium: 16, complex: 26 },
    mci: {
      measures: MEASURES.map(([key, label]) => ({ key, label })),
      weights: Object.fromEntries(MEASURES.map(([k, , w]) => [k, w])),
      ranges: Object.fromEntries(MEASURES.map(([k, , , lo, hi]) => [k, [lo, hi]])),
      bands: { simple: 35, medium: 65 },
    },
    partners: [
      { id: 'pa', name: 'Partner A', pods: [{ id: 'pod1', name: 'Pod one', capacity: 2 }] },
      { id: 'pb', name: 'Partner B', pods: [] },
    ],
    waves: [
      { key: 'w1', name: 'Wave one', start: '2027-01-04', end: '2027-03-01' },
      { key: 'w2', name: 'Wave two', start: '2027-03-08', end: '2027-07-05' },
    ],
    customers: [
      { id: 't1', name: 'Customer One', partner_id: 'pa', segment: 'Region north' },
      { id: 't2', name: 'Customer Two', partner_id: null, segment: null },
    ],
    scope: 'programme',
    can_manage: true,
    can_scan: true,
    ...over,
  };
}

const viewCustomer = {
  customer_id: 't1',
  customer: 'Customer One',
  partner_id: 'pa',
  partner: 'Partner A',
  segment: 'Region north',
  band: 'medium',
  score: 42.5,
  scanned_at: '2026-11-18T09:05:00Z',
  gates: [{ project: 'Upgrade', project_id: 'pr1', passed: 3, of: 8, next_gate: 'design' }],
  open_vendor_gaps: 2,
  has_gaps: true,
  open_breaks: 1,
  last_load: { number: 4, kind: 'rehearsal', counts: { loaded: 1200, rejected: 3 } },
  open_risks: 5,
  actual_hours: 120,
};

const consent = {
  id: 'c1',
  signatory_name: 'Dana Signer',
  signatory_title: 'Chief Information Officer',
  scope: 'Metadata and counts of the policy administration database.',
  reference: 'DMS-0042',
  recorded_by: 'Fixture User',
  recorded_at: '2026-11-17T10:00:00Z',
  active: true,
  revoked_at: null,
  revoked_by: null,
  revoke_reason: null,
};

const scan = {
  id: 's1',
  tenant_id: 't1',
  status: 'succeeded',
  status_detail: null,
  measures: { tables: 775, rows: 120000, data_volume_log10: 5.079 },
  mci: {
    score: 42.5,
    band: 'medium',
    bands: { simple: 35, medium: 65 },
    formula: '100 × Σ weight × clamp((value − low) / (high − low), 0, 1)',
    measures: MEASURES.map(([key, label, weight, low, high]) => ({
      key,
      label,
      value: key === 'tables' ? 775 : low,
      low,
      high,
      normalised: key === 'tables' ? 0.5 : 0,
      weight,
      contribution: key === 'tables' ? 5 : 0,
    })),
  },
  job_id: 'j1',
  consent_id: 'c1',
  requested_by: 'Fixture User',
  created_at: '2026-11-18T09:00:00Z',
  finished_at: '2026-11-18T09:05:00Z',
};

test('Overview: a partner sees only its own customers', async ({ page }) => {
  await signInWithFixtureSession(page);
  await mockApi(page, {
    ...common,
    '/api/v1/me': me(['tenant:read']),
    [`GET ${PR}`]: detail({
      scope: 'partner',
      can_manage: false,
      partners: [{ id: 'pa', name: 'Partner A', pods: [] }],
      customers: [{ id: 't1', name: 'Customer One', partner_id: 'pa', segment: 'Region north' }],
    }),
    [`GET ${PR}/view`]: {
      programme: { id: 'p1', name: 'Fixture programme' },
      customers: [viewCustomer],
      totals: {
        customers: 1,
        bands: { medium: 1 },
        open_vendor_gaps: 2,
        open_breaks: 1,
        open_risks: 5,
      },
      scope: 'partner',
    },
    [`GET ${PR}/portfolio-plans/latest`]: {
      __problem: true,
      type: '/problems/not-found',
      title: 'Portfolio plan not found',
      status: 404,
    },
  });
  await page.goto('/programmes/p1');
  await expect(page.getByText('You see only Partner A’s customers.')).toBeVisible();
  const table = page.getByRole('region', { name: 'Programme customers' });
  await expect(table.getByText('3 of 8, next: Design', { exact: false })).toBeVisible();
  await axe(page);

  await page.getByRole('tab', { name: 'Portfolio' }).click();
  await expect(page).toHaveURL(/section=portfolio/);
  await expect(page.getByRole('button', { name: 'Run planner' })).toHaveAccessibleDescription(
    'Only the programme owner runs the planner.',
  );
  await expect(page.getByText('The programme owner has not run the planner yet.')).toBeVisible();
  await axe(page);
});

test('Set-up: the weights must add up to 1, and a pod is added', async ({ page }) => {
  await signInWithFixtureSession(page);
  let current = detail();
  const { requests } = await mockApi(page, {
    ...common,
    [`GET ${PR}`]: () => current,
    '/api/v1/adapters': [],
    '/api/v1/blueprint-templates': [],
    '/api/v1/packs': [],
    [`PUT ${PR}/setup`]: () => current,
    [`POST ${PR}/partners/pb/pods`]: (_route: Route, body: unknown) => {
      const b = body as { name: string; capacity: number };
      current = {
        ...current,
        partners: current.partners.map((p) =>
          p.id === 'pb' ? { ...p, pods: [{ id: 'pod2', ...b }] } : p,
        ),
      };
      return current;
    },
  });
  await page.goto('/programmes/p1?section=setup');
  await expect(page.getByText('The weights add up to 1.000.')).toBeVisible();
  await axe(page);

  await page.getByRole('spinbutton', { name: 'Weight of Tables' }).fill('0.2');
  await expect(page.getByRole('status').filter({ hasText: 'they must add up to 1' })).toHaveText(
    /1\.100.*remove 0\.100/,
  );
  await page.getByRole('button', { name: 'Save set-up' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'add up to 1.100' })).toBeVisible();
  expect(requests.some((r) => r.method === 'PUT')).toBe(false);
  await axe(page);

  await page.getByRole('spinbutton', { name: 'Weight of Columns' }).fill('0');
  await page.getByRole('spinbutton', { name: 'Weight of Tables' }).fill('0.15');
  await page.getByRole('button', { name: 'Save set-up' }).click();
  await expect.poll(() => requests.filter((r) => r.method === 'PUT').length).toBe(1);
  const put = requests.find((r) => r.method === 'PUT')?.body as {
    mci_config: { weights: Record<string, number> };
  };
  expect(put.mci_config.weights.tables).toBe(0.15);
  expect(put.mci_config.weights.columns).toBe(0);

  const form = page.getByRole('form', { name: 'Add a pod to Partner B' });
  await form.getByRole('textbox', { name: 'Pod name' }).fill('Pod two');
  await form.getByRole('spinbutton', { name: /Capacity/ }).fill('3');
  await form.getByRole('button', { name: 'Add pod' }).click();
  await expect(page.getByRole('rowheader', { name: 'Pod two' })).toBeVisible();
  expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ name: 'Pod two', capacity: 3 });
  // Scrolling leaves controls partly under the sticky top bar, which axe counts as covered targets (the known
  // app-shell gap noted in i10-flows). Check at a resting scroll position.
  await page.evaluate('window.scrollTo(0, 0)');
  await axe(page);
});

test('Fleet: record consent, run a light scan and read its breakdown', async ({ page }) => {
  await signInWithFixtureSession(page);
  let consents: unknown[] = [];
  let scans: unknown[] = [];
  const { requests } = await mockApi(page, {
    ...common,
    [`GET ${PR}`]: detail(),
    [`GET ${PR}/fleet`]: () => ({
      customers: [
        {
          customer_id: 't1',
          customer: 'Customer One',
          segment: 'Region north',
          partner_id: 'pa',
          consent: consents.length > 0,
          scan: scans[0] ?? null,
        },
      ],
      segments: [],
      scope: 'programme',
    }),
    '/api/v1/tenants/t1/consents': (route: Route) => {
      if (route.request().method() === 'POST') {
        consents = [consent];
        return consent;
      }
      return consents;
    },
    '/api/v1/tenants/t1/fleet-scans': (route: Route) => {
      if (route.request().method() === 'POST') {
        scans = [scan];
        return { ...scan, status: 'queued', mci: null, measures: {} };
      }
      return scans;
    },
    '/api/v1/tenants/t1/source-connections': [
      {
        id: 'sc1',
        name: 'Legacy prod',
        adapter: 'fixture-source',
        engine: 'sqlserver',
        last_check: { status: 'succeeded' },
      },
    ],
  });
  await page.goto('/programmes/p1?section=fleet&customer=t1');
  const start = page.getByRole('button', { name: 'Start light scan' });
  await expect(start).toBeDisabled();
  await expect(start).toHaveAccessibleDescription('Record the customer’s consent before scanning.');
  await axe(page);

  await page.getByRole('button', { name: 'Record consent' }).click();
  const dialog = page.getByRole('dialog', { name: /Record consent/ });
  await dialog.getByRole('textbox', { name: /Signatory name/ }).fill('Dana Signer');
  await dialog.getByRole('textbox', { name: /Signatory title/ }).fill('Chief Information Officer');
  await dialog.getByRole('textbox', { name: /What may be read/ }).fill('Counts only');
  await dialog.getByRole('textbox', { name: /signed form/ }).fill('DMS-0042');
  await dialog.getByRole('button', { name: 'Record consent' }).click();
  await expect(dialog.getByText(/at least 20 characters \(11 so far\)/)).toBeVisible();
  await axe(page);
  await dialog
    .getByRole('textbox', { name: /What may be read/ })
    .fill('Metadata and counts of the policy administration database.');
  await dialog.getByRole('button', { name: 'Record consent' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(start).toBeEnabled();

  await start.click();
  const scanDialog = page.getByRole('dialog', { name: /Start light scan/ });
  await expect(scanDialog.getByText(/never reads business values/)).toBeVisible();
  await scanDialog.getByRole('combobox', { name: /Source connection/ }).click();
  await page.getByRole('option', { name: /Legacy prod/ }).click();
  await axe(page);
  await scanDialog.getByRole('button', { name: 'Start light scan' }).click();
  await expect(scanDialog).toHaveCount(0);
  expect(
    requests.find((r) => r.method === 'POST' && r.path.endsWith('/fleet-scans'))?.body,
  ).toEqual({ connection_id: 'sc1' });
  const breakdown = page.getByRole('region', { name: 'Index breakdown' });
  await expect(breakdown.getByRole('row', { name: /^Tables/ })).toContainText('775');
  await expect(page.getByText(/Score = 100 × Σ weight/)).toBeVisible();
  // Scrolling leaves controls partly under the sticky top bar, which axe counts as covered targets (the known
  // app-shell gap noted in i10-flows). Check at a resting scroll position.
  await page.evaluate('window.scrollTo(0, 0)');
  await axe(page);
});

test('Portfolio and metering: run the planner, then export gate evidence', async ({ page }) => {
  await signInWithFixtureSession(page);
  const plan = {
    number: 1,
    status: 'optimal',
    created_at: '2026-11-19T08:00:00Z',
    assignments: [
      {
        customer_id: 't1',
        customer: 'Customer One',
        partner_id: 'pa',
        segment: 'Region north',
        band: 'simple',
        weeks: 8,
        wave: 'w1',
        pod_id: 'pod1',
        pod: 'Pod one',
      },
    ],
    conflicts: [{ customer_id: 't2', customer: 'Customer Two', reason: 'No partner is assigned.' }],
    pods: [
      {
        pod_id: 'pod1',
        pod: 'Pod one',
        partner_id: 'pa',
        capacity: 2,
        waves: [
          { wave: 'w1', customers: ['Customer One'] },
          { wave: 'w2', customers: [] },
        ],
      },
    ],
    waves: detail().waves,
  };
  let latest: unknown = null;
  await mockApi(page, {
    ...common,
    [`GET ${PR}`]: detail(),
    [`GET ${PR}/portfolio-plans/latest`]: () =>
      latest ?? {
        __problem: true,
        type: '/problems/not-found',
        title: 'Portfolio plan not found',
        status: 404,
      },
    [`POST ${PR}/portfolio-plans`]: () => {
      latest = plan;
      return plan;
    },
    [`GET ${PR}/metering`]: {
      customers: [
        {
          customer_id: 't1',
          customer: 'Customer One',
          segment: 'Region north',
          partner_id: 'pa',
          band: 'simple',
          score: 20,
          gates_passed: 2,
          effort_hours: 80,
          elapsed_days: 30,
          wave: 'w1',
        },
      ],
      gate_evidence: [
        {
          customer_id: 't1',
          customer: 'Customer One',
          segment: 'Region north',
          project: 'Upgrade',
          gate: 'configure',
          label: 'G0',
          passed_at: '2026-10-01T10:00:00Z',
          approvers: 'Alex Lead (migration_lead)',
          checklist_digest: 'abcdef0123456789'.repeat(4),
          band: 'simple',
        },
      ],
      segment_waves: [
        {
          segment: 'Region north',
          wave: 'w1',
          customers: 1,
          effort_hours: 80,
          hours_per_customer: 80,
          hours_per_score_point: 4,
        },
      ],
      plan_number: 1,
    },
  });
  await page.route(
    (url) => url.pathname === `${PR}/metering` && url.searchParams.get('format') === 'csv',
    async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/csv',
        headers: { 'Content-Disposition': 'attachment; filename="gate-evidence-p1.csv"' },
        body: 'customer,segment\r\nCustomer One,Region north\r\n',
      });
    },
  );
  await page.goto('/programmes/p1?section=portfolio');
  await expect(page.getByText('No plan yet')).toBeVisible();
  await page.getByRole('button', { name: 'Run planner' }).click();
  await expect(page.getByText('Plan 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Conflicts' })).toContainText(
    'No partner is assigned.',
  );
  const rotation = page.getByRole('region', { name: 'Pod rotation table' });
  await expect(rotation.getByRole('columnheader')).toHaveText(['Pod', 'Wave one', 'Wave two']);
  await expect(rotation.getByRole('row', { name: /Pod one/ }).getByRole('cell')).toHaveText([
    /Customer One/,
    'Free',
  ]);
  await axe(page);

  await page.getByRole('tab', { name: 'Metering' }).click();
  await expect(page).toHaveURL(/section=metering/);
  await expect(page.getByRole('region', { name: 'Gate evidence table' })).toContainText(
    'Alex Lead',
  );
  await axe(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export gate evidence (CSV)' }).click();
  expect((await download).suggestedFilename()).toBe('gate-evidence-p1.csv');
});
