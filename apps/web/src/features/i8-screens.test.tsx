import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/errors';
import type {
  PlanOverview,
  PlanTask,
  PlanWorkbench,
  TaskPage,
  WorkbenchEditResult,
} from '@/api/planning-types';
import type { Project, ReviewItem } from '@/api/types';
import { jsonResponse, renderWithProviders, renderWithRouter } from '@/test/utils';
import { reviewItem, reviewQueue, reviewWorkbench } from '@/test/review-fixtures';
import { parseProjectSearch } from './blueprints/tabs';
import { PlanTab } from './plan/PlanTab';
import { WorkbenchView } from './plan/WorkbenchView';
import { editErrors, upsertEdit, validateTaskEdit } from './plan/workbench-model';
import {
  ageOf,
  evidenceTarget,
  parseReviewSearch,
  queueQuery,
  recordedMessage,
  validateDecision,
} from './review/model';
import { ReviewWorkbenchTab } from './review/ReviewWorkbenchTab';

// Test fixtures only: shapes follow /api/v1 (I8 review and planning workbenches); values are
// synthetic.
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
  roles: [],
};

/** Query strings of every GET to a path, as URLSearchParams. */
function queriesOf(path: string): URLSearchParams[] {
  return fetchMock.mock.calls
    .map(([input]) => (typeof input === 'string' ? input : (input as Request).url))
    .filter((u) => u.split('?')[0] === path)
    .map((u) => new URLSearchParams(u.split('?')[1] ?? ''));
}

function bodyOf(method: string, path: string): unknown {
  const call = [...fetchMock.mock.calls]
    .reverse()
    .find(
      ([input, init]) =>
        init?.method === method &&
        (typeof input === 'string' ? input : (input as Request).url).split('?')[0] === path,
    );
  const body = call?.[1]?.body;
  return typeof body === 'string' ? (JSON.parse(body) as unknown) : undefined;
}

const problem = (
  status: number,
  errors: { field: string; message: string }[],
  title = 'Some fields need attention',
) =>
  jsonResponse(
    { type: '/problems/validation', title, status, detail: errors[0]?.message ?? null, errors },
    status,
    'application/problem+json',
  );

// ---------------------------------------------------------------- models

describe('review model', () => {
  it('reads the view from the URL and drops unknown values', () => {
    expect(
      parseReviewSearch({
        item: 'r1',
        status: 'decided',
        risk: 'high',
        mine: 'true',
        offset: '25',
        bogus: 'x',
      }),
    ).toEqual({ item: 'r1', status: 'decided', risk: 'high', mine: true, offset: 25 });
    expect(parseReviewSearch({ status: 'nope', offset: '-3' })).toEqual({});
    expect(parseProjectSearch({ tab: 'reviews', item: 'r1', section: 'workbench' })).toEqual({
      tab: 'reviews',
      item: 'r1',
    });
    expect(parseProjectSearch({ tab: 'plan', section: 'workbench' })).toEqual({
      tab: 'plan',
      section: 'workbench',
    });
    expect(queueQuery({ pattern: 'conversion:trigger', mine: true, q: ' x ' })).toEqual({
      status: 'open',
      offset: 0,
      limit: 25,
      pattern_key: 'conversion:trigger',
      mine: true,
      q: 'x',
    });
  });

  it('needs a changed answer only when no agent can take the change back', () => {
    const rule = reviewItem({ requested_by_type: 'system' });
    const f = {
      action: 'change' as const,
      option: '',
      note: 'The mapping is wrong here.',
      changedValue: '',
    };
    expect(validateDecision(f, rule).changed_value).toMatch(/Give the changed answer/);
    const agent = reviewItem({ requested_by_type: 'agent', agent_run_id: 'run1' });
    expect(validateDecision(f, agent)).toEqual({});
    const twoPerson = reviewItem({ required_approvals: 2 });
    expect(validateDecision({ ...f, changedValue: 'x' }, twoPerson).action).toMatch(/Two people/);
    const second = reviewItem({
      required_approvals: 2,
      approvals: [{ user: 'A', option: 'Keep', note: null, at: null }],
    });
    expect(validateDecision({ ...f, action: 'approve', option: 'Drop' }, second).option).toMatch(
      /first approver chose “Keep”/,
    );
  });

  it('says what was recorded, including the two-person count', () => {
    const it2 = reviewItem({
      required_approvals: 2,
      approvals: [{ user: 'Fixture User', option: 'Keep', note: null, at: null }],
    });
    expect(
      recordedMessage({ recorded: 'approval_recorded', follow_up_error: null, item: it2 }).text,
    ).toBe(
      'Your approval is recorded — 1 of 2; a second person must approve before the item is resolved.',
    );
  });

  it('maps evidence kinds to the existing screens', () => {
    expect(
      evidenceTarget({
        label: 'x',
        kind: 'conversion_object',
        ref: { run_id: 'c1', name: 'dbo.p' },
      }),
    ).toEqual({ to: 'project', search: { tab: 'conversion', run: 'c1', object: 'dbo.p' } });
    expect(evidenceTarget({ label: 'x', kind: 'discovery_run', ref: { run_id: 'd1' } })).toEqual({
      to: 'discovery-run',
      runId: 'd1',
    });
    expect(evidenceTarget({ label: 'x', kind: 'agent_run', ref: { run_id: 'a1' } })).toEqual({
      to: 'project',
      search: { tab: 'agents', agent_run: 'a1' },
    });
    expect(evidenceTarget({ label: 'x', kind: 'unknown', ref: {} })).toBeNull();
    expect(ageOf('2026-11-15T10:00:00Z', new Date('2026-11-18T10:00:00Z'))).toBe('3 d');
  });
});

