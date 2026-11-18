import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConfigurationSection,
  CoverageReport,
  DiscoveryRun,
  GraphNodeDetail,
} from '@/api/discovery-types';
import { jsonResponse, renderWithProviders, renderWithRouter } from '@/test/utils';
import { CoverageReportView } from './discovery/CoverageReportView';
import { DiscoveryRunPage } from './discovery/DiscoveryRunPage';
import { NodeDetail } from './discovery/GraphExplorer';
import {
  activityFileError,
  edgeLabel,
  formatBytes,
  gapState,
  groupDocuments,
  groupEdges,
  lengthError,
  nodeUsage,
  nullRate,
  orderedPhases,
  orderGaps,
  percent,
  scopeDifferences,
} from './discovery/model';
import { ConfigurationResult } from './discovery/ResultViews';

// Test fixtures only: shapes follow /api/v1; values are synthetic.
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

const configuration: ConfigurationSection = {
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
    {
      kind: 'form',
      key: 'f2',
      name: 'cover_form',
      scope: 'BOOK-B',
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
        present_in: ['BOOK-A', 'BOOK-B'],
        missing_in: ['BOOK-C'],
      },
    ],
    different: [
      {
        kind: 'rate_table',
        name: 'base_rate',
        definitions: { 'BOOK-A': 'aaa', 'BOOK-B': 'aaa', 'BOOK-C': 'ccc' },
      },
    ],
    same_everywhere: 4,
  },
};

function report(over: Partial<CoverageReport> = {}): CoverageReport {
  return {
    id: 'cr1',
    project_id: 'p1',
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
        counts: { interfaces: 0, evidence_days: 0 },
        gaps: ['integrations:activity'],
      },
    ],
    gaps: [
      {
        id: 'process:logs',
        stream: 'process',
        severity: 'warning',
        message: 'Process logs are not imported yet.',
      },
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
    created_at: '2026-11-18T10:00:00Z',
    can_decide: true,
    ...over,
  };
}

describe('discovery model', () => {
  it('computes null rate, percentages and sizes', () => {
    expect(nullRate({ nulls: 25, rows: 100 })).toBe(0.25);
    expect(nullRate({ nulls: 0, rows: 0 })).toBeNull();
    expect(percent(0.25)).toBe('25.0%');
    expect(percent(1)).toBe('100%');
    expect(percent(null)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(null)).toBe('—');
  });

  it('checks activity files before reading them', () => {
    expect(activityFileError({ name: 'log.jsonl', size: 10 })).toBeNull();
    expect(activityFileError({ name: 'log.csv', size: 10 })).toBeNull();
    expect(activityFileError({ name: 'log.txt', size: 10 })).toMatch(/\.jsonl or \.csv/);
    expect(activityFileError({ name: 'log.csv', size: 26 * 1024 * 1024 })).toMatch(/25 MB/);
    expect(activityFileError({ name: 'log.csv', size: 0 })).toMatch(/empty/);
  });

  it('orders phases as the pipeline runs them', () => {
    const p = { usage: 1, inventory: 2, extra: 3, profile: 4 };
    expect(orderedPhases(p).map(([k]) => k)).toEqual(['inventory', 'profile', 'usage', 'extra']);
  });

  it('groups documents by type and age in age order', () => {
    const g = groupDocuments([
      { type: 'pdf', age: 'over 7 years', link_entity: 'policy', count: 2, bytes: 200 },
      { type: 'pdf', age: 'under 1 year', link_entity: 'policy', count: 1, bytes: 100 },
      { type: 'pdf', age: 'under 1 year', link_entity: 'claim', count: 1, bytes: 50 },
      { type: 'tif', age: '1-3 years', link_entity: 'claim', count: 1, bytes: 10 },
    ]);
    expect(g.map((x) => x.type)).toEqual(['pdf', 'tif']);
    expect(g[0]!.count).toBe(4);
    expect(g[0]!.ages.map((a) => a.age)).toEqual(['under 1 year', 'over 7 years']);
    expect(g[0]!.ages[0]!.bytes).toBe(150);
  });

  it('builds a per-scope comparison with variants and missing scopes', () => {
    const d = scopeDifferences(configuration);
    const rate = d.find((x) => x.name === 'base_rate')!;
    expect(rate.variants).toBe(2);
    expect(rate.cells.map((c) => [c.scope, c.variant])).toEqual([
      ['BOOK-A', 1],
      ['BOOK-B', 1],
      ['BOOK-C', 2],
    ]);
    const form = d.find((x) => x.name === 'cover_form')!;
    expect(form.cells.find((c) => c.scope === 'BOOK-C')?.definition).toBeNull();
  });

  it('orders open blocking gaps first and knows waived ones', () => {
    const r = report({
      waivers: [
        {
          gap_id: 'process:logs',
          reason: 'Process mining is later.',
          by: 'X',
          at: '2026-11-18T10:00:00Z',
        },
      ],
    });
    expect(orderGaps(r, r.gaps).map((g) => g.id)).toEqual([
      'integrations:activity',
      'process:logs',
    ]);
    expect(gapState(r, r.gaps[0]!)).toBe('waived');
    expect(lengthError('short', 15, 'Say why')).toMatch(/at least 15 characters, 5 so far/);
    expect(lengthError('long enough reason here', 15, 'Say why')).toBeUndefined();
  });

  it('labels edges by direction and reads node usage', () => {
    expect(edgeLabel('reads', 'out')).toBe('reads');
    expect(edgeLabel('reads', 'in')).toBe('read by');
    expect(edgeLabel('custom', 'out')).toBe('custom');
    expect(
      groupEdges([{ type: 'a' }, { type: 'b' }, { type: 'a' }]).map(([t, l]) => [t, l.length]),
    ).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
    const u = nodeUsage({ reads: 3, writes: 0, via: ['dbo.p'], unused: true, last_used: null });
    expect(u.unused).toBe(true);
    expect(u.items).toEqual([
      ['Reads', '3'],
      ['Writes', '0'],
      ['Via', 'dbo.p'],
    ]);
  });
});

