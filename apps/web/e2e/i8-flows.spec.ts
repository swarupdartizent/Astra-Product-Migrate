import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { me, mockApi, signInWithFixtureSession } from './support';

/**
 * Key I8 flows against FIXTURE API responses (see e2e/support.ts): the review workbench (deep
 * link with filters, two-person approval, a compliance-critical item without a named reviewer,
 * the Review Assistant unavailable) and the planning workbench (moving an item between waves with
 * the keyboard, a refused batch mapped to the pending change, then a successful apply). Values
 * are synthetic.
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
  roles: ['migration_lead'],
};

const common = {
  '/api/v1/me': me(['tenant:read']),
  '/api/v1/health': health,
  '/api/v1/projects/pr1': project,
  '/api/v1/projects/pr1/stages': [],
  '/api/v1/roles': [{ key: 'migration_lead', label: 'Migration lead' }],
};

function reviewItem(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    project_id: 'pr1',
    kind: 'conversion',
    title: 'Trigger dbo.audit_policy could not be converted',
    question: 'How should this trigger move to the target?',
    options: ['Convert by hand', 'Retire the object', 'Keep it out of scope'],
    context: {},
    owner_role: 'migration_lead',
    owner_role_label: 'Migration lead',
    owner_user: null,
    requested_by: 'conversion',
    requested_by_type: 'system',
    agent_run_id: null,
    status: 'open',
    resolution: null,
    resolution_note: null,
    resolved_by: null,
    resolved_at: null,
    created_at: '2026-11-15T10:00:00Z',
    can_resolve: true,
    cannot_resolve_reason: null,
    flagged_text: null,
    stream: 'customizations',
    segment: 'trigger',
    subject_type: 'conversion_script',
    risk: 'high',
    confidence: null,
    compliance: 'relevant',
    compliance_controls: ['CTRL-7'],
    required_approvals: 2,
    approvals: [],
    owner_user_id: null,
    agent: null,
    pattern_key: 'conversion:trigger:compile',
    evidence: [
      {
        label: 'Converted trigger dbo.audit_policy',
        kind: 'conversion_object',
        ref: { run_id: 'c1', name: 'dbo.audit_policy' },
      },
      { label: 'Conversion run', kind: 'conversion_run', ref: { run_id: 'c1' } },
    ],
    outcome: null,
    changed_value: null,
    follow_up_run_id: null,
    priority: 340,
    priority_reasons: ['high risk', 'compliance relevant (CTRL-7)', 'confidence not stated'],
    can_assign_reviewer: true,
    ...over,
  };
}

function workbenchFor(item: ReturnType<typeof reviewItem>, over: Record<string, unknown> = {}) {
  return {
    item,
    why: [
      'Raised by conversion (system) on 15 Nov 2026 10:00 UTC.',
      'Automatic conversion stopped because: Does not compile on the workbench.',
    ],
    samples: {
      type: 'code',
      object_type: 'trigger',
      status: 'compile_failed',
      source: 'CREATE TRIGGER audit_policy ON policy AFTER UPDATE AS ...',
      converted: 'CREATE OR REPLACE FUNCTION audit_policy() ...',
      review: ['Does not compile on the workbench: syntax error at "INSERTED"'],
      warnings: [],
      compile: { ok: false, error: 'syntax error at "INSERTED"' },
    },
    precedents: {
      pattern_key: 'conversion:trigger:compile',
      outcomes: { approved: 3 },
      items: [
        {
          item_id: 'old1',
          project_id: 'pr9',
          project_name: 'Earlier project',
          same_project: false,
          title: 'Trigger dbo.audit_claim could not be converted',
          outcome: 'approved',
          resolution: 'Convert by hand',
          changed_value: null,
          note: 'Rewritten as a set-based function.',
          decided_by: 'Alex Lead',
          decided_at: '2026-10-01T10:00:00Z',
        },
      ],
    },
    assistant: {
      agent: 'review-assistant',
      pinned_version: null,
      can_ask: true,
      unavailable_reason:
        'The Review Assistant is not pinned on this project. An agent manager pins a released version; until then the explanation above comes from the recorded evidence.',
    },
    assistant_runs: [],
    reviewers: [{ id: 'u2', name: 'Pat Reviewer' }],
    ...over,
  };
}

test('Review workbench: a deep link opens the filtered queue and item; the first of two approvals is recorded', async ({
  page,
}) => {
  await signInWithFixtureSession(page);
  const item = reviewItem();
  const second = reviewItem({
    id: 'r2',
    title: 'Retire 14 unused tables',
    risk: 'high',
    compliance: 'none',
    compliance_controls: [],
    required_approvals: 1,
    pattern_key: null,
    priority: 310,
    evidence: [{ label: 'Discovery run', kind: 'discovery_run', ref: { run_id: 'd1' } }],
  });
  const { requests } = await mockApi(page, {
    ...common,
    '/api/v1/projects/pr1/review-queue': {
      items: [item, second],
      total: 2,
      facets: {
        risk: { high: 2, low: 4 },
        compliance: { relevant: 1, none: 5 },
        owner_role: { migration_lead: 6 },
        stream: { customizations: 3, data: 3 },
      },
      groups: [
        {
          pattern_key: 'conversion:trigger:compile',
          count: 3,
          example_title: 'Trigger dbo.audit_policy could not be converted',
        },
      ],
      can_decide_any: true,
    },
    '/api/v1/review-items/r1/workbench': workbenchFor(item),
    'POST /api/v1/review-items/r1/decide': {
      recorded: 'approval_recorded',
      follow_up_error: null,
      item: {
        ...item,
        approvals: [
          { user: 'Fixture User', option: 'Convert by hand', note: '', at: '2026-11-18T10:00:00Z' },
        ],
      },
    },
  });
  await page.goto('/projects/pr1?tab=reviews&item=r1&risk=high');
  const panel = page.getByRole('region', {
    name: 'Trigger dbo.audit_policy could not be converted',
  });
  await expect(panel.getByRole('heading', { name: 'Why it was raised' })).toBeVisible();
  expect(
    requests.some((r) => r.path === '/api/v1/projects/pr1/review-queue' && r.method === 'GET'),
  ).toBe(true);
  await expect(page.getByRole('combobox', { name: 'Risk' })).toHaveText('High (2)');
  await expect(panel.getByLabel('Source code')).toContainText('CREATE TRIGGER audit_policy');
  await expect(panel.getByLabel('Converted code')).toContainText('CREATE OR REPLACE FUNCTION');
  await expect(panel.getByText('Note: “Rewritten as a set-based function.”')).toBeVisible();
  await expect(
    panel.getByRole('link', { name: /Converted trigger dbo.audit_policy/ }),
  ).toHaveAttribute('href', '/projects/pr1?tab=conversion&run=c1&object=dbo.audit_policy');
  await expect(panel.getByText('The Review Assistant is not available')).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Your question' })).toBeDisabled();
  await axe(page);

  await panel.getByRole('radio', { name: /Approve an option/ }).check();
  await panel.getByRole('radio', { name: 'Convert by hand' }).check();
  await panel.getByRole('button', { name: 'Approve' }).click();
  await expect(
    panel.getByText(
      'Your approval is recorded — 1 of 2; a second person must approve before the item is resolved.',
    ),
  ).toBeVisible();
  await expect
    .poll(() => requests.find((r) => r.method === 'POST')?.body)
    .toEqual({ action: 'approve', option: 'Convert by hand', note: '' });

  // Selecting another item keeps the filters in the URL and pushes the selection.
  await page.getByRole('button', { name: /Retire 14 unused tables/ }).click();
  await expect(page).toHaveURL(/item=r2/);
  await expect(page).toHaveURL(/risk=high/);
});

test('Review workbench: a compliance-critical item without a named reviewer says so and cannot be decided yet', async ({
  page,
}) => {
  await signInWithFixtureSession(page);
  const item = reviewItem({
    compliance: 'critical',
    required_approvals: 1,
    can_resolve: false,
    cannot_resolve_reason:
      'This item is compliance-critical: a named reviewer must be assigned first.',
  });
  const { requests } = await mockApi(page, {
    ...common,
    '/api/v1/projects/pr1/review-queue': {
      items: [item],
      total: 1,
      facets: { risk: { high: 1 }, compliance: { critical: 1 } },
      groups: [],
      can_decide_any: true,
    },
    '/api/v1/review-items/r1/workbench': workbenchFor(item),
    'PUT /api/v1/review-items/r1/reviewer': {
      ...item,
      owner_user: 'Pat Reviewer',
      owner_user_id: 'u2',
    },
  });
  await page.goto('/projects/pr1?tab=reviews&item=r1');
  const panel = page.getByRole('region', {
    name: 'Trigger dbo.audit_policy could not be converted',
  });
  await expect(panel.getByText('Compliance-critical: no named reviewer yet')).toBeVisible();
  await expect(panel.getByText(/a named reviewer must be assigned first/)).toBeVisible();
  await expect(panel.getByRole('radio', { name: /Reject/ })).toBeDisabled();
  await expect(page.getByRole('list', { name: 'Review items' })).toContainText('No named reviewer');
  await axe(page);
  await panel.getByRole('combobox', { name: /Reviewer/ }).click();
  await page.getByRole('option', { name: 'Pat Reviewer' }).click();
  await panel.getByRole('button', { name: 'Save reviewer' }).click();
  await expect
    .poll(() => requests.find((r) => r.method === 'PUT')?.body)
    .toEqual({ user_id: 'u2' });
});

// ---------------------------------------------------------------- planning workbench

const overview = {
  ready: true,
  blueprint_version: 3,
  notes: [],
  missing_packs: [],
  estimation: [],
  compliance_packs: [],
  max_task_hours: 40,
  discovery_run_id: null,
  delta_run_id: null,
  target_adapter: null,
  counts: { scope: 3 },
  scope_approved: 3,
  estimate: { low: 30, likely: 42, high: 60, tasks: 6 },
  waves_fit: true,
  cutover_choice: null,
  latest_baseline: {
    id: 'b1',
    number: 2,
    digest: 'x',
    summary: {},
    changes: {},
    reason: 'Ready for the steering committee.',
    status: 'proposed',
    proposed_by: 'Alex Lead',
    decided_by: null,
    decided_at: null,
    decision_note: null,
    created_at: '2026-11-18T10:00:00Z',
  },
  approved_baseline_id: null,
  baseline_awaiting_approval: true,
  can_approve_waiting: true,
  can_manage: true,
  can_approve: true,
};

function scopeItem(
  key: string,
  element: string,
  wave: string | null,
  depth: number,
  deps: string[],
) {
  return {
    key,
    element,
    kind: 'table',
    stream: 'data',
    segment: 'dbo',
    disposition: 'migrate',
    status: 'approved',
    wave,
    pinned_wave: null,
    depth,
    tasks: 2,
    overridden_tasks: 0,
    low: 10,
    likely: 14,
    high: 20,
    roles: { data_sme: 14 },
    depends_on: deps,
  };
}

const workbench = {
  waves: [
    {
      key: 'W1',
      name: 'Wave 1',
      start: '2027-01-04',
      end: '2027-02-26',
      cutover: '2027-02-27',
      capacity: { data_sme: 100 },
      load: { data_sme: { hours: 42, capacity: 100 } },
      items: ['table:dbo.party', 'table:dbo.policy', 'table:dbo.claim'],
    },
    {
      key: 'W2',
      name: 'Wave 2',
      start: '2027-03-01',
      end: '2027-04-30',
      cutover: null,
      capacity: { data_sme: 50 },
      load: {},
      items: [],
    },
  ],
  items: [
    scopeItem('table:dbo.party', 'dbo.party', 'W1', 0, []),
    scopeItem('table:dbo.policy', 'dbo.policy', 'W1', 1, ['table:dbo.party']),
    scopeItem('table:dbo.claim', 'dbo.claim', 'W1', 2, ['table:dbo.policy']),
  ],
  unplaced: [],
  unestimated: [],
  edges: [
    {
      key: 'table:dbo.policy->table:dbo.party',
      src: 'table:dbo.policy',
      dst: 'table:dbo.party',
      source: 'discovery',
      kinds: ['fk'],
      removed: null,
    },
    {
      key: 'table:dbo.claim->table:dbo.policy',
      src: 'table:dbo.claim',
      dst: 'table:dbo.policy',
      source: 'discovery',
      kinds: ['fk'],
      removed: null,
    },
  ],
  cycles: [],
  plan: {
    status: 'optimal',
    fits: true,
    assignments: {},
    broken: [],
    options: [],
    load: { W1: { data_sme: { hours: 42, capacity: 100 } } },
  },
  stale: true,
  roles: ['migration_lead', 'data_sme'],
  can_edit: true,
};

test('Plan workbench: move an item with the keyboard, see a refused batch on its pending change, then apply', async ({
  page,
}) => {
  await signInWithFixtureSession(page);
  let posts = 0;
  const { requests } = await mockApi(page, {
    ...common,
    '/api/v1/projects/pr1/plan': overview,
    '/api/v1/projects/pr1/plan/workbench': workbench,
    '/api/v1/projects/pr1/plan/tasks': { total: 0, offset: 0, roles: workbench.roles, items: [] },
    'POST /api/v1/projects/pr1/plan/workbench/edits': () => {
      posts += 1;
      if (posts === 1) {
        return {
          __problem: true,
          type: '/problems/validation',
          title: 'Some fields need attention',
          status: 422,
          detail: 'No such wave.',
          errors: [{ field: 'edits.0.wave', message: 'No such wave.' }],
        };
      }
      return {
        ...workbench,
        stale: false,
        applied: ['pinned table:dbo.claim to W2'],
        solve_error: null,
        solved_at: '2026-11-18T10:00:00Z',
      };
    },
  });
  await page.goto('/projects/pr1?tab=plan&section=workbench');
  await expect(page.getByRole('tab', { name: 'Workbench', selected: true })).toBeVisible();
  await expect(page.getByText('The plan changed after the last solve')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Re-solve', exact: true })).toBeVisible();
  await axe(page);

  const menu = page.getByRole('combobox', { name: 'Pin dbo.claim to wave' });
  await menu.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('option', { name: 'Pin to Wave 2' })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '1 pending change' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'pending change' })).toHaveText(
    /Pin dbo\.claim to wave W2\. 1 pending change\./,
  );
  await axe(page);

  await page.getByRole('button', { name: 'Apply and re-solve' }).click();
  await expect(page.getByText('Nothing was saved', { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Pending changes' })).toContainText(
    'Wave: No such wave.',
  );
  await page.getByRole('button', { name: 'Apply and re-solve' }).click();
  await expect(page.getByText('pinned table:dbo.claim to W2')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No pending changes' })).toBeVisible();
  const bodies = requests.filter((r) => r.method === 'POST').map((r) => r.body);
  expect(bodies).toEqual([
    { edits: [{ op: 'move', scope_key: 'table:dbo.claim', wave: 'W2' }] },
    { edits: [{ op: 'move', scope_key: 'table:dbo.claim', wave: 'W2' }] },
  ]);
  await axe(page);
});

test('Plan workbench: the dependency graph has a table alternative; the overview shows a waiting baseline', async ({
  page,
}) => {
  await signInWithFixtureSession(page);
  await mockApi(page, {
    ...common,
    '/api/v1/projects/pr1/plan': overview,
    '/api/v1/projects/pr1/plan/workbench': workbench,
    '/api/v1/projects/pr1/plan/tasks': { total: 0, offset: 0, roles: workbench.roles, items: [] },
  });
  await page.goto('/projects/pr1?tab=plan');
  await expect(page.getByText('Baseline 2 is waiting for approval')).toBeVisible();
  await axe(page);
  await page.getByRole('link', { name: 'Review and approve it' }).click();
  await expect(page).toHaveURL(/section=baselines/);

  await page.goto('/projects/pr1?tab=plan&section=workbench');
  await page.getByRole('tab', { name: 'Dependency graph' }).click();
  await expect(page.getByRole('img', { name: /Dependency graph/ })).toBeVisible();
  const deps = page.getByRole('table', { name: 'Dependencies' });
  await expect(deps).toContainText('dbo.claim');
  await expect(page.getByRole('table', { name: 'Elements by depth' })).toContainText('dbo.party');
  await axe(page);
});
