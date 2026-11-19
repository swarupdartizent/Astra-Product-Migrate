import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Consent,
  Fleet,
  FleetScan,
  Metering,
  MciScore,
  PortfolioPlan,
  ProgrammeDetail,
  ProgrammeView,
} from '@/api/programmes-types';
import { jsonResponse, renderWithRouter } from '@/test/utils';
import {
  consentErrors,
  parseProgrammeSearch,
  partnerScopeText,
  setupDraft,
  setupErrors,
  type ProgrammeSearch,
} from './programmes/model';
import { ProgrammePage } from './programmes/ProgrammePage';

// Test fixtures only: shapes follow /api/v1 (I12 programmes, api/routes/programmes.py and
// programme.py); names and values are synthetic.
const fetchMock = vi.fn<typeof fetch>();
type Handler = (init: RequestInit | undefined, url: URL) => Response;
let routes: Record<string, Handler> = {};

beforeEach(() => {
  routes = {
    '/api/v1/me': () =>
      jsonResponse({
        id: '00000000-0000-4000-8000-000000000001',
        email: 'fixture.user@example.test',
        display_name: 'Fixture User',
        mfa: true,
        roles: [],
        permissions: ['tenant:read', 'programme:manage'],
      }),
  };
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
  vi.restoreAllMocks();
});

const A = '/api/v1';
const PR = `${A}/programmes/p1`;

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

function calls(method: string, path: string): number {
  return fetchMock.mock.calls.filter(
    ([input, init]) =>
      (init?.method ?? 'GET') === method &&
      new URL(typeof input === 'string' ? input : (input as Request).url, 'http://localhost')
        .pathname === path,
  ).length;
}

function problem(status: number, title: string, errors?: unknown): Response {
  return jsonResponse(
    { type: `/problems/${String(status)}`, title, status, ...(errors ? { errors } : {}) },
    status,
    'application/problem+json',
  );
}

// programme.MEASURES defaults: key, label, weight, low, high
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