describe('DiscoveryRunPage', () => {
  it('shows a partial usage phase with its reason', async () => {
    const run: DiscoveryRun = {
      id: 'd1',
      project_id: 'p1',
      connection_id: 'c1',
      connection_name: 'fixture-source',
      adapter: 'fixture-source@1.0.0',
      status: 'succeeded',
      status_detail: null,
      as_of: '2026-11-18T00:00:00Z',
      window_days: 90,
      phases: {
        inventory: { status: 'done', detail: '', counts: { table: 12 } },
        usage: {
          status: 'partial',
          detail: 'Activity covers 20 of 90 days; results are provisional.',
          counts: { evidence_days: 20, unused: 3 },
        },
      },
      summary: { coverage_pct: 44, nodes: 120, edges: 300, unused: 3, evidence_days: 20 },
      job_id: null,
      requested_by: 'Fixture User',
      created_at: '2026-11-18T10:00:00Z',
      finished_at: '2026-11-18T10:05:00Z',
      coverage_report_id: 'cr1',
    };
    routes['/api/v1/discovery-runs/d1'] = () => jsonResponse(run);
    renderWithRouter(<DiscoveryRunPage runId="d1" tab="summary" node={null} unused={false} />);
    const phases = await screen.findByRole('list', { name: 'Discovery phases' });
    const usage = within(phases).getByText('Usage').closest('li')!;
    expect(usage).toHaveTextContent('Partial');
    expect(usage).toHaveTextContent('Activity covers 20 of 90 days; results are provisional.');
    expect(screen.getByText('44%')).toBeInTheDocument();
  });
});

