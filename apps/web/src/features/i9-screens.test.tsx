import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BuildArtifact,
  BuildArtifactDetail,
  DesignItemDetail,
  DesignItemSummary,
  DesignOverview,
} from '@/api/design-types';
import type { Project } from '@/api/types';
import { jsonResponse, renderWithRouter } from '@/test/utils';
import { parseProjectSearch } from './blueprints/tabs';
import { DesignTab } from './design/DesignTab';
import {
  bulkSet,
  changedEntries,
  decisionLines,
  pdfFileError,
  stepErrorsFromApi,
  targetError,
  validateSteps,
  type DesignSearch,
} from './design/model';
import { evidenceTarget } from './review/model';
import { ApiError } from '@/api/errors';

// Test fixtures only: shapes follow /api/v1 (I9 design and build, api/routes/design.py); values
// are synthetic.
const fetchMock = vi.fn<typeof fetch>();
type Handler = (init: RequestInit | undefined, url: URL) => Response;
let routes: Record<string, Handler> = {};

beforeEach(() => {
  routes = {};
  fetchMock.mockImplementation((input, init) => {
    const raw = typeof input === 'string' ? input : (input as Request).url;
    const url = new URL(raw, 'http://localhost');
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    const handler = routes[key] ?? routes[url.pathname];
    return handler
      ? Promise.resolve(handler(init, url))
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

const P = '/api/v1/projects/pr1';

function bodyOf(method: string, path: string): unknown {
  const call = [...fetchMock.mock.calls]
    .reverse()
    .find(
      ([input, init]) =>
        init?.method === method &&
        new URL(typeof input === 'string' ? input : (input as Request).url, 'http://localhost')
          .pathname === path,
    );
  const body = call?.[1]?.body;
  return typeof body === 'string' ? (JSON.parse(body) as unknown) : undefined;
}

function sent(method: string): boolean {
  return fetchMock.mock.calls.some(([, init]) => init?.method === method);
}

const problem = (status: number, errors: { field: string; message: string }[], title: string) =>
  jsonResponse(
    { type: '/problems/validation', title, status, detail: errors[0]?.message ?? null, errors },
    status,
    'application/problem+json',
  );

const ALL_STREAMS = {
  mapping: true,
  configuration: true,
  form: true,
  code: true,
  integration: true,
  report: true,
  page: true,
  security: true,
};

function overview(over: Partial<DesignOverview> = {}): DesignOverview {
  return {
    latest_run: {
      id: 'dr1',
      project_id: 'pr1',
      connection_id: 'c1',
      status: 'succeeded',
      status_detail: null,
      summary: {
        streams: {
          mapping: { items: 3, kept_decisions: 1, proposed: 2, in_review: 1 },
          report: { items: 1, kept_decisions: 0, blocked: 1 },
        },
        mapping: {
          columns: 3,
          in_review: 1,
          no_target: 0,
          threshold: 0.8,
          required_unmapped: [
            {
              source_table: 'dbo.policy',
              target_table: 'core.policy',
              required_unmapped: ['line_code'],
            },
          ],
        },
        blocked: {
          report: 'The target adapter records no report access mechanism and naming rules.',
        },
        problems: ['data dictionary: 2 columns have no type'],
        review_items: 1,
      },
      job_id: 'j1',
      requested_by: 'Alex Lead',
      created_at: '2026-11-18T09:00:00Z',
      finished_at: '2026-11-18T09:05:00Z',
    },
    counts: { mapping: { proposed: 2, in_review: 1 }, report: { blocked: 1 } },
    target_design: null,
    target_design_missing:
      "The pinned target's adapter has no design section, so streams that need it are blocked.",
    build: { generated: 0, tests_failed: 1, tests_passed: 1, approved: 0 },
    can_run: true,
    can_build: true,
    can_decide: ALL_STREAMS,
    ...over,
  };
}

function mapping(column: string, over: Partial<DesignItemDetail> = {}): DesignItemDetail {
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
    flags: ['the source allows nulls but the target column is required'],
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

function summaryOf(d: DesignItemDetail): DesignItemSummary {
  const {
    run_id: _r,
    updated_by: _u,
    readiness: _x,
    can_decide: _c,
    cannot_decide_reason: _w,
    files: _f,
    precedents: _p,
    entries: _e,
    tests: _t,
    test_runs: _tr,
    last_test: _l,
    definition: _d,
    ...rest
  } = d;
  return rest;
}

/** The register for one stream: list and item routes answer from `items`. */
function serve(items: DesignItemDetail[], ov: DesignOverview = overview()) {
  routes[`${P}/design`] = () => jsonResponse(ov);
  routes[`${P}/design/items`] = (_i, url) => {
    const st = url.searchParams.get('status');
    const rows = items.filter((x) => !st || x.status === st);
    return jsonResponse({ items: rows.map(summaryOf), total: rows.length });
  };
  routes[`${P}/design/item`] = (_i, url) => {
    const it = items.find((x) => x.key === url.searchParams.get('key'));
    return it
      ? jsonResponse(it)
      : jsonResponse(
          { type: '/problems/not-found', title: 'Design item not found', status: 404 },
          404,
        );
  };
}

function Harness({ initial }: { initial: DesignSearch }) {
  const [view, setView] = useState<DesignSearch>(initial);
  return <DesignTab project={project} search={view} onSearch={(n) => setView(n)} />;
}

// ---------------------------------------------------------------- models

describe('design model', () => {
  it('reads the design view from the URL and links review evidence to the design item', () => {
    expect(
      parseProjectSearch({ tab: 'design', section: 'mapping', key: 'dbo.policy.policy_no' }),
    ).toEqual({ tab: 'design', section: 'mapping', key: 'dbo.policy.policy_no' });
    expect(parseProjectSearch({ tab: 'design', section: 'bogus', artifact: 'a1' })).toEqual({
      tab: 'design',
      artifact: 'a1',
    });
    expect(parseProjectSearch({ tab: 'plan', section: 'mapping' })).toEqual({ tab: 'plan' });
    expect(
      evidenceTarget({
        label: 'Design register item',
        kind: 'design_item',
        ref: { stream: 'mapping', key: 'dbo.policy.status_cd' },
      }),
    ).toEqual({
      to: 'project',
      search: { tab: 'design', section: 'mapping', key: 'dbo.policy.status_cd' },
    });
    expect(
      evidenceTarget({ label: 'x', kind: 'design_item', ref: { stream: 'nope', key: 'k' } }),
    ).toBeNull();
  });

  it('checks targets, PDF files and integration test steps like the API', () => {
    expect(targetError('dbo.party.name')).toBeUndefined();
    expect(targetError('party.name')).toBeUndefined();
    expect(targetError('name')).toMatch(/schema\.table\.column/);
    expect(pdfFileError({ name: 'a.txt', size: 10, type: 'text/plain' })).toBe(
      'Choose a PDF file.',
    );
    expect(
      pdfFileError({ name: 'a.pdf', size: 21 * 1024 * 1024, type: 'application/pdf' }),
    ).toMatch(/limit is 20 MB/);
    const v = validateSteps([
      {
        name: 'ok',
        method: 'GET',
        path: 'https://x/y',
        body: '{',
        expect_status: '99',
        expect_keys: '',
      },
    ]);
    expect(v.steps).toBeNull();
    expect(v.errors[0]).toMatchObject({
      name: expect.stringMatching(/at least 3/) as unknown,
      path: expect.stringMatching(/holds no host/) as unknown,
      body: 'The body is not valid JSON.',
      expect_status: expect.stringMatching(/100 to 599/) as unknown,
    });
    const err = new ApiError({
      type: '/problems/validation',
      title: 'Some fields need attention',
      status: 422,
      errors: [{ field: 'steps.1.path', message: 'A path starts with / and holds no host.' }],
    });
    expect(stepErrorsFromApi(err)[1]).toEqual({ path: 'A path starts with / and holds no host.' });
  });

  it('bulk-sets access, sends only changes and words decision outcomes', () => {
    const saved = { 'page:A': null, 'page:B': 'view' as const };
    const next = bulkSet(saved, ['page:A', 'page:B'], 'none');
    expect(changedEntries(saved, next)).toEqual({ 'page:A': 'none', 'page:B': 'none' });
    expect(
      decisionLines(
        { decided: [], awaiting_second_approval: ['k'], refused: [], required_approvals: 2 },
        'approve',
      )[0]?.text,
    ).toMatch(/your approval is recorded \(1 of 2\)/);
  });
});

// ---------------------------------------------------------------- overview and runs

describe('Design overview', () => {
  it('starts a run on a checked source connection and shows the latest run', async () => {
    serve([]);
    routes['/api/v1/tenants/t1/source-connections'] = () =>
      jsonResponse([
        { id: 'c1', name: 'Legacy prod', engine: 'sqlserver', last_check: { status: 'succeeded' } },
        { id: 'c2', name: 'Legacy test', engine: 'sqlserver', last_check: null },
      ]);
    routes[`POST ${P}/design-runs`] = () =>
      jsonResponse({ ...overview().latest_run, id: 'dr2', status: 'queued' }, 201);
    renderWithRouter(<Harness initial={{}} />);
    expect(await screen.findByText('The target’s design section is missing')).toBeInTheDocument();
    expect(screen.getByText(/review item\(s\) were created/)).toBeInTheDocument();
    expect(screen.getByText('Blocked streams')).toBeInTheDocument();
    expect(screen.getByText(/records no report access mechanism/)).toBeInTheDocument();
    expect(screen.getByText('data dictionary: 2 columns have no type')).toBeInTheDocument();
    expect(screen.getByText('Required target columns nothing maps to')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Start design run' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start design run' }));
    expect(within(dialog).getByText('Choose a checked source connection.')).toBeInTheDocument();
    expect(sent('POST')).toBe(false);
    await userEvent.click(within(dialog).getByRole('combobox', { name: /Source connection/ }));
    expect(await screen.findByRole('option', { name: /Legacy test.*not checked/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await userEvent.click(screen.getByRole('option', { name: /Legacy prod/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start design run' }));
    await waitFor(() =>
      expect(bodyOf('POST', `${P}/design-runs`)).toEqual({ connection_id: 'c1' }),
    );
  });

  it('disables starting a run with the reason when the caller cannot run one', async () => {
    serve([], overview({ can_run: false }));
    renderWithRouter(<Harness initial={{}} />);
    expect(await screen.findByRole('button', { name: 'Start design run' })).toBeDisabled();
    expect(screen.getByText(/needs stage management on this project/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- mappings

describe('Mapping stream', () => {
  const a = mapping('policy_no');
  const b = mapping('status_cd', { confidence: 0.82 });
  const inReview = mapping('line_cd', {
    status: 'in_review',
    confidence: 0.41,
    review_item_id: 'rv1',
    readiness: 'The item is in the review queue; decide it there.',
  });

  it('bulk-approves selected proposals and shows a second approval and a refusal', async () => {
    serve([a, b, inReview]);
    routes[`POST ${P}/design/decisions`] = () =>
      jsonResponse({
        decided: [],
        awaiting_second_approval: ['dbo.policy.policy_no'],
        refused: [{ key: 'dbo.policy.status_cd', reason: 'Already approved.' }],
        required_approvals: 2,
      });
    renderWithRouter(<Harness initial={{ section: 'mapping' }} />);
    const list = await screen.findByRole('list', { name: 'Mappings items' });
    expect(within(list).getByText('dbo.policy.line_cd')).toBeInTheDocument();
    expect(
      within(list).getByRole('checkbox', { name: /Select dbo.policy.line_cd \(not selectable/ }),
    ).toBeDisabled();
    expect(within(list).getAllByRole('meter')[0]).toHaveAttribute('aria-valuenow', '91');
    expect(screen.getByText('Required target columns nothing maps to')).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Select every proposed item on this page' }),
    );
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve selected' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve 2 items' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve 2' }));
    expect(within(dialog).getByText(/Give a reason/)).toBeInTheDocument();
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      'Names and types match exactly.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve 2' }));
    expect(
      await screen.findByText(
        /1 item\(s\) need a second approval: your approval is recorded \(1 of 2\)/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('1 item(s) were refused and not changed.')).toBeInTheDocument();
    expect(screen.getByText(/: Already approved\./)).toBeInTheDocument();
    expect(bodyOf('POST', `${P}/design/decisions`)).toEqual({
      stream: 'mapping',
      keys: ['dbo.policy.policy_no', 'dbo.policy.status_cd'],
      action: 'approve',
      reason: 'Names and types match exactly.',
    });
  });

  it('maps a 422 on a changed target onto the target field', async () => {
    serve([a]);
    routes[`POST ${P}/design/decisions`] = () =>
      problem(
        422,
        [
          {
            field: 'target',
            message: 'dbo.party.nope is not a column of the pinned target baseline.',
          },
        ],
        'Some fields need attention',
      );
    renderWithRouter(<Harness initial={{ section: 'mapping', key: a.key }} />);
    const panel = await screen.findByRole('region', { name: 'dbo.policy.policy_no' });
    expect(within(panel).getByText('core.policy.policy_no')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Change target' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Target column/ }), 'nope');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      'The party table holds it.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Change and approve' }));
    expect(within(dialog).getByText(/Use schema\.table\.column/)).toBeInTheDocument();
    expect(sent('POST')).toBe(false);
    await userEvent.clear(within(dialog).getByRole('textbox', { name: /Target column/ }));
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Target column/ }),
      'dbo.party.nope',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Change and approve' }));
    expect(
      await within(dialog).findByText(
        'dbo.party.nope is not a column of the pinned target baseline.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: /Target column/ })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(bodyOf('POST', `${P}/design/decisions`)).toEqual({
      stream: 'mapping',
      keys: ['dbo.policy.policy_no'],
      action: 'change',
      reason: 'The party table holds it.',
      target: 'dbo.party.nope',
    });
  });

  it('cannot decide an item in the review queue and links to it', async () => {
    serve([a, inReview]);
    renderWithRouter(<Harness initial={{ section: 'mapping', key: inReview.key }} />);
    const panel = await screen.findByRole('region', { name: 'dbo.policy.line_cd' });
    expect(within(panel).getByText('Decided in the review queue')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: /Open the review item/ })).toHaveAttribute(
      'href',
      '/projects/pr1?tab=reviews&item=rv1',
    );
    for (const name of [
      'Approve proposed target',
      'Approve as not migrated',
      'Change target',
      'Reject',
    ]) {
      expect(within(panel).getByRole('button', { name })).toBeDisabled();
    }
    expect(within(panel).getByText('In the review queue: decide it there.')).toBeInTheDocument();
  });

  it('shows the role reason when the caller does not decide mappings', async () => {
    const noRole = mapping('policy_no', {
      can_decide: false,
      cannot_decide_reason: 'Mapping items are decided by the Data SME role.',
    });
    serve([noRole], overview({ can_decide: { ...ALL_STREAMS, mapping: false } }));
    renderWithRouter(<Harness initial={{ section: 'mapping', key: noRole.key }} />);
    const panel = await screen.findByRole('region', { name: 'dbo.policy.policy_no' });
    expect(within(panel).getByRole('button', { name: 'Approve proposed target' })).toBeDisabled();
    expect(
      within(panel).getByText('Mapping items are decided by the Data SME role.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve selected' })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- forms

describe('Form stream', () => {
  it('validates uploads, sends the PDF as base64 and shows the parity result', async () => {
    const golden = {
      role: 'golden' as const,
      name: 'golden.pdf',
      sha256: 'a'.repeat(64),
      bytes: 2048,
      uploaded_by: 'Alex Lead',
      uploaded_at: '2026-11-18T09:00:00Z',
    };
    let item: DesignItemDetail = {
      ...mapping('x'),
      stream: 'form',
      key: 'form:declarations',
      source: {
        kind: 'form_design',
        key: 'declarations',
        name: 'Declarations',
        scope: null,
        definition: { pages: 2 },
      },
      target: { format: 'pdf', conversion: 'convert' },
      proposed_target: { format: 'pdf', conversion: 'convert' },
      confidence: null,
      flags: ['parity against the approved golden copy is required before approval'],
      readiness: 'The converted form has not passed parity against its golden copy.',
      files: [golden],
    };
    const ov = overview();
    routes[`${P}/design`] = () => jsonResponse(ov);
    routes[`${P}/design/items`] = () => jsonResponse({ items: [summaryOf(item)], total: 1 });
    routes[`${P}/design/item`] = () => jsonResponse(item);
    routes[`PUT ${P}/design/form-files`] = () => {
      item = {
        ...item,
        files: [golden, { ...golden, role: 'converted', name: 'converted.pdf' }],
      };
      return jsonResponse(item);
    };
    routes[`POST ${P}/design/form-parity`] = () => {
      item = {
        ...item,
        parity: {
          passed: false,
          differences: ["page 2 text differs (similarity 0.93; first difference: '-Insured')"],
          pages: 2,
          golden_pages: 2,
          fields: 4,
          golden_fields: 4,
          converted_sha256: 'b'.repeat(64),
          golden_sha256: 'a'.repeat(64),
          at: '2026-11-18T10:00:00Z',
          by: 'Fixture User',
        },
      };
      return jsonResponse(item);
    };
    const user = userEvent.setup({ applyAccept: false });
    renderWithRouter(<Harness initial={{ section: 'form', key: 'form:declarations' }} />);
    const panel = await screen.findByRole('region', { name: 'Declarations' });
    expect(within(panel).getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(
      within(panel).getByText('The converted form has not passed parity against its golden copy.'),
    ).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Run parity' })).toBeDisabled();

    const input = within(panel).getByLabelText('Converted form');
    await user.upload(input, new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    expect(within(panel).getByText('Choose a PDF file.')).toBeInTheDocument();
    const big = new File(['%PDF-'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
    await user.upload(input, big);
    expect(within(panel).getByText(/limit is 20 MB/)).toBeInTheDocument();
    await user.upload(
      input,
      new File(['%PDF-1.4 fixture'], 'converted.pdf', { type: 'application/pdf' }),
    );
    await user.click(within(panel).getByRole('button', { name: 'Upload converted form' }));
    await waitFor(() =>
      expect(bodyOf('PUT', `${P}/design/form-files`)).toEqual({
        key: 'form:declarations',
        role: 'converted',
        name: 'converted.pdf',
        content_base64: btoa('%PDF-1.4 fixture'),
      }),
    );
    const run = await within(panel).findByRole('button', { name: 'Run parity' });
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);
    expect(await within(panel).findByText('Parity failed: 1 difference(s)')).toBeInTheDocument();
    expect(within(panel).getByText(/page 2 text differs/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Approve' })).toBeDisabled();
  });
});

// ---------------------------------------------------------------- integrations

describe('Integration stream', () => {
  it('edits the end-to-end test, maps step errors and shows a run result', async () => {
    let item: DesignItemDetail = {
      ...mapping('x'),
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
      readiness: 'Define the interface’s end-to-end test first.',
    };
    routes[`${P}/design`] = () => jsonResponse(overview());
    routes[`${P}/design/items`] = () => jsonResponse({ items: [summaryOf(item)], total: 1 });
    routes[`${P}/design/item`] = () => jsonResponse(item);
    routes['/api/v1/tenants/t1/target-connections'] = () =>
      jsonResponse([
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
      ]);
    let puts = 0;
    routes[`PUT ${P}/design/integration-test`] = (init) => {
      puts += 1;
      if (puts === 1) {
        return problem(
          422,
          [{ field: 'steps.0.path', message: 'A path starts with / and holds no host.' }],
          'Some fields need attention',
        );
      }
      const body = JSON.parse(init?.body as string) as { steps: DesignItemDetail['tests'] };
      item = { ...item, tests: body.steps, readiness: null, flags: [] };
      return jsonResponse(item);
    };
    routes[`POST ${P}/design/integration-test-runs`] = () =>
      jsonResponse({
        at: '2026-11-18T10:00:00Z',
        by: 'Fixture User',
        connection: 'Sandbox',
        blocked: null,
        passed: false,
        steps: [
          {
            step: 'Create a policy',
            status: 500,
            passed: false,
            problems: ['expected HTTP 201, got 500'],
          },
        ],
      });
    renderWithRouter(<Harness initial={{ section: 'integration', key: item.key }} />);
    const panel = await screen.findByRole('region', { name: 'Policy feed' });
    expect(within(panel).getByText('core.policy')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Run test' })).toBeDisabled();

    const name = within(panel).getByRole('textbox', { name: /Step 1 name/ });
    const path = within(panel).getByRole('textbox', { name: /Step 1 path/ });
    await userEvent.type(name, 'Create a policy');
    await userEvent.clear(path);
    await userEvent.type(path, 'https://evil.example/x');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save test' }));
    expect(within(panel).getByText(/holds no host \(letters/)).toBeInTheDocument();
    expect(sent('PUT')).toBe(false);
    expect(
      within(panel).getByText('Save the end-to-end test first: it has unsaved changes.'),
    ).toBeInTheDocument();

    await userEvent.clear(path);
    await userEvent.type(path, '/api/policies');
    await userEvent.click(within(panel).getByRole('combobox', { name: /Step 1 method/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'POST' }));
    await userEvent.type(
      within(panel).getByRole('textbox', { name: /Step 1 body/ }),
      '{{"number": "P1"}',
    );
    const status = within(panel).getByRole('textbox', { name: /Step 1 expected status/ });
    await userEvent.clear(status);
    await userEvent.type(status, '201');
    await userEvent.type(
      within(panel).getByRole('textbox', { name: /Step 1 expected response keys/ }),
      'id, status',
    );
    // The server's own path rule is shown on the step it names.
    await userEvent.click(within(panel).getByRole('button', { name: 'Save test' }));
    expect(
      await within(panel).findByText('A path starts with / and holds no host.'),
    ).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Save test' }));
    await waitFor(() => expect(puts).toBe(2));
    expect(bodyOf('PUT', `${P}/design/integration-test`)).toEqual({
      key: 'interface:policy-feed',
      steps: [
        {
          name: 'Create a policy',
          method: 'POST',
          path: '/api/policies',
          body: { number: 'P1' },
          expect_status: 201,
          expect_keys: ['id', 'status'],
        },
      ],
    });
    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: 'Approve' })).toBeEnabled(),
    );

    await userEvent.click(within(panel).getByRole('combobox', { name: /Target connection/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Sandbox/ }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Run test' }));
    expect(
      await within(panel).findByText('Test failed: 0 of 1 step(s) passed'),
    ).toBeInTheDocument();
    expect(within(panel).getByText('expected HTTP 201, got 500')).toBeInTheDocument();
    expect(bodyOf('POST', `${P}/design/integration-test-runs`)).toEqual({
      key: 'interface:policy-feed',
      target_connection_id: 'tc1',
    });
  }, 30_000);
});

// ---------------------------------------------------------------- security

describe('Security stream', () => {
  it('gates approval on a complete, saved access matrix', async () => {
    let item: DesignItemDetail = {
      ...mapping('x'),
      stream: 'security',
      key: 'profile:clerk',
      source: { profile: 'clerk', rights: null },
      target: { profile: 'clerk' },
      proposed_target: { profile: 'clerk' },
      confidence: null,
      flags: ['1 object(s) have no access decision'],
      entries: { 'page:Policy': null, 'report:core.rpt_claims': 'view' },
      missing: ['page:Policy'],
      readiness: '1 new object(s) have no access decision for this profile.',
    };
    routes[`${P}/design`] = () => jsonResponse(overview());
    routes[`${P}/design/items`] = () => jsonResponse({ items: [summaryOf(item)], total: 1 });
    routes[`${P}/design/item`] = () => jsonResponse(item);
    routes[`PUT ${P}/design/security`] = (init) => {
      const body = JSON.parse(init?.body as string) as { entries: Record<string, 'edit'> };
      item = {
        ...item,
        entries: { ...item.entries, ...body.entries },
        missing: [],
        flags: [],
        readiness: null,
      };
      return jsonResponse(item);
    };
    renderWithRouter(<Harness initial={{ section: 'security', key: 'profile:clerk' }} />);
    const panel = await screen.findByRole('region', { name: 'clerk' });
    const approve = within(panel).getByRole('button', { name: 'Approve' });
    expect(approve).toBeDisabled();
    expect(
      within(panel).getByText('1 new object(s) have no access decision for this profile.'),
    ).toBeInTheDocument();
    expect(within(panel).getByText('1 of 2')).toBeInTheDocument();
    expect(
      within(panel).getByRole('radio', { name: 'View access to report core.rpt_claims' }),
    ).toBeChecked();

    await userEvent.click(within(panel).getByRole('radio', { name: 'Edit access to page Policy' }));
    expect(within(panel).getByText('0 of 2')).toBeInTheDocument();
    expect(
      within(panel).getByText('Save the access decisions first: there are unsaved changes.'),
    ).toBeInTheDocument();
    expect(approve).toBeDisabled();
    await userEvent.click(within(panel).getByRole('button', { name: 'Save access decisions' }));
    await waitFor(() =>
      expect(bodyOf('PUT', `${P}/design/security`)).toEqual({
        key: 'profile:clerk',
        entries: { 'page:Policy': 'edit' },
      }),
    );
    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: 'Approve' })).toBeEnabled(),
    );
  });

  it('bulk-sets every undecided object', async () => {
    const item: DesignItemDetail = {
      ...mapping('x'),
      stream: 'security',
      key: 'profile:clerk',
      source: { profile: 'clerk', rights: null },
      target: { profile: 'clerk' },
      entries: { 'page:A': null, 'page:B': null, 'report:C': 'full' },
      missing: ['page:A', 'page:B'],
      readiness: '2 new object(s) have no access decision for this profile.',
    };
    serve([item]);
    renderWithRouter(<Harness initial={{ section: 'security', key: 'profile:clerk' }} />);
    const panel = await screen.findByRole('region', { name: 'clerk' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Set every undecided (2)' }));
    expect(within(panel).getByRole('radio', { name: 'View access to page A' })).toBeChecked();
    expect(within(panel).getByRole('radio', { name: 'View access to page B' })).toBeChecked();
    expect(within(panel).getByText('2 unsaved change(s)')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- build

describe('Build', () => {
  const art = (over: Partial<BuildArtifact>): BuildArtifact => ({
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
    ...over,
  });
  const detail = (
    a: BuildArtifact,
    over: Partial<BuildArtifactDetail> = {},
  ): BuildArtifactDetail => ({
    ...a,
    code: 'CREATE PROCEDURE [astra_xf].[xf_core__policy_from_dbo__policy]\nAS\nBEGIN\n  SET NOCOUNT ON;\nEND',
    tests: [
      { name: 'compiles', kind: 'compile' },
      { name: 'every source row arrives', kind: 'rows', check: 'SELECT 0', expect: 0 },
      {
        name: 'values preserved: policy_no -> policy_no',
        kind: 'values',
        check: 'SELECT 1',
        expect: 0,
      },
    ],
    results: [
      { name: 'compiles', passed: true, detail: null },
      { name: 'every source row arrives', passed: true, detail: null },
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
    ...over,
  });

  it('shows results and inputs, and approves only a version whose tests passed', async () => {
    const failed = art({});
    const passed = art({
      id: 'a2',
      name: 'core.party <- dbo.party',
      version: 1,
      status: 'tests_passed',
      test_summary: { tests: 2, passed: 2, failed: [] },
    });
    routes[`${P}/design`] = () => jsonResponse(overview());
    routes['/api/v1/jobs'] = () => jsonResponse([]);
    routes[`${P}/build-artifacts`] = () => jsonResponse([failed, passed]);
    routes['/api/v1/build-artifacts/a1'] = () => jsonResponse(detail(failed));
    routes['/api/v1/build-artifacts/a2'] = () =>
      jsonResponse(detail(passed, { can_approve: true, cannot_approve_reason: null, results: [] }));
    routes['POST /api/v1/build-artifacts/a2/approve'] = () =>
      jsonResponse({ ...passed, status: 'approved', runnable: true });
    renderWithRouter(<Harness initial={{ section: 'build' }} />);
    expect(await screen.findByText('Only approved versions can run')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Build artifacts' });
    expect(within(list).getAllByText('Not runnable')).toHaveLength(2);

    await userEvent.click(within(list).getByRole('button', { name: /core.policy <- dbo.policy/ }));
    const panel = await screen.findByRole('region', {
      name: 'core.policy <- dbo.policy, version 2',
    });
    expect(within(panel).getByLabelText('Code of core.policy <- dbo.policy')).toHaveTextContent(
      'CREATE PROCEDURE',
    );
    expect(within(panel).getByText('1 value(s) or row(s) differ')).toBeInTheDocument();
    expect(
      within(panel).getByText(/1 real sample row\(s\) from the newest extract/),
    ).toBeInTheDocument();
    expect(within(panel).getByText('Dana SME')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Approve version 2' })).toBeDisabled();
    expect(
      within(panel).getByText(/only a version whose tests passed is approved/),
    ).toBeInTheDocument();

    await userEvent.click(within(list).getByRole('button', { name: /core.party <- dbo.party/ }));
    const panel2 = await screen.findByRole('region', {
      name: 'core.party <- dbo.party, version 1',
    });
    await userEvent.type(within(panel2).getByRole('textbox', { name: /Approval note/ }), 'short');
    await userEvent.click(within(panel2).getByRole('button', { name: 'Approve version 1' }));
    expect(within(panel2).getByText(/Write at least 10 characters/)).toBeInTheDocument();
    expect(sent('POST')).toBe(false);
    await userEvent.type(
      within(panel2).getByRole('textbox', { name: /Approval note/ }),
      ' but reviewed line by line.',
    );
    await userEvent.click(within(panel2).getByRole('button', { name: 'Approve version 1' }));
    await waitFor(() =>
      expect(bodyOf('POST', '/api/v1/build-artifacts/a2/approve')).toEqual({
        note: 'short but reviewed line by line.',
      }),
    );
  });

  it('starts a build and follows its job', async () => {
    routes[`${P}/design`] = () => jsonResponse(overview());
    routes['/api/v1/jobs'] = () => jsonResponse([]);
    routes[`${P}/build-artifacts`] = () => jsonResponse([]);
    routes[`POST ${P}/build`] = () => jsonResponse({ job_id: 'jb1' }, 202);
    routes['/api/v1/jobs/jb1'] = () =>
      jsonResponse({
        id: 'jb1',
        kind: 'design.build',
        title: 'Build and test generated code for Fixture project',
        status: 'running',
        progress: 40,
        progress_message: 'Testing core.policy <- dbo.policy',
        result: null,
        error: null,
        attempts: 1,
        max_attempts: 3,
        tenant_id: 't1',
        project_id: 'pr1',
        requested_by: 'Fixture User',
        trace_id: null,
        created_at: '2026-11-18T10:00:00Z',
        started_at: '2026-11-18T10:00:01Z',
        finished_at: null,
        can_cancel: false,
      });
    renderWithRouter(<Harness initial={{ section: 'build' }} />);
    const start = await screen.findByRole('button', { name: 'Start build' });
    await waitFor(() => expect(start).toBeEnabled());
    await userEvent.click(start);
    expect(await screen.findByText('Testing core.policy <- dbo.policy')).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: 'Build and test progress' }),
    ).toBeInTheDocument();
  });
});
