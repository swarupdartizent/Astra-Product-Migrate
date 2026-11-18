import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { me, mockApi, signInWithFixtureSession } from './support';

/**
 * Key I9 flows against FIXTURE API responses (see e2e/support.ts): the design overview with the
 * target's design section, mapping decisions (a deep link to an item in the review queue, a bulk
 * approval with a second approval pending and a refusal, and the review item's evidence link back
 * to the design item), the security access matrix gating approval, the integration test editor
 * and run, and build artifacts that only an approved version can run. Values are synthetic.
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
  permissions: ['stage:manage', 'review:resolve'],
  roles: ['data_sme', 'solution_architect'],
};

const common = {
  '/api/v1/me': me(['tenant:read']),
  '/api/v1/health': health,
  '/api/v1/projects/pr1': project,
  '/api/v1/projects/pr1/stages': [],
  '/api/v1/roles': [
    { key: 'data_sme', label: 'Data SME' },
    { key: 'solution_architect', label: 'Solution architect' },
  ],
  '/api/v1/jobs': [],
};

const can = {
  mapping: true,
  configuration: true,
  form: true,
  code: true,
  integration: true,
  report: true,
  page: true,
  security: true,
};

const src = (reference: string) => ({ reference, url: null });

const overview = {
  latest_run: {
    id: 'dr1',
    project_id: 'pr1',
    connection_id: 'c1',
    status: 'succeeded',
    status_detail: null,
    summary: {
      streams: {
        mapping: { items: 3, kept_decisions: 0, proposed: 2, in_review: 1 },
        security: { items: 1, kept_decisions: 0, proposed: 1 },
        integration: { items: 1, kept_decisions: 0, proposed: 1 },
      },
      mapping: {
        columns: 3,
        in_review: 1,
        no_target: 0,
        threshold: 0.8,
        required_unmapped: [],
      },
      blocked: {},
      problems: [],
      review_items: 1,
    },
    job_id: 'j1',
    requested_by: 'Alex Lead',
    created_at: '2026-11-18T09:00:00Z',
    finished_at: '2026-11-18T09:05:00Z',
  },
  counts: {
    mapping: { proposed: 2, in_review: 1 },
    security: { proposed: 1 },
    integration: { proposed: 1 },
  },
  target_design: {
    mechanisms: [
      {
        key: 'api',
        kind: 'rest_api',
        label: 'Public REST API',
        directions: ['inbound', 'read'],
        notes: 'Rate limited per client.',
        source: src('Target API guide, chapter 2'),
        confidence: 'confirmed',
      },
      {
        key: 'reports',
        kind: 'read_query',
        label: 'Reporting replica',
        directions: ['read'],
        notes: '',
        source: src('Target hosting notes'),
        confidence: 'reported',
      },
    ],
    report_access: 'reports',
    retirements: [
      {
        object_type: 'linked_server',
        when: {},
        name_pattern: null,
        replacement: 'Call the public REST API from the other system instead.',
        source: src('Target hosting notes'),
        confidence: 'reported',
      },
    ],
    naming: {
      schema: 'cust',
      prefix: 'x_',
      case: 'snake',
      max_length: 64,
      source: src('Target extension guide'),
      confidence: 'confirmed',
    },
    configuration_areas: [
      { key: 'codes', label: 'Code lists', source_kinds: ['code_table'], method: 'api', notes: '' },
    ],
    forms: null,
    pages: {
      name: 'Page designer',
      notes: '',
      source: src('Target extension guide'),
      confidence: 'assumed',
    },
  },
  target_design_missing: null,
  build: { generated: 0, tests_failed: 1, tests_passed: 1, approved: 0 },
  can_run: true,
  can_build: true,
  can_decide: can,
};

function mapping(column: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stream: 'mapping',
    key: `dbo.policy.${column}`,
    status: 'proposed',
    source: {
      table: 'dbo.policy',
      column,
      type: 'varchar',
      max_length: 20,
      nullable: true,
      ordinal: 1,
    },
    target: { table: 'core.policy', column, type: 'nvarchar(40)', nullable: false },
    proposed_target: { table: 'core.policy', column, type: 'nvarchar(40)', nullable: false },
    confidence: 0.91,
    flags: [],
    evidence: [`name similarity 1.00 (${column} → ${column})`],
    decision: null,
    review_item_id: null,
    approvals: null,
    parity: null,
    missing: null,
    key_columns: null,
    desktop: null,
    updated_at: '2026-11-18T09:05:00Z',
    run_id: 'dr1',
    updated_by: 'design',
    precedents: [],
    readiness: null,
    can_decide: true,
    cannot_decide_reason: null,
    files: [],
    ...over,
  };
}

type Item = Record<string, unknown>;

/** List and item routes answering from `items` (the item by its `key` query parameter). */
function register(items: () => Item[]) {
  return {
    '/api/v1/projects/pr1/design/items': () => ({ items: items(), total: items().length }),
    '/api/v1/projects/pr1/design/item': (route: Route) => {
      const key = new URL(route.request().url()).searchParams.get('key');
      return (
        items().find((i) => i.key === key) ?? {
          __problem: true,
          type: '/problems/not-found',
          title: 'Design item not found',
          status: 404,
        }
      );
    },
  };
}