describe('planning workbench model', () => {
  it('maps edits.{n}.{field} errors onto the pending edits', () => {
    const pending = [
      { id: 7, edit: { op: 'move' as const, scope_key: 'a', wave: 'W9' } },
      { id: 8, edit: { op: 'task' as const, key: 't1', likely: 99, reason: 'too short' } },
    ];
    const err = new ApiError({
      type: '/problems/validation',
      title: 'Some fields need attention',
      status: 422,
      errors: [
        { field: 'edits.0.wave', message: 'No such wave.' },
        { field: 'edits.1.task.reason', message: 'String should have at least 10 characters' },
        { field: 'body', message: 'Other' },
      ],
    });
    const m = editErrors(err, pending);
    expect(m.byId.get(7)).toBe('Wave: No such wave.');
    expect(m.byId.get(8)).toBe('Reason: String should have at least 10 characters');
    expect(m.other).toEqual(['body: Other']);
  });

  it('keeps the last pending move of an item and validates task estimates like the API', () => {
    let list = upsertEdit([], { op: 'move', scope_key: 'a', wave: 'W1' }, 1);
    list = upsertEdit(list, { op: 'move', scope_key: 'a', wave: 'W2' }, 2);
    expect(list).toEqual([{ id: 2, edit: { op: 'move', scope_key: 'a', wave: 'W2' } }]);
    const t = task();
    const bad = validateTaskEdit(
      { role: t.role, low: '20', likely: '10', high: '30', reason: 'x' },
      t,
      40,
    );
    expect(bad.edit).toBeNull();
    expect(bad.errors.likely).toMatch(/low ≤ likely ≤ high/);
    expect(bad.errors.reason).toMatch(/at least 10/);
    const big = validateTaskEdit(
      { role: t.role, low: '8', likely: '50', high: '60', reason: 'Bigger than thought.' },
      t,
      40,
    );
    expect(big.errors.likely).toMatch(/at most 40 hours/);
    const ok = validateTaskEdit(
      { role: 'data_sme', low: '8', likely: '12', high: '16', reason: 'Workshop agreed this.' },
      t,
      40,
    );
    expect(ok.edit).toEqual({
      op: 'task',
      key: 't1',
      role: 'data_sme',
      likely: 12,
      high: 16,
      reason: 'Workshop agreed this.',
    });
  });
});

// ---------------------------------------------------------------- review workbench

const highItem = reviewItem({
  id: 'r1',
  title: 'Trigger dbo.audit_policy could not be converted',
  risk: 'high',
  compliance: 'critical',
  compliance_controls: ['CTRL-7'],
  required_approvals: 2,
  approvals: [{ user: 'Someone Else', option: 'Keep', note: null, at: '2026-11-17T10:00:00Z' }],
  priority: 400,
  priority_reasons: ['high risk', 'compliance critical (CTRL-7)', 'confidence 40%'],
  confidence: 0.4,
  owner_user: 'Pat Reviewer',
  owner_user_id: 'u2',
  pattern_key: 'conversion:trigger:compile',
});
const lowItem = reviewItem({
  id: 'r2',
  title: 'Unused tables after 90 days',
  risk: 'low',
  priority: 110,
});