describe('CoverageReportView', () => {
  it('waives a gap and then shows the 409 open-gaps list when accepting too early', async () => {
    let waived = false;
    routes['POST /api/v1/coverage-reports/cr1/waivers'] = () => {
      waived = true;
      return jsonResponse(report());
    };
    routes['POST /api/v1/coverage-reports/cr1/decision'] = () =>
      jsonResponse(
        {
          type: '/problems/gaps-open',
          title: 'Blocking gaps remain',
          status: 409,
          detail: 'Waive each blocking gap with a reason, or run discovery again after closing it.',
          errors: [{ field: 'gaps', message: 'integrations:activity' }],
        },
        409,
        'application/problem+json',
      );
    renderWithRouter(<CoverageReportView report={report()} />);
    expect(await screen.findByText('1 blocking gap(s) open')).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole('button', { name: 'Waive gap' })[0]!);
    let dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Waive gap' }));
    expect(within(dialog).getByText(/at least 15 characters/)).toBeInTheDocument();
    expect(waived).toBe(false);
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      'Activity logs arrive next month.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Waive gap' }));
    await vi.waitFor(() => expect(waived).toBe(true));

    await userEvent.click(screen.getByRole('button', { name: 'Accept report' }));
    dialog = await screen.findByRole('dialog');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Note/ }),
      'Ready to plan now.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Accept report' }));
    expect(await within(dialog).findByText('Blocking gaps remain')).toBeInTheDocument();
    expect(within(dialog).getByText('integrations:activity')).toBeInTheDocument();
  });

  it('shows waivers and the decision of an accepted report, without actions', async () => {
    renderWithRouter(
      <CoverageReportView
        report={report({
          status: 'accepted',
          can_decide: false,
          blocking_open: [],
          waivers: [
            {
              gap_id: 'integrations:activity',
              reason: 'Activity logs arrive next month.',
              by: 'Fixture Lead',
              at: '2026-11-18T11:00:00Z',
            },
          ],
          decided_by: 'Fixture Lead',
          decided_at: '2026-11-18T12:00:00Z',
          decision_note: 'Ready to plan now.',
        })}
      />,
    );
    expect(await screen.findByText(/Waived by Fixture Lead/)).toHaveTextContent(
      'Activity logs arrive next month.',
    );
    expect(screen.getByText(/Ready to plan now\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept report' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Waive gap' })).not.toBeInTheDocument();
  });
});

describe('NodeDetail', () => {
  it('lists outgoing and incoming edges by type with links to the other nodes', async () => {
    const detail: GraphNodeDetail = {
      node: {
        id: 'table:dbo.party',
        kind: 'table',
        stream: 'data',
        element: 'dbo.party',
        usage: { reads: 40, writes: 2, executions: 0, last_used: null, via: [], unused: false },
        concept: 'ns.party',
        target: 'party',
        props: { rows: 1200, columns: 8 },
      },
      outgoing: [
        {
          type: 'has_column',
          node_id: 'column:dbo.party.name',
          element: 'dbo.party.name',
          node_kind: 'column',
          props: {},
        },
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
          node_id: 'interface:x',
          element: 'Report tool',
          node_kind: 'interface',
          props: {},
        },
      ],
    };
    renderWithRouter(
      <NodeDetail
        runId="d1"
        detail={detail}
        streams={{ data: 'Data and documents' }}
        unused={false}
      />,
    );
    const out = await screen.findByRole('region', { name: 'Outgoing edges' });
    expect(out).toHaveTextContent('has column');
    expect(out).toHaveTextContent('references');
    expect(within(out).getByRole('link', { name: 'dbo.region' })).toHaveAttribute(
      'href',
      expect.stringContaining('node=table%3Adbo.region'),
    );
    const inc = screen.getByRole('region', { name: 'Incoming edges' });
    expect(inc).toHaveTextContent('read by');
    expect(screen.getByRole('link', { name: 'ns.party' })).toHaveAttribute(
      'href',
      '/ontology/ns.party',
    );
    expect(
      screen.getByRole('img', { name: /dbo.party with 3 connected nodes/ }),
    ).toBeInTheDocument();
  });
});

describe('ConfigurationResult', () => {
  it('makes differences between books readable', async () => {
    routes['/api/v1/discovery-runs/d1/results/configuration'] = () => jsonResponse(configuration);
    renderWithProviders(<ConfigurationResult runId="d1" />);
    const rate = await screen.findByRole('region', { name: 'Rate table base_rate' });
    expect(rate).toHaveTextContent('2 different definitions');
    expect(within(rate).getByLabelText('base_rate in BOOK-C')).toHaveTextContent('rate: 1.25');
    expect(within(rate).getByText('Variant 2')).toBeInTheDocument();
    const form = screen.getByRole('region', { name: 'Form cover_form' });
    expect(form).toHaveTextContent('Missing in BOOK-C');
  });
});