test('Design overview: the target’s design section is readable and the page is accessible', async ({
  page,
}) => {
  await signInWithFixtureSession(page);
  await mockApi(page, { ...common, '/api/v1/projects/pr1/design': overview });
  await page.goto('/projects/pr1?tab=design');
  await expect(page.getByRole('tab', { name: 'Overview', selected: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Target design section' })).toBeVisible();
  await expect(page.getByText('Public REST API', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Call the public REST API from the other system instead.'),
  ).toBeVisible();
  const register = page.getByRole('table', { name: 'Design register items per stream and status' });
  await expect(register.getByRole('row', { name: /Mappings/ })).toContainText('You decide');
  await axe(page);
  await register.getByRole('link', { name: 'Mappings' }).click();
  await expect(page).toHaveURL(/section=mapping/);
  await expect(page.getByRole('tab', { name: /Mappings/, selected: true })).toBeVisible();
});

test('Mappings: an in-review item cannot be decided here; a bulk approval records a second approval and a refusal', async ({
  page,
}) => {
  await signInWithFixtureSession(page);
  const items = [
    mapping('policy_no'),
    mapping('status_cd', { confidence: 0.84 }),
    mapping('line_cd', {
      status: 'in_review',
      confidence: 0.41,
      review_item_id: 'rv1',
      readiness: 'The item is in the review queue; decide it there.',
    }),
  ];
  const { requests } = await mockApi(page, {
    ...common,
    '/api/v1/projects/pr1/design': overview,
    ...register(() => items),
    'POST /api/v1/projects/pr1/design/decisions': {
      decided: [],
      awaiting_second_approval: ['dbo.policy.policy_no'],
      refused: [{ key: 'dbo.policy.status_cd', reason: 'Already approved.' }],
      required_approvals: 2,
    },
  });
  await page.goto('/projects/pr1?tab=design&section=mapping&key=dbo.policy.line_cd');
  const panel = page.getByRole('region', { name: 'dbo.policy.line_cd' });
  await expect(panel.getByText('Decided in the review queue')).toBeVisible();
  await expect(panel.getByRole('link', { name: /Open the review item/ })).toHaveAttribute(
    'href',
    '/projects/pr1?tab=reviews&item=rv1',
  );
  await expect(panel.getByRole('button', { name: 'Approve proposed target' })).toBeDisabled();
  await expect(panel.getByText('In the review queue: decide it there.')).toBeVisible();
  await axe(page);

  // Selecting another item pushes it to the URL.
  await page.getByRole('button', { name: /dbo\.policy\.policy_no/ }).click();
  await expect(page).toHaveURL(/key=dbo\.policy\.policy_no/);
  await expect(page.getByRole('region', { name: 'dbo.policy.policy_no' })).toBeVisible();

  await page.getByRole('checkbox', { name: 'Select every proposed item on this page' }).click();
  await expect(page.getByText('2 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Approve selected' }).click();
  const dialog = page.getByRole('dialog', { name: 'Approve 2 items' });
  await dialog.getByRole('textbox', { name: /Reason/ }).fill('Names and types match exactly.');
  await axe(page);
  await dialog.getByRole('button', { name: 'Approve 2' }).click();
  const result = page.getByRole('status').filter({ hasText: 'Decision recorded' });
  await expect(result).toContainText(
    '1 item(s) need a second approval: your approval is recorded (1 of 2)',
  );
  await expect(result).toContainText('dbo.policy.status_cd: Already approved.');
  expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
    stream: 'mapping',
    keys: ['dbo.policy.policy_no', 'dbo.policy.status_cd'],
    action: 'approve',
    reason: 'Names and types match exactly.',
  });
  await axe(page);
});

test('Review queue: a design item’s evidence links to it on the Design tab', async ({ page }) => {
  await signInWithFixtureSession(page);
  const item = {
    id: 'rv1',
    project_id: 'pr1',
    kind: 'proposal',
    title: 'Mapping: dbo.policy.line_cd → core.policy.line_code',
    question: 'Confidence 0.41 is below the review threshold 0.80.',
    options: ['Accept the proposed mapping', 'No target: the column is not migrated'],
    context: {},
    owner_role: 'data_sme',
    owner_role_label: 'Data SME',
    owner_user: null,
    requested_by: 'design',
    requested_by_type: 'system',
    agent_run_id: null,
    status: 'open',
    resolution: null,
    resolution_note: null,
    resolved_by: null,
    resolved_at: null,
    created_at: '2026-11-18T09:05:00Z',
    can_resolve: true,
    cannot_resolve_reason: null,
    flagged_text: null,
    stream: 'data',
    segment: 'dbo.policy',
    subject_type: 'mapping',
    risk: 'medium',
    confidence: 0.41,
    compliance: 'none',
    compliance_controls: [],
    required_approvals: 1,
    approvals: [],
    owner_user_id: null,
    agent: null,
    pattern_key: null,
    evidence: [
      {
        label: 'Design register item',
        kind: 'design_item',
        ref: { stream: 'mapping', key: 'dbo.policy.line_cd' },
      },
    ],
    outcome: null,
    changed_value: null,
    follow_up_run_id: null,
    priority: 200,
    priority_reasons: ['medium risk', 'confidence 41%'],
    can_assign_reviewer: false,
  };
  const items = [
    mapping('line_cd', {
      status: 'in_review',
      confidence: 0.41,
      review_item_id: 'rv1',
      readiness: 'The item is in the review queue; decide it there.',
    }),
  ];
  await mockApi(page, {
    ...common,
    '/api/v1/projects/pr1/review-queue': {
      items: [item],
      total: 1,
      facets: { risk: { medium: 1 } },
      groups: [],
      can_decide_any: true,
    },
    '/api/v1/review-items/rv1/workbench': {
      item,
      why: ['Raised by design (system) on 18 Nov 2026 09:05 UTC.'],
      samples: null,
      precedents: { pattern_key: null, outcomes: {}, items: [] },
      assistant: {
        agent: 'review-assistant',
        pinned_version: null,
        can_ask: false,
        unavailable_reason: 'The Review Assistant is not pinned on this project.',
      },
      assistant_runs: [],
      reviewers: [],
    },
    '/api/v1/projects/pr1/design': overview,
    ...register(() => items),
  });
  await page.goto('/projects/pr1?tab=reviews&item=rv1');
  const panel = page.getByRole('region', { name: item.title });
  const link = panel.getByRole('link', { name: /Design register item/ });
  await expect(link).toHaveAttribute(
    'href',
    '/projects/pr1?tab=design&section=mapping&key=dbo.policy.line_cd',
  );
  await link.click();
  await expect(page.getByRole('tab', { name: /Mappings/, selected: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'dbo.policy.line_cd' })).toBeVisible();
});

test('Security: approval waits for a complete, saved access matrix', async ({ page }) => {
  await signInWithFixtureSession(page);
  let item = mapping('x', {
    stream: 'security',
    key: 'profile:clerk',
    source: { profile: 'clerk', rights: null },
    target: { profile: 'clerk' },
    proposed_target: { profile: 'clerk' },
    confidence: null,
    flags: ['1 object(s) have no access decision'],
    evidence: ['2 new object(s) need an access decision'],
    entries: { 'page:Policy': null, 'report:core.rpt_claims': 'view' },
    missing: ['page:Policy'],
    readiness: '1 new object(s) have no access decision for this profile.',
  });
  const { requests } = await mockApi(page, {
    ...common,
    '/api/v1/projects/pr1/design': overview,
    ...register(() => [item]),
    'PUT /api/v1/projects/pr1/design/security': (_route: Route, body: unknown) => {
      const entries = (body as { entries: Record<string, string> }).entries;
      item = {
        ...item,
        entries: {
          ...(item.entries as Record<string, string>),
          ...entries,
        },
        missing: [],
        flags: [],
        readiness: null,
      };
      return item;
    },
  });
  await page.goto('/projects/pr1?tab=design&section=security&key=profile:clerk');
  const panel = page.getByRole('region', { name: 'clerk' });
  await expect(panel.getByRole('button', { name: 'Approve' })).toBeDisabled();
  await expect(
    panel.getByText('1 new object(s) have no access decision for this profile.'),
  ).toBeVisible();
  await axe(page);
  await panel.getByRole('radio', { name: 'Edit access to page Policy' }).check();
  await expect(
    panel.getByText('Save the access decisions first: there are unsaved changes.'),
  ).toBeVisible();
  await panel.getByRole('button', { name: 'Save access decisions' }).click();
  await expect(panel.getByRole('button', { name: 'Approve' })).toBeEnabled();
  expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({
    key: 'profile:clerk',
    entries: { 'page:Policy': 'edit' },
  });
  await axe(page);
});

test('Integrations: define the end-to-end test, then run it against a target connection', async ({
  page,
}) => {
  await signInWithFixtureSession(page);
  let item = mapping('x', {
    stream: 'integration',
    key: 'interface:policy-feed',
    source: {
      key: 'policy-feed',
      name: 'Policy feed',
      kind: 'program',
      source: 'activity',
      program: 'feed.exe',
      hosts: ['APP1'],
      per_day: 1200,
      reads: [],
      writes: ['dbo.policy'],
      executes: [],
      evidence: [],
      direction: 'inbound',
    },
    target: {
      mechanism: 'api',
      mechanism_kind: 'rest_api',
      label: 'Public REST API',
      touches: [{ source: 'dbo.policy', target: 'core.policy' }],
    },
    proposed_target: null,
    confidence: null,
    desktop: false,
    flags: ['needs an end-to-end test definition'],
    evidence: ['inbound integration: Public REST API (Target API guide, chapter 2 (confirmed))'],
    readiness: 'Define the interface’s end-to-end test first.',
  });
  const { requests } = await mockApi(page, {
    ...common,
    '/api/v1/projects/pr1/design': overview,
    ...register(() => [item]),
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
    'PUT /api/v1/projects/pr1/design/integration-test': (_route: Route, body: unknown) => {
      item = {
        ...item,
        tests: (body as { steps: unknown[] }).steps,
        readiness: null,
        flags: [],
      };
      return item;
    },
    'POST /api/v1/projects/pr1/design/integration-test-runs': {
      at: '2026-11-18T10:00:00Z',
      by: 'Fixture User',
      connection: 'Sandbox',
      blocked: null,
      passed: true,
      steps: [{ step: 'Read a policy', status: 200, passed: true, problems: [] }],
    },
  });
  await page.goto('/projects/pr1?tab=design&section=integration&key=interface:policy-feed');
  const panel = page.getByRole('region', { name: 'Policy feed' });
  await expect(panel.getByRole('button', { name: 'Approve' })).toBeDisabled();
  await axe(page);
  await panel.getByRole('textbox', { name: /Step 1 name/ }).fill('Read a policy');
  await panel.getByRole('textbox', { name: /Step 1 path/ }).fill('/api/policies/P1');
  await panel.getByRole('textbox', { name: /Step 1 expected response keys/ }).fill('id, status');
  await panel.getByRole('button', { name: 'Save test' }).click();
  await expect(panel.getByRole('button', { name: 'Approve' })).toBeEnabled();
  expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({
    key: 'interface:policy-feed',
    steps: [
      {
        name: 'Read a policy',
        method: 'GET',
        path: '/api/policies/P1',
        body: null,
        expect_status: 200,
        expect_keys: ['id', 'status'],
      },
    ],
  });
  await panel.getByRole('combobox', { name: /Target connection/ }).click();
  await page.getByRole('option', { name: /Sandbox/ }).click();
  await panel.getByRole('button', { name: 'Run test' }).click();
  await expect(panel.getByText('Test passed: 1 of 1 step(s)')).toBeVisible();
  await axe(page);
});

test('Build: only a version whose tests passed can be approved, and only approved versions run', async ({
  page,
}) => {
  await signInWithFixtureSession(page);
  const failed = {
    id: 'a1',
    kind: 'transformation',
    name: 'core.policy <- dbo.policy',
    version: 2,
    digest: 'd'.repeat(64),
    status: 'tests_failed',
    test_summary: { tests: 3, passed: 2, failed: ['values preserved: policy_no -> policy_no'] },
    runnable: false,
    approved_by: null,
    approval_note: null,
    approved_at: null,
    created_by: 'Alex Lead',
    created_at: '2026-11-18T10:00:00Z',
  };
  const detail = {
    ...failed,
    code: 'CREATE PROCEDURE [astra_xf].[xf_core__policy_from_dbo__policy]\nAS\nBEGIN\n    SET NOCOUNT ON;\nEND',
    tests: [
      { name: 'compiles', kind: 'compile' },
      {
        name: 'values preserved: policy_no -> policy_no',
        kind: 'values',
        check: 'SELECT 1',
        expect: 0,
      },
    ],
    results: [
      { name: 'compiles', passed: true, detail: null },
      {
        name: 'values preserved: policy_no -> policy_no',
        passed: false,
        detail: '1 value(s) or row(s) differ',
      },
    ],
    inputs: {
      source_table: 'dbo.policy',
      target_table: 'core.policy',
      mappings: [{ source: 'policy_no', target: 'policy_no', decided_by: 'Dana SME' }],
      seed_rows: [{ policy_no: 'P-1' }, { policy_no: 'Sample' }, { policy_no: 'ZZZZ' }],
      real_sample_rows: 1,
    },
    can_approve: false,
    cannot_approve_reason:
      'The artifact is tests failed; only a version whose tests passed is approved.',
  };
  await mockApi(page, {
    ...common,
    '/api/v1/projects/pr1/design': overview,
    '/api/v1/projects/pr1/build-artifacts': [failed],
    '/api/v1/build-artifacts/a1': detail,
  });
  await page.goto('/projects/pr1?tab=design&section=build&artifact=a1');
  await expect(page.getByText('Only approved versions can run')).toBeVisible();
  const panel = page.getByRole('region', { name: 'core.policy <- dbo.policy, version 2' });
  await expect(panel.getByLabel('Code of core.policy <- dbo.policy')).toContainText(
    'CREATE PROCEDURE',
  );
  await expect(panel.getByText('1 value(s) or row(s) differ')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Approve version 2' })).toBeDisabled();
  await expect(panel.getByText(/only a version whose tests passed is approved/)).toBeVisible();
  await axe(page);
});