describe('ReviewWorkbenchTab queue', () => {
  it('shows priority, risk, compliance with controls and approvals, and filters from facets', async () => {
    routes['/api/v1/projects/pr1/review-queue'] = () =>
      jsonResponse(
        reviewQueue([highItem, lowItem], {
          facets: { risk: { high: 1, low: 1 }, compliance: { critical: 1, none: 1 } },
          groups: [
            {
              pattern_key: 'conversion:trigger:compile',
              count: 3,
              example_title: 'Trigger does not compile',
            },
          ],
        }),
      );
    routes['/api/v1/roles'] = () => jsonResponse([]);
    renderWithRouter(<ReviewWorkbenchTab project={project} />);
    const list = await screen.findByRole('list', { name: 'Review items' });
    const rows = within(list).getAllByRole('button');
    expect(rows[0]).toHaveTextContent('Trigger dbo.audit_policy could not be converted');
    expect(rows[0]).toHaveTextContent('Compliance critical: CTRL-7');
    expect(rows[0]).toHaveTextContent('Approvals 1 of 2');
    expect(rows[0]).toHaveTextContent('Confidence 40%');
    expect(rows[0]).toHaveTextContent('Pat Reviewer');
    expect(rows[0]).toHaveTextContent(
      'Why this priority: high risk, compliance critical (CTRL-7), confidence 40%',
    );

    await userEvent.click(screen.getByRole('combobox', { name: 'Risk' }));
    await userEvent.click(await screen.findByRole('option', { name: 'High (1)' }));
    await waitFor(() =>
      expect(
        queriesOf('/api/v1/projects/pr1/review-queue').some((q) => q.get('risk') === 'high'),
      ).toBe(true),
    );

    await userEvent.click(screen.getByRole('button', { name: /Trigger does not compile/ }));
    await waitFor(() =>
      expect(
        queriesOf('/api/v1/projects/pr1/review-queue').some(
          (q) => q.get('pattern_key') === 'conversion:trigger:compile' && q.get('risk') === 'high',
        ),
      ).toBe(true),
    );
    expect(screen.getByRole('button', { name: /Trigger does not compile/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await userEvent.click(screen.getByRole('switch', { name: 'Only mine' }));
    await waitFor(() =>
      expect(
        queriesOf('/api/v1/projects/pr1/review-queue').some((q) => q.get('mine') === 'true'),
      ).toBe(true),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => {
      const last = queriesOf('/api/v1/projects/pr1/review-queue').at(-1)!;
      expect([...last.keys()].sort()).toEqual(['limit', 'offset', 'status']);
    });
  });

  it('writes the selection to the URL state', async () => {
    routes['/api/v1/projects/pr1/review-queue'] = () => jsonResponse(reviewQueue([lowItem]));
    routes['/api/v1/review-items/r2/workbench'] = () => jsonResponse(reviewWorkbench(lowItem));
    const onSearch = vi.fn();
    renderWithRouter(
      <ReviewWorkbenchTab project={project} search={{ status: 'all' }} onSearch={onSearch} />,
    );
    await userEvent.click(await screen.findByText('Unused tables after 90 days'));
    expect(onSearch).toHaveBeenCalledWith({ status: 'all', item: 'r2' }, false);
  });
});

async function openItem(item: ReviewItem, wb = reviewWorkbench(item)) {
  routes['/api/v1/projects/pr1/review-queue'] = () => jsonResponse(reviewQueue([item]));
  routes[`/api/v1/review-items/${item.id}/workbench`] = () => jsonResponse(wb);
  renderWithRouter(<ReviewWorkbenchTab project={project} search={{ item: item.id }} />);
  return screen.findByRole('region', { name: item.title });
}

describe('ReviewWorkbenchTab decisions', () => {
  it('records the first of two approvals and says a second person must approve', async () => {
    const item = reviewItem({ id: 'r5', title: 'Map policy status codes', required_approvals: 2 });
    routes['POST /api/v1/review-items/r5/decide'] = () =>
      jsonResponse({
        recorded: 'approval_recorded',
        follow_up_error: null,
        item: {
          ...item,
          approvals: [
            { user: 'Fixture User', option: 'Keep', note: null, at: '2026-11-18T10:00:00Z' },
          ],
          can_resolve: false,
          cannot_resolve_reason:
            'You have approved this item; a second person must approve it too.',
        },
      });
    const panel = await openItem(item);
    await userEvent.click(await within(panel).findByRole('radio', { name: /Approve an option/ }));
    expect(within(panel).getByText(/Needs 2 approvals from different people/)).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('radio', { name: 'Keep' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Approve' }));
    expect(
      await within(panel).findByText(
        'Your approval is recorded — 1 of 2; a second person must approve before the item is resolved.',
      ),
    ).toBeInTheDocument();
    expect(bodyOf('POST', '/api/v1/review-items/r5/decide')).toEqual({
      action: 'approve',
      note: '',
      option: 'Keep',
    });
  });

  it('needs the changed answer when no agent raised the item', async () => {
    const item = reviewItem({ id: 'r6', title: 'Choose the target code list' });
    routes['POST /api/v1/review-items/r6/decide'] = () =>
      jsonResponse({
        recorded: 'changed',
        follow_up_error: null,
        item: {
          ...item,
          status: 'resolved',
          changed_value: 'Use list B',
          resolution: 'Use list B',
        },
      });
    const panel = await openItem(item);
    await userEvent.click(await within(panel).findByRole('radio', { name: /Change the answer/ }));
    await userEvent.type(
      within(panel).getByRole('textbox', { name: /Reason/ }),
      'List A is retired.',
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Record change' }));
    expect(within(panel).getByText(/Give the changed answer/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(false);
    await userEvent.type(
      within(panel).getByRole('textbox', { name: /Changed answer/ }),
      'Use list B',
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Record change' }));
    expect(
      await within(panel).findByText(/Your changed answer is the decision: “Use list B”/),
    ).toBeInTheDocument();
    expect(bodyOf('POST', '/api/v1/review-items/r6/decide')).toEqual({
      action: 'change',
      note: 'List A is retired.',
      changed_value: 'Use list B',
    });
  });

  it('shows when a requested change could not reach the agent', async () => {
    const item = reviewItem({
      id: 'r7',
      title: 'Mapping proposal for party roles',
      requested_by: 'Schema mapper',
      requested_by_type: 'agent',
      agent_run_id: 'run1',
    });
    routes['POST /api/v1/review-items/r7/decide'] = () =>
      jsonResponse({
        recorded: 'changes_requested',
        follow_up_error: 'No released version of the agent is pinned on this project.',
        item: { ...item, status: 'changes_requested' },
      });
    const panel = await openItem(item);
    await userEvent.click(await within(panel).findByRole('radio', { name: /Request a change/ }));
    await userEvent.type(
      within(panel).getByRole('textbox', { name: /Note for the agent/ }),
      'Split the role mapping.',
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Record change' }));
    expect(
      await within(panel).findByText('The agent could not be asked to revise its work'),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(/No released version of the agent is pinned/),
    ).toBeInTheDocument();
  });

  it('keeps the form visible but disabled, with the reason, when the caller cannot decide', async () => {
    const item = reviewItem({
      id: 'r8',
      title: 'Retire the old claims table',
      compliance: 'critical',
      compliance_controls: ['CTRL-2'],
      can_resolve: false,
      cannot_resolve_reason:
        'This item is compliance-critical: a named reviewer must be assigned first.',
      can_assign_reviewer: true,
    });
    routes['PUT /api/v1/review-items/r8/reviewer'] = () =>
      jsonResponse({ ...item, owner_user: 'Pat Reviewer', owner_user_id: 'u2' });
    const panel = await openItem(
      item,
      reviewWorkbench(item, { reviewers: [{ id: 'u2', name: 'Pat Reviewer' }] }),
    );
    expect(
      await within(panel).findByText('Compliance-critical: no named reviewer yet'),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/a named reviewer must be assigned first/)).toBeInTheDocument();
    expect(within(panel).getByRole('radio', { name: /Reject/ })).toBeDisabled();
    expect(within(panel).getByRole('group', { name: 'Decision' })).toBeDisabled();

    await userEvent.click(within(panel).getByRole('combobox', { name: /Reviewer/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Pat Reviewer' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Save reviewer' }));
    await waitFor(() =>
      expect(bodyOf('PUT', '/api/v1/review-items/r8/reviewer')).toEqual({ user_id: 'u2' }),
    );
  });

  it('shows why the Review Assistant is unavailable and disables the question box', async () => {
    const item = reviewItem({ id: 'r9', title: 'Retirement review' });
    const panel = await openItem(
      item,
      reviewWorkbench(item, {
        assistant: {
          agent: 'review-assistant',
          pinned_version: null,
          can_ask: true,
          unavailable_reason: 'The Review Assistant is not pinned on this project.',
        },
        assistant_runs: [
          {
            run_id: 'ar1',
            question: 'Why was this raised?',
            by: 'Fixture User',
            at: '2026-11-17T10:00:00Z',
            status: 'succeeded',
            status_detail: null,
          },
        ],
      }),
    );
    expect(
      await within(panel).findByText('The Review Assistant is not pinned on this project.'),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(/It cannot approve, reject or change anything/),
    ).toBeInTheDocument();
    expect(within(panel).getByRole('textbox', { name: 'Your question' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Ask the assistant' })).toBeDisabled();
    expect(within(panel).getByRole('link', { name: 'Read the answer' })).toHaveAttribute(
      'href',
      '/projects/pr1?tab=agents&agent_run=ar1',
    );
  });

  it('shows code samples side by side, precedents, and evidence links into existing screens', async () => {
    const item = reviewItem({
      id: 'r10',
      title: 'Trigger needs review',
      pattern_key: 'conversion:trigger',
      evidence: [
        {
          label: 'Converted trigger dbo.t1',
          kind: 'conversion_object',
          ref: { run_id: 'c1', name: 'dbo.t1' },
        },
        { label: 'Discovery run', kind: 'discovery_run', ref: { run_id: 'd1' } },
      ],
    });
    const panel = await openItem(
      item,
      reviewWorkbench(item, {
        samples: {
          type: 'code',
          object_type: 'trigger',
          status: 'review',
          source: 'CREATE TRIGGER t1 ...',
          converted: null,
          review: ['Uses a cursor.'],
          warnings: [],
          compile: null,
        },
        precedents: {
          pattern_key: 'conversion:trigger',
          outcomes: { approved: 2, rejected: 1 },
          items: [
            {
              item_id: 'old1',
              project_id: 'pr9',
              project_name: 'Earlier project',
              same_project: false,
              title: 'Trigger needs review',
              outcome: 'approved',
              resolution: 'Convert by hand',
              changed_value: null,
              note: 'Rewritten as a set-based update.',
              decided_by: 'Alex Lead',
              decided_at: '2026-10-01T10:00:00Z',
            },
          ],
        },
      }),
    );
    expect(await within(panel).findByLabelText('Source code')).toHaveTextContent(
      'CREATE TRIGGER t1',
    );
    expect(within(panel).getByText('Not converted')).toBeInTheDocument();
    expect(within(panel).getByText('Uses a cursor.')).toBeInTheDocument();
    expect(within(panel).getByText('Approved: 2')).toBeInTheDocument();
    expect(within(panel).getByText(/Project Earlier project/)).toBeInTheDocument();
    expect(within(panel).getByText('Note: “Rewritten as a set-based update.”')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: /Converted trigger dbo.t1/ })).toHaveAttribute(
      'href',
      '/projects/pr1?tab=conversion&run=c1&object=dbo.t1',
    );
    expect(within(panel).getByRole('link', { name: /Discovery run/ })).toHaveAttribute(
      'href',
      '/discovery-runs/d1',
    );
  });
});

// ---------------------------------------------------------------- planning workbench

function task(over: Partial<PlanTask> = {}): PlanTask {
  return {
    key: 't1',
    scope: 'table:dbo.party',
    element: 'dbo.party',
    stream: 'data',
    segment: 'dbo',
    disposition: 'migrate',
    approved: true,
    title: 'Map dbo.party',
    activity: 'map',
    role: 'migration_lead',
    part: 1,
    parts: 1,
    low: 8,
    likely: 10,
    high: 14,
    evidence: { rule: 'data-table' },
    depends_on: [],
    wave: 'W1',
    ...over,
  };
}

const overview: PlanOverview = {
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
  counts: { scope: 2 },
  scope_approved: 2,
  estimate: null,
  waves_fit: true,
  cutover_choice: null,
  latest_baseline: null,
  approved_baseline_id: null,
  baseline_awaiting_approval: false,
  can_approve_waiting: false,
  can_manage: true,
  can_approve: false,
};

function workbench(over: Partial<PlanWorkbench> = {}): PlanWorkbench {
  const item = (
    key: string,
    element: string,
    wave: string | null,
    depth: number,
    deps: string[] = [],
  ) => ({
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
  });
  return {
    waves: [
      {
        key: 'W1',
        name: 'Wave 1',
        start: '2027-01-04',
        end: '2027-02-26',
        cutover: '2027-02-27',
        capacity: { data_sme: 100 },
        load: { data_sme: { hours: 28, capacity: 100 } },
        items: ['table:dbo.party', 'table:dbo.policy'],
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
      item('table:dbo.party', 'dbo.party', 'W1', 0),
      item('table:dbo.policy', 'dbo.policy', 'W1', 1, ['table:dbo.party']),
    ],
    unplaced: [],
    unestimated: ['table:dbo.notes'],
    edges: [
      {
        key: 'table:dbo.policy->table:dbo.party',
        src: 'table:dbo.policy',
        dst: 'table:dbo.party',
        source: 'discovery',
        kinds: ['fk'],
        removed: null,
      },
    ],
    cycles: [],
    plan: {
      status: 'optimal',
      fits: true,
      assignments: { 'table:dbo.party': 'W1', 'table:dbo.policy': 'W1' },
      broken: [],
      options: [],
      load: { W1: { data_sme: { hours: 28, capacity: 100 } } },
    },
    stale: false,
    roles: ['migration_lead', 'data_sme'],
    can_edit: true,
    ...over,
  };
}

function planRoutes(wb: PlanWorkbench = workbench()) {
  routes['/api/v1/projects/pr1/plan/workbench'] = () => jsonResponse(wb);
  routes['/api/v1/projects/pr1/plan'] = () => jsonResponse(overview);
  const page: TaskPage = { total: 1, offset: 0, roles: wb.roles, items: [task()] };
  routes['/api/v1/projects/pr1/plan/tasks'] = () => jsonResponse(page);
}

describe('WorkbenchView', () => {
  it('moves an item with the keyboard (no dragging), maps a 422 to the pending edit, then applies', async () => {
    planRoutes();
    let calls = 0;
    const solved: WorkbenchEditResult = {
      ...workbench(),
      applied: ['pinned table:dbo.policy to W2'],
      solve_error: null,
      solved_at: '2026-11-18T10:00:00Z',
      plan: {
        status: 'optimal',
        fits: false,
        assignments: {},
        broken: [{ constraint: 'capacity', wave: 'W2', role: 'data_sme', detail: 'Over by 4 h.' }],
        options: [],
        load: {},
      },
    };
    routes['POST /api/v1/projects/pr1/plan/workbench/edits'] = () => {
      calls += 1;
      return calls === 1
        ? problem(422, [{ field: 'edits.0.wave', message: 'No such wave.' }])
        : jsonResponse(solved);
    };
    renderWithProviders(<WorkbenchView project={project} />);
    expect(await screen.findByRole('heading', { name: 'No pending changes' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Wave 1/ })).toHaveTextContent(
      '2027-01-04 to 2027-02-26 · cutover 2027-02-27',
    );
    expect(screen.getByText('Data SME: 28 of 100 h')).toBeInTheDocument();

    const menu = screen.getByRole('combobox', { name: 'Pin dbo.policy to wave' });
    menu.focus();
    await userEvent.keyboard('{Enter}');
    const option = await screen.findByRole('option', { name: 'Pin to Wave 2' });
    expect(option).toBeInTheDocument();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(await screen.findByRole('heading', { name: '1 pending change' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Pin dbo.policy to wave W2. 1 pending change.',
    );
    // Shown in its new lane, marked as pending.
    expect(screen.getByRole('list', { name: 'Items in Wave 2' })).toHaveTextContent(
      'Pending: pin to W2',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Apply and re-solve' }));
    expect(await screen.findByText('Nothing was saved')).toBeInTheDocument();
    const pending = screen.getByRole('list', { name: 'Pending changes' });
    expect(within(pending).getByText('Wave: No such wave.')).toBeInTheDocument();
    expect(bodyOf('POST', '/api/v1/projects/pr1/plan/workbench/edits')).toEqual({
      edits: [{ op: 'move', scope_key: 'table:dbo.policy', wave: 'W2' }],
    });

    await userEvent.click(screen.getByRole('button', { name: 'Apply and re-solve' }));
    expect(await screen.findByText('Applied 1 change')).toBeInTheDocument();
    expect(screen.getByText('pinned table:dbo.policy to W2')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Applied 1 change. The plan does not fit: 1 broken constraint(s).',
    );
    expect(screen.getByRole('heading', { name: 'No pending changes' })).toBeInTheDocument();
  });

  it('batches a task change and a dependency removal with reasons', async () => {
    planRoutes();
    renderWithProviders(<WorkbenchView project={project} />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Task list' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit task Map dbo.party' }));
    const form = screen.getByRole('form', { name: 'Change task Map dbo.party' });
    const likely = within(form).getByRole('spinbutton', { name: /Likely/ });
    await userEvent.clear(likely);
    await userEvent.type(likely, '12');
    await userEvent.click(within(form).getByRole('button', { name: 'Add to pending changes' }));
    expect(within(form).getByText(/Say why \(at least 10 characters/)).toBeInTheDocument();
    await userEvent.type(
      within(form).getByRole('textbox', { name: /Reason/ }),
      'The workshop said 12.',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Add to pending changes' }));
    expect(await screen.findByRole('heading', { name: '1 pending change' })).toBeInTheDocument();
    expect(screen.getByText(/Pending: 8–14 h \(likely 12\)/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Dependency graph' }));
    expect(screen.getByRole('img', { name: /Dependency graph/ })).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove dependency: dbo.policy depends on dbo.party' }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      'Loaded together in one batch.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add to pending changes' }));
    expect(await screen.findByRole('heading', { name: '2 pending changes' })).toBeInTheDocument();
    expect(screen.getByText('Pending removal')).toBeInTheDocument();
  });

  it('shows the stale banner with re-solve, and no edit controls without can_edit', async () => {
    planRoutes(workbench({ stale: true, can_edit: false }));
    renderWithProviders(<WorkbenchView project={project} />);
    expect(await screen.findByText('The plan changed after the last solve')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Re-solve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply and re-solve' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /Pin dbo.party/ })).toBeNull();
    expect(screen.getByText(/No estimated work \(1\)/)).toBeInTheDocument();
  });
});

describe('PlanTab I7 follow-ups', () => {
  it('shows a waiting baseline with an approve link only for someone who may approve it', async () => {
    const waiting: PlanOverview = {
      ...overview,
      latest_baseline: {
        id: 'b1',
        number: 4,
        digest: 'x',
        summary: {},
        changes: {},
        reason: 'Ready.',
        status: 'proposed',
        proposed_by: 'Alex Lead',
        decided_by: null,
        decided_at: null,
        decision_note: null,
        created_at: '2026-11-18T10:00:00Z',
      },
      baseline_awaiting_approval: true,
      can_approve_waiting: true,
    };
    routes['/api/v1/projects/pr1/plan'] = () => jsonResponse(waiting);
    const onSection = vi.fn();
    renderWithRouter(<PlanTab project={project} section="overview" onSection={onSection} />);
    expect(await screen.findByText('Baseline 4 is waiting for approval')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Review and approve it' }));
    expect(onSection).toHaveBeenCalledWith('baselines');
  });

  it('hides the approve link when the caller cannot approve the waiting baseline', async () => {
    routes['/api/v1/projects/pr1/plan'] = () =>
      jsonResponse({ ...overview, baseline_awaiting_approval: true, can_approve_waiting: false });
    renderWithRouter(<PlanTab project={project} />);
    expect(await screen.findByText(/is waiting for approval/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Review and approve it' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Workbench' })).toBeInTheDocument();
  });
});