function detail(over: Partial<ProgrammeDetail> = {}): ProgrammeDetail {
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

function mci(score = 42.5): MciScore {
  return {
    score,
    band: score < 35 ? 'simple' : score < 65 ? 'medium' : 'complex',
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
  };
}

function scan(over: Partial<FleetScan> = {}): FleetScan {
  return {
    id: 's1',
    tenant_id: 't1',
    status: 'succeeded',
    status_detail: null,
    measures: { tables: 775, rows: 120000, data_volume_log10: 5.079, documents: 0 },
    mci: mci(),
    job_id: 'j1',
    consent_id: 'c1',
    requested_by: 'Fixture User',
    created_at: '2026-11-18T09:00:00Z',
    finished_at: '2026-11-18T09:05:00Z',
    ...over,
  };
}

const consent: Consent = {
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

function view(over: Partial<ProgrammeView> = {}): ProgrammeView {
  return {
    programme: { id: 'p1', name: 'Fixture programme' },
    customers: [
      {
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
      },
    ],
    totals: {
      customers: 1,
      bands: { medium: 1 },
      open_vendor_gaps: 2,
      open_breaks: 1,
      open_risks: 5,
    },
    scope: 'programme',
    ...over,
  };
}

function Harness({ initial }: { initial?: ProgrammeSearch }) {
  return <ProgrammePage programmeId="p1" {...(initial ? { search: initial } : {})} />;
}

/** Search held in state, like the route does. */
function Stateful({ initial }: { initial: ProgrammeSearch }) {
  const [search, setSearch] = useState<ProgrammeSearch>(initial);
  return <ProgrammePage programmeId="p1" search={search} onSearch={(next) => setSearch(next)} />;
}

function rowCells(container: HTMLElement, header: string | RegExp): string[] {
  const th = within(container).getByRole('rowheader', { name: header });
  const tr = th.closest('tr');
  return tr ? [...tr.querySelectorAll('td')].map((td) => td.textContent) : [];
}

async function choose(combobox: HTMLElement, option: RegExp | string) {
  await userEvent.click(combobox);
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

async function setNumber(input: HTMLElement, value: string) {
  await userEvent.clear(input);
  await userEvent.type(input, value);
}

describe('model', () => {
  it('parses the URL view', () => {
    expect(parseProgrammeSearch({ section: 'fleet', customer: 't1' })).toEqual({
      section: 'fleet',
      customer: 't1',
    });
    expect(parseProgrammeSearch({ section: 'nope', customer: '' })).toEqual({});
  });

  it('words the partner scope', () => {
    expect(partnerScopeText([{ id: 'a', name: 'Partner A', pods: [] }])).toBe(
      'You see only Partner A’s customers.',
    );
    expect(
      partnerScopeText([
        { id: 'a', name: 'Partner A', pods: [] },
        { id: 'b', name: 'Partner B', pods: [] },
      ]),
    ).toBe('You see only the customers of Partner A and Partner B.');
  });

  it('validates the set-up like the API', () => {
    const p = detail();
    const draft = setupDraft(p);
    expect(setupErrors(draft, p.mci.measures, ['Region north'])).toEqual({});
    const bad = {
      ...draft,
      weights: { ...draft.weights, tables: '0.3' },
      lows: { ...draft.lows, traps: '30' },
      bandSimple: '70',
      segments: 'Region south\nRegion south',
    };
    const errors = setupErrors(bad, p.mci.measures, ['Region north']);
    expect(errors.weights).toMatch(/add up to 1\.200/);
    expect(errors['high.traps']).toBe('High must be above low.');
    expect(errors.bandMedium).toMatch(/above the simple limit/);
    expect(errors.segments).toBe('Segment names must be distinct.');
    expect(
      setupErrors({ ...draft, segments: 'Region south' }, p.mci.measures, ['Region north'])
        .segments,
    ).toBe('Customers still use: Region north.');
  });

  it('validates consent', () => {
    const e = consentErrors({
      signatory_name: 'D',
      signatory_title: 'CIO',
      scope: 'too short',
      reference: 'x',
    });
    expect(Object.keys(e).sort()).toEqual(['reference', 'scope', 'signatory_name']);
  });
});

describe('Overview', () => {
  it('shows totals and per-customer figures for the programme owner', async () => {
    routes[`GET ${PR}`] = () => jsonResponse(detail());
    routes[`GET ${PR}/view`] = () => jsonResponse(view());
    renderWithRouter(<Harness />);
    const table = await screen.findByRole('region', { name: 'Programme customers' });
    const row = within(table).getAllByRole('row')[1]!;
    expect(within(row).getByText(/3 of 8, next: Design/)).toBeInTheDocument();
    expect(within(row).getByText('Partner A')).toBeInTheDocument();
    expect(within(row).getByText('Load 4 (rehearsal)')).toBeInTheDocument();
    expect(within(row).getByText('loaded 1,200 · rejected 3')).toBeInTheDocument();
    expect(screen.getByText('Medium: 1')).toBeInTheDocument();
    expect(screen.queryByText(/You see only/)).toBeNull();
    expect(screen.getByText('Programme owner')).toBeInTheDocument();
  });

  it('tells a partner it sees only its own customers', async () => {
    routes[`GET ${PR}`] = () =>
      jsonResponse(
        detail({
          scope: 'partner',
          can_manage: false,
          partners: [{ id: 'pa', name: 'Partner A', pods: [] }],
          customers: [{ id: 't1', name: 'Customer One', partner_id: 'pa', segment: null }],
        }),
      );
    routes[`GET ${PR}/view`] = () =>
      jsonResponse(
        view({
          scope: 'partner',
          totals: {
            customers: 1,
            bands: { 'not scanned': 1 },
            open_vendor_gaps: 0,
            open_breaks: 0,
            open_risks: 0,
          },
          customers: [
            {
              ...view().customers[0]!,
              band: null,
              score: null,
              unavailable: true,
              open_risks: 0,
            },
          ],
        }),
      );
    renderWithRouter(<Harness />);
    expect(await screen.findByText('You see only Partner A’s customers.')).toBeInTheDocument();
    expect(screen.getByText('Partner view')).toBeInTheDocument();
    expect(await screen.findByText('Not scanned: 1')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
  });
});

describe('Set-up', () => {
  beforeEach(() => {
    routes[`GET ${A}/adapters`] = () =>
      jsonResponse([
        { ref: 'fixture-source@1.0.0', title: 'Fixture source', type: 'source_adapter' },
        { ref: 'fixture-target@1.0.0', title: 'Fixture target', type: 'target_adapter' },
      ]);
    routes[`GET ${A}/blueprint-templates`] = () =>
      jsonResponse([{ id: 'bt1', name: 'standard', title: 'Standard upgrade' }]);
    routes[`GET ${A}/packs`] = () =>
      jsonResponse([
        {
          id: 'k1',
          name: 'fixture-compliance',
          version: '1.0.0',
          type: 'compliance',
          title: 'Fixture compliance',
          status: 'published',
        },
      ]);
  });

  it('checks that the weights add up to 1 live, then saves the set-up', async () => {
    let current = detail();
    routes[`GET ${PR}`] = () => jsonResponse(current);
    routes[`PUT ${PR}/setup`] = (init) => {
      const b = JSON.parse(init?.body as string) as {
        mci_config: { weights: Record<string, number> };
      };
      current = {
        ...current,
        mci: { ...current.mci, weights: b.mci_config.weights },
      };
      return jsonResponse(current);
    };
    renderWithRouter(<Harness initial={{ section: 'setup' }} />);
    const status = await screen.findByText('The weights add up to 1.000.');
    expect(status).toHaveAttribute('role', 'status');
    const tables = screen.getByRole('spinbutton', { name: 'Weight of Tables' });
    await setNumber(tables, '0.2');
    expect(
      screen.getByText(/The weights add up to 1\.100; they must add up to 1 \(remove 0\.100\)/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save set-up' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/add up to 1\.100/);
    expect(calls('PUT', `${PR}/setup`)).toBe(0);

    await setNumber(screen.getByRole('spinbutton', { name: 'Weight of Columns' }), '0');
    await setNumber(tables, '0.15');
    expect(screen.getByText('The weights add up to 1.000.')).toBeInTheDocument();
    await choose(screen.getByRole('combobox', { name: 'Source adapter' }), /Fixture source/);
    await userEvent.click(screen.getByRole('checkbox', { name: /Fixture compliance/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save set-up' }));
    await waitFor(() => expect(calls('PUT', `${PR}/setup`)).toBe(1));
    const body = bodyOf('PUT', `${PR}/setup`) as {
      source_adapter: string;
      packs: string[];
      segments: string[];
      mci_config: {
        weights: Record<string, number>;
        ranges: Record<string, number[]>;
        bands: unknown;
      };
      band_effort_weeks: unknown;
    };
    expect(body.source_adapter).toBe('fixture-source@1.0.0');
    expect(body.packs).toEqual(['fixture-compliance@1.0.0']);
    expect(body.segments).toEqual(['Region north', 'Region south']);
    expect(body.mci_config.weights.tables).toBe(0.15);
    expect(body.mci_config.weights.columns).toBe(0);
    expect(body.mci_config.ranges.tables).toEqual([50, 1500]);
    expect(body.mci_config.bands).toEqual({ simple: 35, medium: 65 });
    expect(body.band_effort_weeks).toEqual({ simple: 8, medium: 16, complex: 26 });
  });

  it('adds a pod to a partner, checking the capacity first', async () => {
    let current = detail();
    routes[`GET ${PR}`] = () => jsonResponse(current);
    routes[`POST ${PR}/partners/pb/pods`] = (init) => {
      const b = JSON.parse(init?.body as string) as { name: string; capacity: number };
      current = {
        ...current,
        partners: current.partners.map((p) =>
          p.id === 'pb' ? { ...p, pods: [{ id: 'pod2', ...b }] } : p,
        ),
      };
      return jsonResponse(current, 201);
    };
    renderWithRouter(<Harness initial={{ section: 'setup' }} />);
    const form = await screen.findByRole('form', { name: 'Add a pod to Partner B' });
    await userEvent.type(within(form).getByRole('textbox', { name: 'Pod name' }), 'Pod two');
    await setNumber(within(form).getByRole('spinbutton', { name: /Capacity/ }), '60');
    await userEvent.click(within(form).getByRole('button', { name: 'Add pod' }));
    expect(await within(form).findByText('A whole number from 1 to 50.')).toBeInTheDocument();
    expect(calls('POST', `${PR}/partners/pb/pods`)).toBe(0);
    await setNumber(within(form).getByRole('spinbutton', { name: /Capacity/ }), '3');
    await userEvent.click(within(form).getByRole('button', { name: 'Add pod' }));
    await waitFor(() =>
      expect(bodyOf('POST', `${PR}/partners/pb/pods`)).toEqual({ name: 'Pod two', capacity: 3 }),
    );
    expect(await screen.findByRole('rowheader', { name: 'Pod two' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove pod Pod two' })).toBeInTheDocument();
  });

  it('adds a programme wave', async () => {
    let current = detail();
    routes[`GET ${PR}`] = () => jsonResponse(current);
    routes[`PUT ${PR}/waves/w3`] = (init) => {
      const b = JSON.parse(init?.body as string) as { name: string; start: string; end: string };
      current = { ...current, waves: [...current.waves, { key: 'w3', ...b }] };
      return jsonResponse(current);
    };
    renderWithRouter(<Harness initial={{ section: 'setup' }} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add wave' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add wave' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Key/ }), 'w1');
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Name/ }), 'Wave three');
    fireEvent.change(within(dialog).getByLabelText(/Start/), { target: { value: '2027-08-02' } });
    fireEvent.change(within(dialog).getByLabelText(/End/), { target: { value: '2027-06-01' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add wave' }));
    expect(
      within(dialog).getByText('A wave with this key exists. Edit it instead.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('A wave ends on or after its start.')).toBeInTheDocument();
    const key = within(dialog).getByRole('textbox', { name: /Key/ });
    await userEvent.clear(key);
    await userEvent.type(key, 'w3');
    fireEvent.change(within(dialog).getByLabelText(/End/), { target: { value: '2028-01-31' } });
    expect(
      within(dialog).getByText(/26 weeks: holds simple, medium, complex customers/),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add wave' }));
    await waitFor(() =>
      expect(bodyOf('PUT', `${PR}/waves/w3`)).toEqual({
        name: 'Wave three',
        start: '2027-08-02',
        end: '2028-01-31',
      }),
    );
    const waves = await screen.findByRole('region', { name: 'Programme waves table' });
    expect(await within(waves).findByText('Wave three')).toBeInTheDocument();
  });

  it('assigns a customer to a partner and a segment', async () => {
    let current = detail();
    routes[`GET ${PR}`] = () => jsonResponse(current);
    routes[`PUT ${PR}/customers/t2`] = (init) => {
      const b = JSON.parse(init?.body as string) as { partner_id: string; segment: string };
      current = {
        ...current,
        customers: current.customers.map((c) =>
          c.id === 't2' ? { ...c, partner_id: b.partner_id, segment: b.segment } : c,
        ),
      };
      return jsonResponse(current);
    };
    renderWithRouter(<Harness initial={{ section: 'setup' }} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Assign Customer Two' }));
    const dialog = await screen.findByRole('dialog', { name: 'Assign Customer Two' });
    await choose(within(dialog).getByRole('combobox', { name: 'Partner' }), 'Partner B');
    await choose(within(dialog).getByRole('combobox', { name: 'Segment' }), 'Region south');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save assignment' }));
    await waitFor(() =>
      expect(bodyOf('PUT', `${PR}/customers/t2`)).toEqual({
        partner_id: 'pb',
        segment: 'Region south',
      }),
    );
    const table = await screen.findByRole('region', { name: 'Customer assignment' });
    const row = within(table).getByRole('row', { name: /Customer Two/ });
    expect(await within(row).findByText('Partner B')).toBeInTheDocument();
  });

  it('is read-only for someone who is not the programme owner', async () => {
    routes[`GET ${PR}`] = () => jsonResponse(detail({ can_manage: false }));
    renderWithRouter(<Harness initial={{ section: 'setup' }} />);
    expect(
      await screen.findByText(/Only the programme owner changes the set-up/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save set-up' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add wave' })).toBeNull();
    expect(screen.queryByRole('form', { name: /Add a pod/ })).toBeNull();
    expect(calls('GET', `${A}/adapters`)).toBe(0);
  });
});

describe('Fleet', () => {
  function fleet(over: Partial<Fleet> = {}): Fleet {
    return {
      customers: [
        {
          customer_id: 't1',
          customer: 'Customer One',
          segment: 'Region north',
          partner_id: 'pa',
          consent: false,
          scan: null,
        },
      ],
      segments: [],
      scope: 'programme',
      ...over,
    };
  }

  it('validates and records the customer’s consent', async () => {
    let consents: Consent[] = [];
    routes[`GET ${PR}`] = () => jsonResponse(detail());
    routes[`GET ${PR}/fleet`] = () => jsonResponse(fleet());
    routes[`GET ${A}/tenants/t1/consents`] = () => jsonResponse(consents);
    routes[`GET ${A}/tenants/t1/fleet-scans`] = () => jsonResponse([]);
    routes[`POST ${A}/tenants/t1/consents`] = () => {
      consents = [consent];
      return jsonResponse(consent, 201);
    };
    renderWithRouter(<Stateful initial={{ section: 'fleet' }} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open Customer One' }));
    expect(
      await screen.findByText('Record the customer’s consent before scanning.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start light scan' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Record consent' }));
    const dialog = await screen.findByRole('dialog', { name: /Record consent/ });
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Signatory name/ }),
      'Dana Signer',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Signatory title/ }),
      'Chief Information Officer',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /What may be read/ }),
      'Counts only',
    );
    await userEvent.type(within(dialog).getByRole('textbox', { name: /signed form/ }), 'DMS-0042');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record consent' }));
    expect(
      await within(dialog).findByText(/at least 20 characters \(11 so far\)/),
    ).toBeInTheDocument();
    expect(calls('POST', `${A}/tenants/t1/consents`)).toBe(0);
    const scope = within(dialog).getByRole('textbox', { name: /What may be read/ });
    await userEvent.clear(scope);
    await userEvent.type(scope, 'Metadata and counts of the policy administration database.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record consent' }));
    await waitFor(() =>
      expect(bodyOf('POST', `${A}/tenants/t1/consents`)).toEqual({
        signatory_name: 'Dana Signer',
        signatory_title: 'Chief Information Officer',
        scope: 'Metadata and counts of the policy administration database.',
        reference: 'DMS-0042',
      }),
    );
    expect(await screen.findByText('Dana Signer, Chief Information Officer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start light scan' })).toBeEnabled();
  });

  it('revokes a consent with a reason of at least 10 characters', async () => {
    routes[`GET ${PR}`] = () => jsonResponse(detail());
    routes[`GET ${PR}/fleet`] = () => jsonResponse(fleet());
    routes[`GET ${A}/tenants/t1/consents`] = () => jsonResponse([consent]);
    routes[`GET ${A}/tenants/t1/fleet-scans`] = () => jsonResponse([]);
    routes[`POST ${A}/consents/c1/revoke`] = () =>
      jsonResponse({ ...consent, active: false, revoke_reason: 'Customer withdrew it.' });
    renderWithRouter(<Harness initial={{ section: 'fleet', customer: 't1' }} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke consent' }));
    const dialog = await screen.findByRole('dialog', { name: /Revoke consent/ });
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Withdrawn');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke consent' }));
    expect(await within(dialog).findByText(/at least 10 characters/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Reason/ }), ' by email.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke consent' }));
    await waitFor(() =>
      expect(bodyOf('POST', `${A}/consents/c1/revoke`)).toEqual({
        reason: 'Withdrawn by email.',
      }),
    );
  });

  it('starts a light scan through a source connection and shows the index breakdown', async () => {
    let scans: FleetScan[] = [];
    routes[`GET ${PR}`] = () => jsonResponse(detail());
    routes[`GET ${PR}/fleet`] = () =>
      jsonResponse(
        fleet({
          customers: [{ ...fleet().customers[0]!, consent: true, scan: scans[0] ?? null }],
          segments: scans.length
            ? [
                {
                  segment: 'Region north',
                  customers: 1,
                  mean_score: 42.5,
                  band: 'medium',
                  bands: { simple: 0, medium: 1, complex: 0 },
                },
              ]
            : [],
        }),
      );
    routes[`GET ${A}/tenants/t1/consents`] = () => jsonResponse([consent]);
    routes[`GET ${A}/tenants/t1/fleet-scans`] = () => jsonResponse(scans);
    routes[`GET ${A}/tenants/t1/source-connections`] = () =>
      jsonResponse([
        {
          id: 'sc1',
          name: 'Legacy prod',
          adapter: 'fixture-source',
          engine: 'sqlserver',
          last_check: { status: 'succeeded' },
        },
        {
          id: 'sc2',
          name: 'Legacy test',
          adapter: 'fixture-source',
          engine: 'sqlserver',
          last_check: null,
        },
      ]);
    routes[`POST ${A}/tenants/t1/fleet-scans`] = () => {
      scans = [scan()];
      return jsonResponse(scan({ status: 'queued', mci: null, measures: {} }), 201);
    };
    renderWithRouter(<Harness initial={{ section: 'fleet', customer: 't1' }} />);
    const start = await screen.findByRole('button', { name: 'Start light scan' });
    await waitFor(() => expect(start).toBeEnabled());
    expect(screen.getByText(/Reads metadata and counts only/)).toBeInTheDocument();
    await userEvent.click(start);
    const dialog = await screen.findByRole('dialog', { name: /Start light scan/ });
    expect(within(dialog).getByText(/never reads business values/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start light scan' }));
    expect(await within(dialog).findByText('Choose a source connection.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('combobox', { name: /Source connection/ }));
    expect(
      await screen.findByRole('option', { name: /Legacy test.*not checked/ }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: /Legacy prod/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start light scan' }));
    await waitFor(() =>
      expect(bodyOf('POST', `${A}/tenants/t1/fleet-scans`)).toEqual({ connection_id: 'sc1' }),
    );
    const breakdown = await screen.findByRole('region', { name: 'Index breakdown' });
    const tablesRow = within(breakdown).getByRole('row', { name: /^Tables/ });
    const cells = within(tablesRow)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(cells).toEqual(['775', '50–1,500', '0.5', '0.1', '5']);
    expect(screen.getByText(/Score = 100 × Σ weight × clamp/)).toBeInTheDocument();
    expect(rowCells(breakdown, 'Score')).toEqual(['42.5']);
    expect(screen.getByRole('rowheader', { name: 'Rows' })).toBeInTheDocument();
    const segs = await screen.findByRole('region', { name: 'Segment summary' });
    expect(rowCells(segs, 'Region north')).toEqual(['1', '42.5', 'Medium', '0', '1', '0']);
  });
});

describe('Portfolio', () => {
  const plan: PortfolioPlan = {
    number: 3,
    status: 'optimal',
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
    conflicts: [
      { customer_id: 't2', customer: 'Customer Two', reason: 'No partner is assigned.' },
      {
        customer_id: 't3',
        customer: 'Customer Three',
        band: 'complex',
        reason: 'No wave is long enough for a complex customer (26 weeks).',
      },
    ],
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

  it('runs the planner and shows assignments, conflicts and the pod rotation', async () => {
    let latest: PortfolioPlan | null = null;
    routes[`GET ${PR}`] = () => jsonResponse(detail());
    routes[`GET ${PR}/portfolio-plans/latest`] = () =>
      latest ? jsonResponse(latest) : problem(404, 'Portfolio plan not found');
    routes[`POST ${PR}/portfolio-plans`] = () => {
      latest = { ...plan, created_at: '2026-11-19T08:00:00Z' };
      return jsonResponse(plan, 201);
    };
    renderWithRouter(<Harness initial={{ section: 'portfolio' }} />);
    expect(await screen.findByText('No plan yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run planner' }));
    await waitFor(() => expect(calls('POST', `${PR}/portfolio-plans`)).toBe(1));
    expect(await screen.findByText('Plan 3')).toBeInTheDocument();
    expect(screen.getByText('1 placed · 2 conflict(s)')).toBeInTheDocument();

    const conflicts = screen.getByRole('list', { name: 'Conflicts' });
    expect(within(conflicts).getByText('No partner is assigned.')).toBeInTheDocument();
    expect(within(conflicts).getByText(/No wave is long enough/)).toBeInTheDocument();

    const w1 = screen.getByRole('region', { name: 'Assignments in wave w1' });
    expect(rowCells(w1, 'Customer One')).toEqual(['Simple', '8', 'Pod one', 'Partner A']);
    expect(screen.getByText('No customers in this wave.')).toBeInTheDocument();

    const rotation = screen.getByRole('region', { name: 'Pod rotation table' });
    const table = within(rotation).getByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual(['Pod', 'Wave one', 'Wave two']);
    const row = within(table).getByRole('row', { name: /Pod one/ });
    const cells = within(row)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(cells).toEqual(['Customer One1 of 2', 'Free']);
  });

  it('explains why someone else cannot run the planner', async () => {
    routes[`GET ${PR}`] = () => jsonResponse(detail({ can_manage: false }));
    routes[`GET ${PR}/portfolio-plans/latest`] = () => jsonResponse(plan);
    renderWithRouter(<Harness initial={{ section: 'portfolio' }} />);
    const run = await screen.findByRole('button', { name: 'Run planner' });
    expect(run).toBeDisabled();
    expect(run).toHaveAccessibleDescription('Only the programme owner runs the planner.');
    expect(await screen.findByText('Plan 3')).toBeInTheDocument();
  });
});

describe('Metering', () => {
  const metering: Metering = {
    customers: [
      {
        customer_id: 't1',
        customer: 'Customer One',
        segment: 'Region north',
        partner_id: 'pa',
        band: 'medium',
        score: 42.5,
        gates_passed: 3,
        effort_hours: 120,
        elapsed_days: 45,
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
        approvers: 'Alex Lead (migration_lead); Dana Owner (customer_data_owner)',
        checklist_digest: 'abcdef0123456789'.repeat(4),
        band: 'medium',
      },
    ],
    segment_waves: [
      {
        segment: 'Region north',
        wave: 'w1',
        customers: 1,
        effort_hours: 120,
        hours_per_customer: 120,
        hours_per_score_point: 2.82,
      },
    ],
    plan_number: 3,
  };

  it('shows effort and gate evidence and downloads the CSV', async () => {
    routes[`GET ${PR}`] = () => jsonResponse(detail());
    routes[`GET ${PR}/metering`] = (_init, url) =>
      url.searchParams.get('format') === 'csv'
        ? new Response('customer,segment\r\nCustomer One,Region north\r\n', {
            status: 200,
            headers: {
              'Content-Type': 'text/csv',
              'Content-Disposition': 'attachment; filename="gate-evidence-p1.csv"',
            },
          })
        : jsonResponse(metering);
    const create = vi.fn(() => 'blob:fixture');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    renderWithRouter(<Harness initial={{ section: 'metering' }} />);
    const perCustomer = await screen.findByRole('region', { name: 'Metering per customer' });
    expect(rowCells(perCustomer, 'Customer One')).toEqual([
      'Region north',
      'Medium42.5',
      '3',
      '120',
      '45',
      'w1',
    ]);
    const compare = screen.getByRole('region', { name: 'Effort by segment and wave table' });
    expect(rowCells(compare, 'Region north')).toEqual(['w1', '1', '120', '120', '2.82']);
    const evidence = screen.getByRole('region', { name: 'Gate evidence table' });
    expect(within(evidence).getByText(/Alex Lead \(migration_lead\)/)).toBeInTheDocument();
    expect(within(evidence).getByText('abcdef012345…')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Export gate evidence (CSV)' }));
    await waitFor(() => expect(names).toEqual(['gate-evidence-p1.csv']));
    expect(create).toHaveBeenCalledTimes(1);
    const csvCall = fetchMock.mock.calls.find(([input]) =>
      (input as string).includes('format=csv'),
    );
    expect(csvCall?.[0]).toBe(`${PR}/metering?format=csv`);
  });
});
