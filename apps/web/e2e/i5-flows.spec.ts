import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { me, mockApi, signInWithFixtureSession } from './support';

/**
 * Key I5 flows against FIXTURE API responses (see e2e/support.ts): a run with a partial usage
 * phase, the coverage report waive-then-accept flow with its 409, a graph node with edges, and
 * configuration differences between books. Values are synthetic.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const ALL = ['tenant:read'];
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

const run = {
  id: 'd1',
  project_id: 'pr1',
  connection_id: 'c1',
  connection_name: 'fixture-source',
  adapter: 'fixture-source@1.0.0',
  status: 'succeeded',
  status_detail: null,
  as_of: '2026-11-18T00:00:00Z',
  window_days: 90,
  phases: {
    inventory: { status: 'done', detail: '', counts: { table: 12, procedure: 4 } },
    dictionary: { status: 'done', detail: '', counts: { tables: 12, columns: 80 } },
    profile: { status: 'done', detail: '', counts: { tables: 12, failed: 0 } },
    usage: {
      status: 'partial',
      detail: 'Activity covers 20 of 90 days; results are provisional.',
      counts: { evidence_days: 20, unused: 3 },
    },
    code: { status: 'done', detail: '', counts: { rules: 5 } },
    interfaces: { status: 'done', detail: '', counts: { interfaces: 2 } },
    configuration: { status: 'done', detail: '', counts: { items: 5 } },
    documents: { status: 'skipped', detail: 'The adapter declares no document store.', counts: {} },
  },
  summary: { coverage_pct: 44, nodes: 120, edges: 300, unused: 3, evidence_days: 20 },
  job_id: null,
  requested_by: 'Fixture User',
  created_at: '2026-11-18T10:00:00Z',
  finished_at: '2026-11-18T10:05:00Z',
  coverage_report_id: 'cr1',
};

function report(over: Record<string, unknown> = {}) {
  return {
    id: 'cr1',
    project_id: 'pr1',
    discovery_run_id: 'd1',
    coverage_pct: 44,
    streams: [
      {
        stream: 'data',
        title: 'Data and documents',
        status: 'covered',
        counts: { tables: 12 },
        gaps: [],
      },
      {
        stream: 'integrations',
        title: 'Integrations',
        status: 'gap',
        counts: { interfaces: 2, evidence_days: 20 },
        gaps: ['integrations:activity'],
      },
    ],
    gaps: [
      {
        id: 'integrations:activity',
        stream: 'integrations',
        severity: 'blocking',
        message: 'No login or query records were imported.',
      },
    ],
    waivers: [],
    status: 'draft',
    blocking_open: ['integrations:activity'],
    decided_by: null,
    decided_at: null,
    decision_note: null,
    created_at: '2026-11-18T10:06:00Z',
    can_decide: true,
    ...over,
  };
}

test('Discovery run: a partial usage phase says why', async ({ page }) => {
  await signInWithFixtureSession(page);
  await mockApi(page, {
    '/api/v1/me': me(ALL),
    '/api/v1/health': health,
    '/api/v1/discovery-runs/d1': run,
  });
  await page.goto('/discovery-runs/d1');
  const phases = page.getByRole('list', { name: 'Discovery phases' });
  const usage = phases.getByRole('listitem').filter({ hasText: 'Usage' });
  await expect(usage).toContainText('Partial');
  await expect(usage).toContainText('Activity covers 20 of 90 days; results are provisional.');
  await axe(page);
});

test('Coverage report: waive a blocking gap, accepting too early lists the open gaps', async ({
  page,
}) => {
  await signInWithFixtureSession(page);
  let current = report();
  let decisions = 0;
  const { requests } = await mockApi(page, {
    '/api/v1/me': me(ALL),
    '/api/v1/health': health,
    '/api/v1/projects/pr1': project,
    '/api/v1/projects/pr1/stages': [],
    '/api/v1/projects/pr1/discovery-runs': [run],
    '/api/v1/projects/pr1/coverage-reports': () => [current],
    'POST /api/v1/coverage-reports/cr1/waivers': () => {
      current = report({
        waivers: [
          {
            gap_id: 'integrations:activity',
            reason: 'Activity logs arrive next month.',
            by: 'Fixture User',
            at: '2026-11-18T11:00:00Z',
          },
        ],
        blocking_open: [],
      });
      return current;
    },
    'POST /api/v1/coverage-reports/cr1/decision': () => {
      decisions += 1;
      if (decisions === 1) {
        return {
          __problem: true,
          type: '/problems/gaps-open',
          title: 'Blocking gaps remain',
          status: 409,
          detail: 'Waive each blocking gap with a reason, or run discovery again after closing it.',
          errors: [{ field: 'gaps', message: 'integrations:activity' }],
        };
      }
      current = report({
        ...current,
        status: 'accepted',
        can_decide: false,
        decided_by: 'Fixture User',
        decided_at: '2026-11-18T12:00:00Z',
        decision_note: 'Ready to plan now.',
      });
      return current;
    },
  });
  await page.goto('/projects/pr1?tab=discovery');
  await expect(page.getByText('1 blocking gap(s) open')).toBeVisible();
  await axe(page);

  // Accepting with the gap open: the API refuses with 409 and the open gaps.
  await page.getByRole('button', { name: 'Accept report' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: /Note/ }).fill('Ready to plan now.');
  await dialog.getByRole('button', { name: 'Accept report' }).click();
  await expect(dialog.getByText('Blocking gaps remain')).toBeVisible();
  await expect(dialog.getByText('integrations:activity')).toBeVisible();
  await axe(page);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Waive it with a reason.
  await page.getByRole('button', { name: 'Waive gap' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: /Reason/ }).fill('Activity logs arrive next month.');
  await dialog.getByRole('button', { name: 'Waive gap' }).click();
  await expect(page.getByText(/Waived by Fixture User/)).toBeVisible();

  // Now accept.
  await page.getByRole('button', { name: 'Accept report' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: /Note/ }).fill('Ready to plan now.');
  await dialog.getByRole('button', { name: 'Accept report' }).click();
  await expect(page.getByText('Accepted', { exact: true }).first()).toBeVisible();
  expect(requests.filter((r) => r.method === 'POST').map((r) => r.body)).toEqual([
    { accept: true, note: 'Ready to plan now.' },
    { gap_id: 'integrations:activity', reason: 'Activity logs arrive next month.' },
    { accept: true, note: 'Ready to plan now.' },
  ]);
  await axe(page);
});

test('Knowledge graph: a node shows its edges and links to its neighbours', async ({ page }) => {
  await signInWithFixtureSession(page);
  await mockApi(page, {
    '/api/v1/me': me(ALL),
    '/api/v1/health': health,
    '/api/v1/discovery-runs/d1': run,
    '/api/v1/discovery-runs/d1/graph': {
      total: 2,
      offset: 0,
      counts: [
        { kind: 'table', stream: 'data', nodes: 2 },
        { kind: 'interface', stream: 'reports', nodes: 1 },
      ],
      streams: { data: 'Data and documents', reports: 'Reports and analytics' },
      nodes: [
        {
          id: 'table:dbo.party',
          kind: 'table',
          stream: 'data',
          element: 'dbo.party',
          usage: { reads: 40, unused: false },
          concept: 'ns.party',
          target: 'party',
          props: { rows: 1200 },
        },
        {
          id: 'table:dbo.region',
          kind: 'table',
          stream: 'data',
          element: 'dbo.region',
          usage: { reads: 0, unused: true },
          concept: null,
          target: null,
          props: { rows: 12 },
        },
      ],
    },
    '/api/v1/discovery-runs/d1/graph/nodes': {
      node: {
        id: 'table:dbo.party',
        kind: 'table',
        stream: 'data',
        element: 'dbo.party',
        usage: { reads: 40, writes: 2, unused: false },
        concept: 'ns.party',
        target: 'party',
        props: { rows: 1200, columns: 8 },
      },
      outgoing: [
        {
          type: 'references',
          node_id: 'table:dbo.region',
          element: 'dbo.region',
          node_kind: 'table',
          props: { column: 'region_id', enforced: false },
        },
      ],
      incoming: [
        {
          type: 'reads',
          node_id: 'interface:report-tool',
          element: 'Report tool',
          node_kind: 'interface',
          props: {},
        },
      ],
    },
  });
  await page.goto('/discovery-runs/d1?tab=graph&node=table%3Adbo.party');
  const out = page.getByRole('region', { name: 'Outgoing edges' });
  await expect(out).toContainText('references');
  await expect(out.getByRole('link', { name: 'dbo.region' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Incoming edges' })).toContainText('read by');
  await expect(page.getByRole('link', { name: 'ns.party' })).toHaveAttribute(
    'href',
    '/ontology/ns.party',
  );
  await expect(page.getByRole('list', { name: 'Nodes' }).getByText('Unused')).toBeVisible();
  await axe(page);
});

test('Configuration: differences between books are shown side by side', async ({ page }) => {
  await signInWithFixtureSession(page);
  await mockApi(page, {
    '/api/v1/me': me(ALL),
    '/api/v1/health': health,
    '/api/v1/discovery-runs/d1': run,
    '/api/v1/discovery-runs/d1/results/configuration': {
      items: [
        {
          kind: 'rate_table',
          key: 'r1',
          name: 'base_rate',
          scope: 'BOOK-A',
          definition: 'rate: 1.10',
          depends_on: [],
        },
        {
          kind: 'rate_table',
          key: 'r2',
          name: 'base_rate',
          scope: 'BOOK-B',
          definition: 'rate: 1.10',
          depends_on: [],
        },
        {
          kind: 'rate_table',
          key: 'r3',
          name: 'base_rate',
          scope: 'BOOK-C',
          definition: 'rate: 1.25',
          depends_on: [],
        },
        {
          kind: 'form',
          key: 'f1',
          name: 'cover_form',
          scope: 'BOOK-A',
          definition: 'fields: 3',
          depends_on: [],
        },
      ],
      problems: [],
      diff: {
        scopes: ['BOOK-A', 'BOOK-B', 'BOOK-C'],
        only_in_some: [
          {
            kind: 'form',
            name: 'cover_form',
            present_in: ['BOOK-A'],
            missing_in: ['BOOK-B', 'BOOK-C'],
          },
        ],
        different: [
          {
            kind: 'rate_table',
            name: 'base_rate',
            definitions: { 'BOOK-A': 'aaa', 'BOOK-B': 'aaa', 'BOOK-C': 'ccc' },
          },
        ],
        same_everywhere: 0,
      },
    },
  });
  await page.goto('/discovery-runs/d1?tab=configuration');
  const rate = page.getByRole('region', { name: 'Rate table base_rate' });
  await expect(rate).toContainText('2 different definitions');
  await expect(rate.getByLabel('base_rate in BOOK-C')).toHaveText('rate: 1.25');
  await expect(rate.getByText('Variant 2')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Form cover_form' })).toContainText(
    'Missing in BOOK-B, BOOK-C',
  );
  await axe(page);
});
