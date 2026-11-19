import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignItemDetail, DesignOverview } from '@/api/design-types';
import type {
  CoexistenceDashboard,
  LoadRecord,
  LoadRunDetail,
  ParityCase,
  ParityRun,
  ReconBreak,
} from '@/api/loads-types';
import type { Project, User } from '@/api/types';
import { jsonResponse, renderWithRouter } from '@/test/utils';
import { parseProjectSearch } from './blueprints/tabs';
import { DesignTab } from './design/DesignTab';
import type { DesignSearch } from './design/model';
import { LoadsTab } from './loads/LoadsTab';
import {
  checkFixedPayload,
  decimalDiff,
  formatAmount,
  formatDifference,
  parityErrors,
  startErrors,
  type LoadsSearch,
} from './loads/model';

// Test fixtures only: shapes follow /api/v1 (I10 loads, api/routes/loads.py and the form layout
// approval in api/routes/design.py); values are synthetic.
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
  approved_version: 1,
  planning_gate: { ready: true, reason: 'The approved blueprint version 1 is ready.', version: 1 },
  permissions: ['stage:manage', 'review:resolve', 'target:load'],
  roles: [],
};

const A = '/api/v1';
const P = `${A}/projects/pr1`;
const OWNER = '11111111-2222-4333-8444-555555555555';

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

function calls(method: string, path: string): URL[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init?.method ?? 'GET') === method)
    .map(
      ([input]) =>
        new URL(typeof input === 'string' ? input : (input as Request).url, 'http://localhost'),
    )
    .filter((u) => u.pathname === path);
}

const problem = (status: number, errors: { field: string; message: string }[], title: string) =>
  jsonResponse(
    { type: '/problems/validation', title, status, detail: errors[0]?.message ?? null, errors },
    status,
    'application/problem+json',
  );

function run(over: Partial<LoadRunDetail> = {}): LoadRunDetail {
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
      'core.policy': { source: 3, transformed: 3, accepted: 1, loaded: 1, rejected: 1, invalid: 1 },
    },
    measures: [],
    dq: {},
    errors: [],
    counts: { loaded: 1, rejected: 1, invalid: 1 },
    repeat_of: null,
    breaks: 1,
  },
});
const r3 = run({
  id: 'r3',
  number: 3,
  summary: {
    tables: { 'core.policy': { source: 3, transformed: 3, accepted: 2, rehearsed: 2, invalid: 1 } },
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
        segments: { AUTO: 50, HOME: 100 },
      },
    },
    errors: [],
    counts: { rehearsed: 2, invalid: 1 },
    repeat_of: { run: 1, same_result: false },
    breaks: 2,
  },
  segment: { column: 'line_cd', values: ['AUTO', 'HOME'] },
});

function serveRuns(list: LoadRunDetail[]) {
  routes[`GET ${P}/load-runs`] = () => jsonResponse(list);
  for (const r of list) routes[`${A}/load-runs/${r.id}`] = () => jsonResponse(r);
  routes[`${A}/tenants/t1/target-connections`] = () =>
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
  routes[`${A}/tenants/t1/source-connections`] = () =>
    jsonResponse([
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
    ]);
  routes[`${A}/source-connections/c1/runs`] = () =>
    jsonResponse([
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
      {
        id: 'x0',
        connection_id: 'c1',
        kind: 'extract',
        mode: 'full',
        adapter: 'fixture-source',
        status: 'failed',
        status_detail: 'login failed',
        summary: {},
        job_id: null,
        requested_by: 'Alex Lead',
        created_at: '2026-11-16T09:00:00Z',
        finished_at: null,
      },
    ]);
}

const users: User[] = [
  {
    id: OWNER,
    email: 'dana.owner@example.test',
    display_name: 'Dana Owner',
    status: 'active',
    last_seen_at: null,
    assignments: [],
  },
];

function Harness({ initial }: { initial: LoadsSearch }) {
  const [view, setView] = useState<LoadsSearch>(initial);
  return <LoadsTab project={project} search={view} onSearch={(n) => setView(n)} />;
}

async function choose(combobox: HTMLElement, option: RegExp | string) {
  await userEvent.click(combobox);
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

// ---------------------------------------------------------------- models

describe('loads model', () => {
  it('reads the loads view from the URL', () => {
    expect(
      parseProjectSearch({ tab: 'loads', section: 'parity', parity_run: 'p1', run: 'r1' }),
    ).toEqual({
      tab: 'loads',
      section: 'parity',
      parity_run: 'p1',
      run: 'r1',
    });
    expect(parseProjectSearch({ tab: 'loads', section: 'build' })).toEqual({ tab: 'loads' });
    expect(parseProjectSearch({ tab: 'design', parity_run: 'p1' })).toEqual({ tab: 'design' });
  });

  it('computes amounts exactly to the cent', () => {
    expect(decimalDiff('300.00', '200.01')).toBe('-99.99');
    expect(decimalDiff('0.1', '0.30')).toBe('0.20');
    expect(decimalDiff(null, '1')).toBeNull();
    expect(formatAmount('1234567.5')).toBe('1,234,567.50');
    expect(formatAmount('-0.123')).toBe('−0.123');
    expect(formatDifference('0.00')).toBe('0.00');
    expect(formatDifference('12')).toBe('+12.00');
  });

  it('checks the start form, a fixed payload and a parity spec like the API', () => {
    const base = {
      connection: 'c1',
      extract: 'x1',
      target: '',
      segmentColumn: '',
      segmentValues: '',
    };
    expect(startErrors({ ...base, kind: 'rehearsal' })).toEqual({});
    expect(startErrors({ ...base, kind: 'load' }).target).toMatch(/choose a target connection/);
    expect(
      startErrors({ ...base, kind: 'rehearsal', segmentColumn: '1x', segmentValues: 'A' }).column,
    ).toMatch(/column name/);
    expect(checkFixedPayload('{"a":1,"b":2}', { a: 0, b: 0 })).toEqual({ value: { a: 1, b: 2 } });
    expect(checkFixedPayload('{"a":1,"c":2}', { a: 0, b: 0 })).toEqual({
      error:
        'A fixed record keeps the same columns as the original (not in the original: c; missing: b).',
    });
    expect(checkFixedPayload('[1]', { a: 0 })).toEqual({
      error: 'The fixed record must be a JSON object of column: value.',
    });
    const p = parityErrors({
      kind: 'rating',
      name: 'Re-rate',
      keys: 'policy_no',
      inputs: '',
      fields: [
        { name: 'policy_no', type: 'text', target_name: '' },
        { name: 'premium', type: 'money', target_name: '' },
        { name: 'premium', type: 'money', target_name: '' },
      ],
    });
    expect(p.form).toEqual({});
    expect(p.rows).toEqual({
      0: 'policy_no is a key field; compared fields are not keys.',
      2: 'premium is compared twice.',
    });
  });
});

// ---------------------------------------------------------------- load runs

describe('Load runs', () => {
  it('validates a rehearsal versus a load and starts a run with the pinned extract', async () => {
    serveRuns([r1]);
    const started = run({ id: 'r9', number: 9, status: 'queued', job_id: 'j9', summary: {} });
    routes[`POST ${P}/load-runs`] = () => {
      routes[`${A}/load-runs/r9`] = () => jsonResponse(started);
      return jsonResponse(started, 201);
    };
    routes[`${A}/jobs/j9`] = () =>
      jsonResponse({
        id: 'j9',
        kind: 'load.run',
        title: 'Load run 9',
        status: 'running',
        progress: 50,
        progress_message: 'Validating',
        result: null,
        error: null,
        attempts: 1,
        max_attempts: 3,
        tenant_id: 't1',
        project_id: 'pr1',
        requested_by: 'Fixture User',
        trace_id: null,
        created_at: '2026-11-18T10:00:00Z',
        started_at: null,
        finished_at: null,
        can_cancel: false,
      });
    renderWithRouter(<Harness initial={{ section: 'runs' }} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a run' }));
    const dialog = await screen.findByRole('dialog', { name: 'Start a load run' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start run' }));
    expect(within(dialog).getByText('Choose what kind of run to start.')).toBeInTheDocument();
    expect(within(dialog).getByText('Choose a successful extract run.')).toBeInTheDocument();

    // A load needs a target connection.
    await userEvent.click(within(dialog).getByRole('radio', { name: /^Load/ }));
    expect(within(dialog).getByRole('combobox', { name: /Target connection/ })).toBeInTheDocument();
    expect(
      within(dialog).getByText('A load sends records to the target: choose a target connection.'),
    ).toBeInTheDocument();

    // A rehearsal has none.
    await userEvent.click(within(dialog).getByRole('radio', { name: /^Rehearsal/ }));
    expect(within(dialog).queryByRole('combobox', { name: /Target connection/ })).toBeNull();
    expect(
      within(dialog).getByText('A rehearsal sends nothing, so it has no target connection.'),
    ).toBeInTheDocument();

    await choose(
      within(dialog).getByRole('combobox', { name: /Source connection/ }),
      /Legacy prod/,
    );
    const extract = within(dialog).getByRole('combobox', { name: /Extract run/ });
    await userEvent.click(extract);
    // Only successful extracts are offered.
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await userEvent.click(screen.getByRole('option', { name: /Full extract.*1,200 rows/ }));
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Segment column' }),
      'line_cd',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start rehearsal' }));
    expect(
      within(dialog).getByText('Give at least one value to load, or clear the column.'),
    ).toBeInTheDocument();
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Segment values/ }),
      'AUTO, HOME',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start rehearsal' }));
    await waitFor(() =>
      expect(bodyOf('POST', `${P}/load-runs`)).toEqual({
        kind: 'rehearsal',
        extract_run_id: 'x1',
        segment: { column: 'line_cd', values: ['AUTO', 'HOME'] },
      }),
    );
    expect(await screen.findByText('Run 9: rehearsal')).toBeInTheDocument();
    expect(await screen.findByText('Validating')).toBeInTheDocument();
  });

  it('shows pinned inputs, reconciliation to the cent, data quality and the repeat result', async () => {
    serveRuns([r3, r2, r1]);
    renderWithRouter(<Harness initial={{ section: 'runs', run: 'r3' }} />);
    const panel = await screen.findByRole('region', { name: 'Run 3: rehearsal' });
    expect(await within(panel).findByText('Different result from run 1')).toBeInTheDocument();
    expect(
      within(panel).getByText('Same inputs as run 1, but a different result'),
    ).toBeInTheDocument();
    expect(within(panel).getByText('xf_policy')).toBeInTheDocument();
    expect(within(panel).getByText('fixture-domain@1.0.0')).toBeInTheDocument();
    expect(within(panel).getByText('line_cd in AUTO, HOME')).toBeInTheDocument();

    const recon = within(panel).getByRole('table', { name: /Record counts per target table/ });
    expect(within(recon).getByRole('row', { name: /core\.policy/ })).toHaveTextContent(
      'Counts differ',
    );

    const measures = within(panel).getByRole('table', { name: /Totals of each measured amount/ });
    const premium = within(measures).getByRole('row', { name: /Premium/ });
    expect(premium).toHaveTextContent('300.00');
    expect(premium).toHaveTextContent('200.01');
    expect(premium).toHaveTextContent('−99.99');
    expect(premium).toHaveTextContent('Differs');

    const dq = within(panel).getByRole('table', { name: /Data quality per object/ });
    expect(within(dq).getByRole('columnheader', { name: 'Segment AUTO' })).toBeInTheDocument();
    const row = within(dq).getByRole('row', { name: /core\.policy/ });
    expect(row).toHaveTextContent('82.5%');
    expect(row).toHaveTextContent('66.7%');
    expect(row).toHaveTextContent('50.0%');
    expect(row).toHaveTextContent('100.0%');

    // The list shows the repeat badge and the breaks too.
    const list = screen.getByRole('list', { name: 'Load runs' });
    expect(within(list).getByRole('button', { name: /Run 3/ })).toHaveTextContent('2 break(s)');
  });
});

// ---------------------------------------------------------------- error queue

function record(over: Partial<LoadRecord>): LoadRecord {
  return {
    table: 'core.policy',
    key: 'P-1',
    source_key: 'P-1',
    segment: null,
    payload: { policy_no: 'P-1', premium: '100.00' },
    status: 'rejected',
    http_status: 422,
    reason: 'premium must be positive',
    failures: [],
    owner: null,
    triage: 'open',
    fixed_payload: null,
    note: null,
    ...over,
  };
}

describe('Error queue', () => {
  it('filters, triages, checks the fixed payload columns and reloads selected records', async () => {
    const rows = [
      record({}),
      record({
        key: 'P-2',
        status: 'invalid',
        http_status: null,
        reason: 'policy_no is required',
        failures: [
          {
            rule: 'STRUCT-REQUIRED',
            kind: 'structural',
            severity: 'blocking',
            column: 'policy_no',
            message: 'policy_no is required by the target.',
            fix: 'Map a source column to policy_no or set a default.',
          },
        ],
      }),
    ];
    serveRuns([r2, r1]);
    routes[`${A}/load-runs/r2/records`] = (_i, url) => {
      const st = url.searchParams.get('status');
      const items = rows.filter((x) => !st || x.status === st);
      return jsonResponse({
        items,
        total: items.length,
        by_status: { loaded: 1, rejected: 1, invalid: 1 },
      });
    };
    routes[`PATCH ${A}/load-runs/r2/records`] = () => jsonResponse({ ok: true });
    const r4 = run({
      id: 'r4',
      number: 4,
      kind: 'reload',
      parent_run_id: 'r2',
      status: 'queued',
      job_id: null,
    });
    routes[`POST ${A}/load-runs/r2/reload`] = () => {
      routes[`${A}/load-runs/r4`] = () => jsonResponse(r4);
      return jsonResponse(r4, 201);
    };
    const user = userEvent.setup();
    renderWithRouter(<Harness initial={{ section: 'errors', run: 'r2' }} />);
    expect(await screen.findByText('Rejected: 1')).toBeInTheDocument();
    expect(screen.getByText('Invalid: 1')).toBeInTheDocument();
    expect(await screen.findByText('2 record(s)')).toBeInTheDocument();

    await choose(screen.getByRole('combobox', { name: 'Status' }), 'Invalid (1)');
    await waitFor(() =>
      expect(
        calls('GET', `${A}/load-runs/r2/records`).some(
          (u) => u.searchParams.get('status') === 'invalid',
        ),
      ).toBe(true),
    );
    expect(await screen.findByText('1 record(s)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /core\.policy P-2/ }));
    const detail = await screen.findByRole('region', { name: 'core.policy P-2' });
    expect(within(detail).getByText('STRUCT-REQUIRED')).toBeInTheDocument();
    expect(
      within(detail).getByText('Map a source column to policy_no or set a default.'),
    ).toBeInTheDocument();

    // Will not fix needs a reason of at least ten characters.
    await user.type(within(detail).getByRole('textbox', { name: 'Owner' }), 'Dana Owner');
    await choose(within(detail).getByRole('combobox', { name: 'Triage state' }), 'Will not fix');
    await user.type(within(detail).getByRole('textbox', { name: /^Note/ }), 'short');
    await user.click(within(detail).getByRole('button', { name: 'Save triage' }));
    expect(
      within(detail).getByText('Write at least 10 characters (5 so far).'),
    ).toBeInTheDocument();
    expect(calls('PATCH', `${A}/load-runs/r2/records`)).toHaveLength(0);
    await user.type(within(detail).getByRole('textbox', { name: /^Note/ }), ' – retired line');
    await user.click(within(detail).getByRole('button', { name: 'Save triage' }));
    await waitFor(() =>
      expect(bodyOf('PATCH', `${A}/load-runs/r2/records`)).toEqual({
        table: 'core.policy',
        key: 'P-2',
        owner: 'Dana Owner',
        triage: 'wont_fix',
        note: 'short – retired line',
      }),
    );

    // A fixed payload keeps the same columns.
    const editor = within(detail).getByRole('textbox', { name: 'Fixed payload (JSON)' });
    fireEvent.change(editor, {
      target: { value: '{"policy_no":"P-2","premium":"100.00","extra":1}' },
    });
    await user.click(within(detail).getByRole('button', { name: 'Save fixed payload' }));
    expect(
      within(detail).getByText(/same columns as the original \(not in the original: extra\)/),
    ).toBeInTheDocument();
    expect(calls('PATCH', `${A}/load-runs/r2/records`)).toHaveLength(1);
    fireEvent.change(editor, { target: { value: '{"policy_no":"P-2","premium":"120.00"}' } });
    await user.click(within(detail).getByRole('button', { name: 'Save fixed payload' }));
    await waitFor(() =>
      expect(bodyOf('PATCH', `${A}/load-runs/r2/records`)).toEqual({
        table: 'core.policy',
        key: 'P-2',
        fixed_payload: { policy_no: 'P-2', premium: '120.00' },
      }),
    );

    // Reload the selected record as a new run.
    const reloadButton = screen.getByRole('button', { name: 'Reload selected' });
    expect(reloadButton).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Select core.policy P-2' }));
    expect(reloadButton).toBeEnabled();
    await user.click(reloadButton);
    await waitFor(() =>
      expect(bodyOf('POST', `${A}/load-runs/r2/reload`)).toEqual({
        records: [{ table: 'core.policy', key: 'P-2' }],
      }),
    );
    expect(await screen.findByText('Run 4: reload')).toBeInTheDocument();
  });

  it('explains why a rehearsal’s records cannot be reloaded', async () => {
    serveRuns([r1]);
    routes[`${A}/load-runs/r1/records`] = () =>
      jsonResponse({ items: [record({ status: 'invalid' })], total: 1, by_status: { invalid: 1 } });
    renderWithRouter(<Harness initial={{ section: 'errors', run: 'r1' }} />);
    expect(
      await screen.findByText(
        'A rehearsal sends nothing, so there is nothing to reload: start a load instead.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload selected' })).toBeDisabled();
    expect(
      await screen.findByRole('checkbox', { name: /Select core\.policy P-1 \(not selectable/ }),
    ).toBeDisabled();
  });
});

// ---------------------------------------------------------------- documents

describe('Documents', () => {
  it('runs the checks and lists broken and blocked documents', async () => {
    serveRuns([r2]);
    let checked = false;
    const summary = {
      documents: 3,
      broken_links: 1,
      sample_size: 2,
      sample: { blocked: 2 },
      blocked: 'The target adapter records no way to read documents back (documents.read_path).',
      passed: false,
    };
    routes[`GET ${A}/load-runs/r2/document-checks`] = (_i, url) => {
      if (!checked) return jsonResponse({ items: [], total: 0, summary: null });
      const items = [
        {
          doc_key: 'D1',
          entity: 'Policy',
          link_key: 'P-9',
          status: 'broken',
          detail: 'The Policy record P-9 has not been accepted by the target.',
        },
        {
          doc_key: 'D2',
          entity: 'Policy',
          link_key: 'P-1',
          status: 'blocked',
          detail: summary.blocked,
        },
      ].filter(
        (d) => !url.searchParams.get('status') || d.status === url.searchParams.get('status'),
      );
      return jsonResponse({ items, total: items.length, summary });
    };
    routes[`POST ${A}/load-runs/r2/document-checks`] = () => {
      checked = true;
      return jsonResponse(summary);
    };
    renderWithRouter(<Harness initial={{ section: 'documents', run: 'r2' }} />);
    expect(
      await screen.findByText('The documents of this run have not been checked.'),
    ).toBeInTheDocument();
    const runChecks = screen.getByRole('button', { name: 'Run checks' });
    await waitFor(() => expect(runChecks).toBeEnabled());
    await userEvent.click(runChecks);
    expect(await screen.findByText('The read-back sample is blocked')).toBeInTheDocument();
    expect(screen.getByText('Documents did not pass')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: /Documents of the run/ });
    expect(within(table).getByRole('row', { name: /D1/ })).toHaveTextContent('Broken link');
    expect(within(table).getByRole('row', { name: /D1/ })).toHaveTextContent('P-9');
    await choose(screen.getByRole('combobox', { name: 'Status' }), 'Blocked');
    await waitFor(() => expect(within(table).queryByRole('row', { name: /D1/ })).toBeNull());
  });
});

// ---------------------------------------------------------------- breaks

function brk(over: Partial<ReconBreak> = {}): ReconBreak {
  return {
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
    ...over,
  };
}

describe('Reconciliation breaks', () => {
  it('cannot close without an owner, then names one and closes with a reason', async () => {
    serveRuns([r2]);
    let current = brk();
    routes[`GET ${P}/recon-breaks`] = () => jsonResponse([current]);
    routes[`${A}/users`] = () => jsonResponse(users);
    routes[`PATCH ${A}/recon-breaks/b1`] = (init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        owner_user_id?: string;
        close_reason?: string;
      };
      current = body.owner_user_id
        ? { ...current, owner_user_id: body.owner_user_id, owner: 'Dana Owner' }
        : {
            ...current,
            status: 'closed',
            close_reason: body.close_reason ?? null,
            closed_by: 'Fixture User',
          };
      return jsonResponse(current);
    };
    const user = userEvent.setup();
    renderWithRouter(<Harness initial={{ section: 'breaks' }} />);
    const close = await screen.findByRole('button', { name: 'Close break' });
    expect(close).toBeDisabled();
    expect(
      screen.getByText('A break has an owner until it is closed: name one first.'),
    ).toBeInTheDocument();
    expect(screen.getByText('−99.99')).toBeInTheDocument();
    expect(screen.getByText('Run 2')).toBeInTheDocument();

    await choose(
      screen.getByRole('combobox', { name: 'Owner of core.policy: Premium' }),
      /Dana Owner/,
    );
    await user.click(screen.getByRole('button', { name: 'Name owner' }));
    await waitFor(() =>
      expect(bodyOf('PATCH', `${A}/recon-breaks/b1`)).toEqual({ owner_user_id: OWNER }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close break' })).toBeEnabled());
    await user.type(screen.getByRole('textbox', { name: /Reason to close/ }), 'too short');
    await user.click(screen.getByRole('button', { name: 'Close break' }));
    expect(screen.getByText('Write at least 10 characters (9 so far).')).toBeInTheDocument();
    await user.type(
      screen.getByRole('textbox', { name: /Reason to close/ }),
      ': the target rounds per line',
    );
    await user.click(screen.getByRole('button', { name: 'Close break' }));
    await waitFor(() =>
      expect(bodyOf('PATCH', `${A}/recon-breaks/b1`)).toEqual({
        close_reason: 'too short: the target rounds per line',
      }),
    );
  });

  it('asks for a user ID when people cannot be listed', async () => {
    serveRuns([r2]);
    routes[`GET ${P}/recon-breaks`] = () => jsonResponse([brk()]);
    routes[`${A}/users`] = () =>
      jsonResponse(
        { type: '/problems/forbidden', title: 'Forbidden', status: 403 },
        403,
        'application/problem+json',
      );
    renderWithRouter(<Harness initial={{ section: 'breaks' }} />);
    const id = await screen.findByRole('textbox', {
      name: /Owner of core\.policy: Premium \(user ID\)/,
    });
    await userEvent.type(id, 'not-a-uuid');
    expect(screen.getByText(/A user ID looks like/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Name owner' })).toBeDisabled();
    await userEvent.clear(id);
    await userEvent.type(id, OWNER);
    expect(screen.getByRole('button', { name: 'Name owner' })).toBeEnabled();
  });
});

// ---------------------------------------------------------------- parity

describe('Parity', () => {
  it('validates the comparison, sends both files as base64 and approves a difference', async () => {
    serveRuns([]);
    let runs: ParityRun[] = [];
    let cases: ParityCase[] = [];
    routes[`GET ${P}/parity-runs`] = () => jsonResponse(runs);
    routes[`POST ${P}/parity-runs`] = () => {
      const r: ParityRun = {
        id: 'p1',
        kind: 'rating',
        name: 'Re-rate renewals',
        spec: {
          keys: ['policy_no'],
          fields: [{ name: 'premium', type: 'money' }],
          inputs: ['state'],
        },
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
      runs = [r];
      cases = [
        {
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
        },
      ];
      return jsonResponse(r, 201);
    };
    routes[`${A}/parity-runs/p1/cases`] = (_i, url) => {
      const st = url.searchParams.get('status');
      const items = cases.filter((c) => !st || c.status === st);
      return jsonResponse({ run: runs[0], total: items.length, items, can_decide: true });
    };
    routes[`POST ${A}/parity-runs/p1/cases/decide`] = () => {
      cases = cases.map((c) => ({
        ...c,
        status: 'approved',
        decided_by: 'Fixture User',
        decided_at: '2026-11-18T10:05:00Z',
        note: 'Rounding agreed with finance.',
      }));
      runs = runs.map((r) => ({ ...r, summary: { ...r.summary, open: 0, passed: true } }));
      return jsonResponse({ decided: 1, open: 0, passed: true });
    };
    const user = userEvent.setup({ applyAccept: false });
    renderWithRouter(<Harness initial={{ section: 'parity' }} />);
    await user.click(await screen.findByRole('button', { name: 'Start a comparison' }));
    const dialog = await screen.findByRole('dialog', { name: 'Start a parity comparison' });
    await user.click(within(dialog).getByRole('button', { name: 'Compare' }));
    expect(within(dialog).getByText('Choose what the files contain.')).toBeInTheDocument();
    expect(
      within(dialog).getByText('Name the comparison (at least 3 characters).'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText('Name at least one key field that identifies each case.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Name the field.')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Choose a .csv or .json file.')).toHaveLength(2);

    await user.click(within(dialog).getByRole('radio', { name: /Re-rated policies/ }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Re-rate renewals');
    await user.type(within(dialog).getByRole('textbox', { name: /Key fields/ }), 'policy_no');
    await user.type(within(dialog).getByRole('textbox', { name: 'Field 1 name' }), 'policy_no');
    expect(
      within(dialog).getByText('policy_no is a key field; compared fields are not keys.'),
    ).toBeInTheDocument();
    await user.clear(within(dialog).getByRole('textbox', { name: 'Field 1 name' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Field 1 name' }), 'premium');
    await user.type(within(dialog).getByRole('textbox', { name: /Input fields/ }), 'state');
    const srcInput = within(dialog).getByLabelText('Source results');
    await user.upload(srcInput, new File(['x'], 'notes.txt', { type: 'text/plain' }));
    expect(srcInput).toHaveAccessibleDescription(/Choose a \.csv or \.json file\./);
    expect(srcInput).toHaveAttribute('aria-invalid', 'true');
    const big = new File(['a'], 'big.csv', { type: 'text/csv' });
    Object.defineProperty(big, 'size', { value: 41 * 1024 * 1024 });
    await user.upload(srcInput, big);
    expect(within(dialog).getByText(/the limit is 40 MB/)).toBeInTheDocument();
    const csvS = 'policy_no,premium,state\nP-1,100.00,NY\n';
    const csvT = 'policy_no,premium,state\nP-1,100.01,NY\n';
    await user.upload(srcInput, new File([csvS], 'source.csv', { type: 'text/csv' }));
    await user.upload(
      within(dialog).getByLabelText('Target results'),
      new File([csvT], 'target.csv', { type: 'text/csv' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Compare' }));
    await waitFor(() =>
      expect(bodyOf('POST', `${P}/parity-runs`)).toEqual({
        kind: 'rating',
        name: 'Re-rate renewals',
        spec: {
          keys: ['policy_no'],
          inputs: ['state'],
          fields: [{ name: 'premium', type: 'money' }],
        },
        source: { name: 'source.csv', content_base64: btoa(csvS) },
        target: { name: 'target.csv', content_base64: btoa(csvT) },
      }),
    );
    const panel = await screen.findByRole('region', { name: 'Re-rate renewals' });
    const totals = await within(panel).findByRole('table', { name: /Grand total/ });
    expect(within(totals).getByRole('row', { name: /premium/ })).toHaveTextContent('+0.01');
    expect(within(panel).getByText('100.00')).toBeInTheDocument();
    expect(within(panel).getByText('100.01')).toBeInTheDocument();
    expect(within(panel).getByText('NY')).toBeInTheDocument();

    const approve = within(panel).getByRole('button', { name: 'Approve selected' });
    expect(approve).toBeDisabled();
    expect(within(panel).getByText('Select open differences first.')).toBeInTheDocument();
    await user.click(within(panel).getByRole('checkbox', { name: 'Select P-1 premium' }));
    await user.type(within(panel).getByRole('textbox', { name: /Decision note/ }), 'Rounding');
    await user.click(approve);
    expect(within(panel).getByText('Write at least 10 characters (8 so far).')).toBeInTheDocument();
    await user.type(
      within(panel).getByRole('textbox', { name: /Decision note/ }),
      ' agreed with finance.',
    );
    await user.click(approve);
    await waitFor(() =>
      expect(bodyOf('POST', `${A}/parity-runs/p1/cases/decide`)).toEqual({
        cases: [{ key: 'P-1', field: 'premium' }],
        action: 'approve',
        note: 'Rounding agreed with finance.',
      }),
    );
    await choose(within(panel).getByRole('combobox', { name: 'Status' }), 'All');
    expect(await within(panel).findByText(/Approved by Fixture User/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- coexistence

describe('Coexistence', () => {
  it('saves the schedule with a named owner, then reconciles now with job progress', async () => {
    serveRuns([]);
    let dash: CoexistenceDashboard = {
      rules: [
        {
          key: 'policy',
          entity: 'Policy',
          wave: 'W1',
          system_of_record: 'source',
          end_date: '2027-03-31',
          exit_reconciliation: 'counts',
        },
      ],
      schedule: null,
      open_breaks: [
        brk({
          origin: 'coexistence',
          load_run_id: null,
          scope: 'Policy',
          measure: 'record count',
          owner: 'Dana Owner',
          owner_user_id: OWNER,
        }),
      ],
      can_manage: true,
      can_close: true,
    };
    routes[`GET ${P}/coexistence`] = () => jsonResponse(dash);
    routes[`${A}/users`] = () => jsonResponse(users);
    routes[`PUT ${P}/coexistence-schedule`] = () => {
      const sch = {
        connection_id: 'c1',
        owner_user_id: OWNER,
        owner: 'Dana Owner',
        hour_utc: 5,
        enabled: true,
        last_run_at: null,
        next_run_at: '2026-11-19T05:00:00Z',
      };
      dash = { ...dash, schedule: sch };
      return jsonResponse(sch);
    };
    routes[`POST ${P}/coexistence-reconcile`] = () => jsonResponse({ job_id: 'j5' }, 202);
    routes[`${A}/jobs/j5`] = () =>
      jsonResponse({
        id: 'j5',
        kind: 'coexistence.reconcile',
        title: 'Coexistence reconciliation',
        status: 'succeeded',
        progress: 100,
        progress_message: '1 break(s)',
        result: {},
        error: null,
        attempts: 1,
        max_attempts: 3,
        tenant_id: 't1',
        project_id: 'pr1',
        requested_by: 'Fixture User',
        trace_id: null,
        created_at: '2026-11-18T10:00:00Z',
        started_at: null,
        finished_at: '2026-11-18T10:01:00Z',
        can_cancel: false,
      });
    const user = userEvent.setup();
    renderWithRouter(<Harness initial={{ section: 'coexistence' }} />);
    const now = await screen.findByRole('button', { name: 'Reconcile now' });
    expect(now).toBeDisabled();
    expect(
      screen.getByText('Set the schedule first: it names the owner of the breaks.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Policy/ })).toHaveTextContent('W1');
    expect(screen.getByText('Open breaks (1)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(
      screen.getByText('Choose the source connection to read live counts from.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Breaks go to a named person: choose one.')).toBeInTheDocument();
    await choose(screen.getAllByRole('combobox', { name: /Source connection/ })[0]!, /Legacy prod/);
    await choose(screen.getByRole('combobox', { name: 'Owner of breaks' }), /Dana Owner/);
    await choose(screen.getByRole('combobox', { name: 'Hour (UTC)' }), '05:00 UTC');
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() =>
      expect(bodyOf('PUT', `${P}/coexistence-schedule`)).toEqual({
        connection_id: 'c1',
        owner_user_id: OWNER,
        hour_utc: 5,
        enabled: true,
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reconcile now' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Reconcile now' }));
    expect(await screen.findByText('1 break(s)')).toBeInTheDocument();
    expect(screen.getByText('Finished')).toBeInTheDocument();
  });

  it('shows the API problem when the schedule names someone who is not an active person', async () => {
    serveRuns([]);
    routes[`GET ${P}/coexistence`] = () =>
      jsonResponse({
        rules: [],
        schedule: null,
        open_breaks: [],
        can_manage: true,
        can_close: true,
      });
    routes[`${A}/users`] = () => jsonResponse(users);
    routes[`PUT ${P}/coexistence-schedule`] = () =>
      problem(
        422,
        [
          {
            field: 'owner_user_id',
            message: 'Breaks go to a named person: choose an active person.',
          },
        ],
        'Invalid request',
      );
    const user = userEvent.setup();
    renderWithRouter(<Harness initial={{ section: 'coexistence' }} />);
    await choose(await screen.findByRole('combobox', { name: /Source connection/ }), /Legacy prod/);
    await choose(screen.getByRole('combobox', { name: 'Owner of breaks' }), /Dana Owner/);
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(
      await screen.findByText('Breaks go to a named person: choose an active person.'),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- forms: layout approval

describe('Form layout approval', () => {
  it('separates content and layout differences and approves layout-only differences with a note', async () => {
    const ov = {
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
    } as DesignOverview;
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
    let item = {
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
    } as unknown as DesignItemDetail;
    routes[`${P}/design`] = () => jsonResponse(ov);
    routes[`${P}/design/items`] = () => jsonResponse({ items: [item], total: 1 });
    routes[`${P}/design/item`] = () => jsonResponse(item);
    routes[`POST ${P}/design/form-layout-approval`] = () => {
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
      return jsonResponse(item);
    };
    function DesignHarness() {
      const [view, setView] = useState<DesignSearch>({ section: 'form', key: 'form:declarations' });
      return <DesignTab project={project} search={view} onSearch={(n) => setView(n)} />;
    }
    const user = userEvent.setup();
    renderWithRouter(<DesignHarness />);
    const panel = await screen.findByRole('region', { name: 'Declarations' });
    expect(within(panel).getByText('Layout only: 1 difference(s)')).toBeInTheDocument();
    expect(
      within(panel).getByText('Layout differences (1): a person may approve them'),
    ).toBeInTheDocument();
    expect(within(panel).queryByText(/Content differences/)).toBeNull();
    const approve = within(panel).getByRole('button', { name: 'Approve layout differences' });
    await user.type(within(panel).getByRole('textbox', { name: /Approval note/ }), 'Letter');
    await user.click(approve);
    expect(within(panel).getByText('Write at least 10 characters (6 so far).')).toBeInTheDocument();
    await user.type(
      within(panel).getByRole('textbox', { name: /Approval note/ }),
      ' size is agreed.',
    );
    await user.click(approve);
    await waitFor(() =>
      expect(bodyOf('POST', `${P}/design/form-layout-approval`)).toEqual({
        key: 'form:declarations',
        note: 'Letter size is agreed.',
      }),
    );
    expect(await within(panel).findByText('Layout differences approved')).toBeInTheDocument();
    expect(within(panel).getByText(/Approved by Fixture User/)).toBeInTheDocument();
  });

  it('shows content differences as failing with no approval action', async () => {
    const ov = {
      latest_run: null,
      counts: {},
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
    } as DesignOverview;
    const item = {
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
      proposed_target: null,
      confidence: null,
      flags: [],
      evidence: [],
      decision: null,
      review_item_id: null,
      approvals: null,
      parity: {
        passed: false,
        differences: [
          'pages: converted has 2, golden copy has 1',
          'fields missing from the converted form: insured',
        ],
        content_differences: ['fields missing from the converted form: insured'],
        layout_differences: ['pages: converted has 2, golden copy has 1'],
        layout_only: false,
        pages: 2,
        golden_pages: 1,
        fields: 2,
        golden_fields: 3,
        converted_sha256: 'b'.repeat(64),
        golden_sha256: 'a'.repeat(64),
        at: '2026-11-18T10:00:00Z',
        by: 'Fixture User',
      },
      missing: null,
      key_columns: null,
      desktop: null,
      updated_at: '2026-11-18T10:00:00Z',
      run_id: 'dr1',
      updated_by: 'design',
      precedents: [],
      readiness:
        'The converted form has not passed parity against its golden copy (content differences fail).',
      can_decide: true,
      cannot_decide_reason: null,
      files: [],
    } as unknown as DesignItemDetail;
    routes[`${P}/design`] = () => jsonResponse(ov);
    routes[`${P}/design/items`] = () => jsonResponse({ items: [item], total: 1 });
    routes[`${P}/design/item`] = () => jsonResponse(item);
    renderWithRouter(
      <DesignTab project={project} search={{ section: 'form', key: 'form:declarations' }} />,
    );
    const panel = await screen.findByRole('region', { name: 'Declarations' });
    expect(within(panel).getByText('Parity failed: 2 difference(s)')).toBeInTheDocument();
    expect(
      within(panel).getByText('Content differences (1): these fail the test'),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText('Layout differences (1): approvable once content matches'),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Approve layout differences' })).toBeNull();
  });
});
