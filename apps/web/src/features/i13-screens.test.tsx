import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Release,
  ReleaseDetail,
  ReleaseEvaluation,
  ReleaseList,
  SuiteScore,
} from '@/api/releases-types';
import { jsonResponse, renderWithRouter } from '@/test/utils';
import {
  compareScorecards,
  formatDelta,
  formatScore,
  groupByArea,
  MEASURE_DESCRIPTIONS,
  releaseErrors,
  splitMeasure,
} from './releases/model';
import { ReleasesPage } from './releases/ReleasesPage';

// Test fixtures only: shapes follow /api/v1 (I13 release gate, api/routes/releases.py and
// evaluation/engine.py); names and values are synthetic.
const fetchMock = vi.fn<typeof fetch>();
type Handler = (init: RequestInit | undefined, url: URL) => Response;
let routes: Record<string, Handler> = {};

function meWith(permissions: string[]): Handler {
  return () =>
    jsonResponse({
      id: '00000000-0000-4000-8000-000000000001',
      email: 'fixture.user@example.test',
      display_name: 'Fixture User',
      mfa: true,
      roles: [],
      permissions,
    });
}

beforeEach(() => {
  routes = { '/api/v1/me': meWith(['tenant:read', 'golden:run']) };
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

function calls(method: string, path: string): number {
  return fetchMock.mock.calls.filter(
    ([input, init]) =>
      (init?.method ?? 'GET') === method &&
      new URL(typeof input === 'string' ? input : (input as Request).url, 'http://localhost')
        .pathname === path,
  ).length;
}

function bodyOf(method: string, path: string): unknown {
  const call = fetchMock.mock.calls.find(
    ([input, init]) =>
      init?.method === method &&
      new URL(typeof input === 'string' ? input : (input as Request).url, 'http://localhost')
        .pathname === path,
  );
  const body = call?.[1]?.body;
  return typeof body === 'string' ? (JSON.parse(body) as unknown) : undefined;
}

function problem(status: number, title: string, detail?: string): Response {
  return jsonResponse(
    { type: `/problems/${String(status)}`, title, status, ...(detail ? { detail } : {}) },
    status,
    'application/problem+json',
  );
}

const ENGINE = 'e'.repeat(64);
const SUITE_DIGEST = 'd'.repeat(64);

function measures(over: Record<string, number> = {}): Record<string, number> {
  return {
    ...Object.fromEntries(Object.keys(MEASURE_DESCRIPTIONS).map((k) => [k, 1])),
    'mapping.top1_accuracy': 0.8667,
    ...over,
  };
}

function suites(over: Record<string, number> = {}): Record<string, SuiteScore> {
  return { 'fixture-suite': { digest: SUITE_DIGEST, measures: measures(over) } };
}

const r1: Release = {
  id: 'r1',
  name: 'R1-fixture',
  status: 'released',
  baseline_release: null,
  regressions: [],
  improved: [],
  reason: 'First release scorecard for the fixture.',
  recorded_by: 'Fixture User',
  created_at: '2026-11-18T09:00:00Z',
  engine_digest: ENGINE,
};

const fellTop1 = {
  suite: 'fixture-suite',
  measure: 'mapping.top1_accuracy',
  baseline: 0.8667,
  current: 0.8,
  detail: 'fell from 0.8667 to 0.8',
};

const r2: Release = {
  id: 'r2',
  name: 'R2-fixture',
  status: 'blocked',
  baseline_release: 'R1-fixture',
  regressions: [fellTop1],
  improved: [
    { suite: 'fixture-suite', measure: 'review.order_agreement', baseline: 0.9, current: 1 },
  ],
  reason: 'Second release attempt for the fixture.',
  recorded_by: 'Fixture Lead',
  created_at: '2026-11-19T09:00:00Z',
  engine_digest: ENGINE,
};

const r1Detail: ReleaseDetail = { ...r1, suites: suites() };
const r2Detail: ReleaseDetail = { ...r2, suites: suites({ 'mapping.top1_accuracy': 0.8 }) };

function list(over: Partial<ReleaseList> = {}): ReleaseList {
  return { releases: [r2, r1], can_record: true, ...over };
}

function evaluation(over: Partial<ReleaseEvaluation> = {}): ReleaseEvaluation {
  return {
    baseline_release: 'R1-fixture',
    passed: true,
    regressions: [],
    improved: [],
    changed_suites: [],
    suites: suites(),
    engine_digest: ENGINE,
    ...over,
  };
}

function rowCells(container: HTMLElement, header: string | RegExp): string[] {
  const th = within(container).getByRole('rowheader', { name: header });
  const tr = th.closest('tr');
  return tr ? [...tr.querySelectorAll('td')].map((td) => td.textContent) : [];
}

describe('model', () => {
  it('splits and groups measures by area in document order', () => {
    expect(splitMeasure('mapping.top1_accuracy')).toEqual({
      area: 'mapping',
      measure: 'top1_accuracy',
    });
    expect(splitMeasure('plain')).toEqual({ area: 'other', measure: 'plain' });
    const groups = groupByArea(
      ['review.order_agreement', 'zeta.x', 'mapping.b', 'mapping.a', 'code.c'],
      (n) => n,
    );
    expect(groups.map((g) => g.area.label)).toEqual(['Mapping', 'Code', 'Review', 'Zeta']);
    expect(groups[0]?.items).toEqual(['mapping.a', 'mapping.b']);
  });

  it('formats scores and changes', () => {
    expect(formatScore(0.8667)).toBe('0.867');
    expect(formatScore(null)).toBe('—');
    expect(formatDelta(0.8667, 0.8)).toBe('−0.067');
    expect(formatDelta(0.9, 1)).toBe('+0.100');
    expect(formatDelta(1, 1)).toBe('0.000');
  });

  it('validates the release name and reason as the API does', () => {
    expect(releaseErrors({ name: '', reason: '' })).toEqual({
      name: 'Give the release a name.',
      reason: 'Give a reason. It is recorded in the audit log.',
    });
    expect(releaseErrors({ name: 'R', reason: 'short' }).name).toMatch(/2–60 characters/);
    expect(releaseErrors({ name: 'R', reason: 'short' }).reason).toMatch(/at least 10/);
    expect(releaseErrors({ name: '-R2', reason: 'A reason long enough' }).name).toMatch(
      /Start with a letter or digit/,
    );
    expect(releaseErrors({ name: 'R 2', reason: 'A reason long enough' }).name).toMatch(
      /letters, digits/,
    );
    expect(releaseErrors({ name: 'x'.repeat(61), reason: 'A reason long enough' }).name).toMatch(
      /2–60/,
    );
    expect(releaseErrors({ name: 'R2.1_rc-1', reason: 'A reason long enough' })).toEqual({});
  });

  it('compares with the baseline scorecard, the server deciding what fell', () => {
    const e = evaluation({
      passed: false,
      regressions: [
        fellTop1,
        {
          suite: 'fixture-suite',
          measure: 'code.conversion_accuracy',
          baseline: 1,
          current: null,
          detail: 'The measure is no longer produced.',
        },
        {
          suite: 'gone-suite',
          measure: null,
          baseline: null,
          current: null,
          detail: 'The suite is missing.',
        },
      ],
      improved: [
        { suite: 'fixture-suite', measure: 'review.order_agreement', baseline: 0.9, current: 1 },
      ],
      changed_suites: ['fixture-suite'],
      suites: suites({ 'mapping.top1_accuracy': 0.8, 'planning.new_measure': 1 }),
    });
    delete e.suites['fixture-suite']?.measures['code.conversion_accuracy'];
    const base = {
      ...suites({ 'review.order_agreement': 0.9 }),
      'gone-suite': { digest: 'g', measures: { 'mapping.top1_accuracy': 1 } },
    };
    const [fixture, gone] = compareScorecards(e, base);
    expect(fixture?.changed).toBe(true);
    const kinds = Object.fromEntries((fixture?.rows ?? []).map((r) => [r.measure, r.kind]));
    expect(kinds['mapping.top1_accuracy']).toBe('fell');
    expect(kinds['code.conversion_accuracy']).toBe('missing');
    expect(kinds['review.order_agreement']).toBe('improved');
    expect(kinds['planning.new_measure']).toBe('new');
    expect(kinds['mapping.review_recall']).toBe('same');
    expect(gone?.missing).toBe(true);
  });

  it('without the baseline scorecard, takes baseline values from what changed only', () => {
    const e = evaluation({
      passed: false,
      regressions: [fellTop1],
      suites: suites({ 'mapping.top1_accuracy': 0.8 }),
    });
    const rows = compareScorecards(e, null)[0]?.rows ?? [];
    expect(rows.find((r) => r.measure === 'mapping.top1_accuracy')?.baseline).toBe(0.8667);
    expect(rows.find((r) => r.measure === 'mapping.review_recall')).toMatchObject({
      baseline: null,
      kind: 'same',
    });
  });
});

describe('Releases page', () => {
  it('lists the release history with status, counts and who recorded it', async () => {
    routes[`${A}/releases`] = () => jsonResponse(list());
    renderWithRouter(<ReleasesPage />);
    const table = await screen.findByRole('table', { name: 'Release history' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    const blocked = rows[1]!;
    expect(within(blocked).getByText('R2-fixture')).toBeInTheDocument();
    expect(within(blocked).getByText('Blocked')).toBeInTheDocument();
    expect(within(blocked).getByText('R1-fixture')).toBeInTheDocument();
    expect(within(blocked).getByText('Fixture Lead')).toBeInTheDocument();
    expect(
      within(blocked).getByText('Second release attempt for the fixture.'),
    ).toBeInTheDocument();
    const cells = within(blocked)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(cells.slice(3, 5)).toEqual(['1', '1']);
    const first = rows[2]!;
    expect(within(first).getByText('Released')).toBeInTheDocument();
    expect(within(first).getByText('First release')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record release' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Check now' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: 'How the release gate works' })).toBeInTheDocument();
    expect(screen.getByText(/python -m astra_migrate.evaluation gate/)).toBeInTheDocument();
    expect(screen.getByText(/python -m astra_migrate.evaluation record/)).toBeInTheDocument();
    expect(calls('GET', `${A}/releases/evaluation`)).toBe(0);
  });

  it('opens a release: regressions, improvements and the scorecard by area', async () => {
    routes[`${A}/releases`] = () => jsonResponse(list());
    routes[`${A}/releases/r2`] = () => jsonResponse(r2Detail);
    renderWithRouter(<ReleasesPage />);
    const table = await screen.findByRole('table', { name: 'Release history' });
    await userEvent.click(within(table).getByText('R2-fixture'));
    const heading = await screen.findByRole('heading', { name: 'Release R2-fixture' });
    await waitFor(() => expect(heading.querySelector('[tabindex="-1"]')).toHaveFocus());

    const regressions = screen.getByRole('region', { name: 'Regressions of release R2-fixture' });
    expect(rowCells(regressions, 'fixture-suite')).toEqual([
      'mapping.top1_accuracy',
      '0.867',
      '0.800',
      'fell from 0.8667 to 0.8',
    ]);
    const improved = screen.getByRole('region', { name: 'Improvements of release R2-fixture' });
    expect(rowCells(improved, 'fixture-suite')).toEqual([
      'review.order_agreement',
      '0.900',
      '1.000',
      '+0.100',
    ]);

    const card = screen.getByRole('region', { name: 'Measures of suite fixture-suite' });
    const areas = within(card)
      .getAllByRole('columnheader')
      .filter((h) => h.getAttribute('scope') === 'colgroup')
      .map((h) => h.firstChild?.textContent);
    expect(areas).toEqual(['Mapping', 'Configuration', 'Code', 'Planning', 'Compliance', 'Review']);
    expect(rowCells(card, /top1_accuracy/)).toEqual([
      '0.800',
      'The first mapping proposed for a column is the expected target.',
    ]);
    expect(within(card).getByRole('rowheader', { name: /top1_accuracy/ })).toHaveTextContent(
      'Fell',
    );
    expect(rowCells(card, /review_recall/)).toEqual(['1.000', 'Wrong proposals go to review.']);

    const digest = screen.getAllByTitle(ENGINE)[0]!;
    expect(digest).toHaveTextContent(`${'e'.repeat(12)}…`);
    expect(screen.getAllByRole('button', { name: 'Copy engine digest' })).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: 'Copy digest of suite fixture-suite' }),
    ).toBeInTheDocument();
  });

  it('checks now: would pass, with baseline and now side by side', async () => {
    routes[`${A}/releases`] = () => jsonResponse(list());
    routes[`${A}/releases/r1`] = () => jsonResponse(r1Detail);
    routes[`${A}/releases/evaluation`] = () =>
      jsonResponse(
        evaluation({
          improved: [
            {
              suite: 'fixture-suite',
              measure: 'mapping.top1_accuracy',
              baseline: 0.8667,
              current: 0.9333,
            },
          ],
          suites: suites({ 'mapping.top1_accuracy': 0.9333 }),
        }),
      );
    renderWithRouter(<ReleasesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    const status = await screen.findByText('Would be released');
    expect(status.closest('[role="status"]')).toHaveTextContent(
      'No measure fell below R1-fixture. 1 measure(s) improved.',
    );
    const compare = await screen.findByRole('region', {
      name: 'Baseline and now for suite fixture-suite',
    });
    expect(
      within(compare).getByRole('columnheader', { name: 'Baseline (R1-fixture)' }),
    ).toBeVisible();
    expect(rowCells(compare, /top1_accuracy/).slice(0, 4)).toEqual([
      '0.867',
      '0.933',
      '+0.067',
      'Improved',
    ]);
    expect(rowCells(compare, /review_recall/).slice(0, 4)).toEqual([
      '1.000',
      '1.000',
      '0.000',
      'Unchanged',
    ]);
    expect(screen.queryByRole('region', { name: 'Regressions found now' })).toBeNull();
    expect(calls('POST', `${A}/releases`)).toBe(0);
  });

  it('checks now: would be blocked, the regression highlighted', async () => {
    routes[`${A}/releases`] = () => jsonResponse(list());
    routes[`${A}/releases/r1`] = () => jsonResponse(r1Detail);
    routes[`${A}/releases/evaluation`] = () =>
      jsonResponse(
        evaluation({
          passed: false,
          regressions: [fellTop1],
          changed_suites: ['fixture-suite'],
          suites: suites({ 'mapping.top1_accuracy': 0.8 }),
        }),
      );
    renderWithRouter(<ReleasesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    const title = await screen.findByText('Would be blocked');
    expect(title.closest('[role="status"]')).toHaveTextContent(
      '1 regression(s) against R1-fixture',
    );
    const found = screen.getByRole('region', { name: 'Regressions found now' });
    expect(rowCells(found, 'fixture-suite')[0]).toBe('mapping.top1_accuracy');
    const compare = await screen.findByRole('region', {
      name: 'Baseline and now for suite fixture-suite',
    });
    expect(rowCells(compare, /top1_accuracy/).slice(0, 4)).toEqual([
      '0.867',
      '0.800',
      '−0.067',
      'Fell',
    ]);
    expect(screen.getByText('Suite changed since baseline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
  });

  it('records a release: validates first, then shows the blocked result in a live region', async () => {
    let recorded = false;
    const r3: ReleaseDetail = {
      ...r2Detail,
      id: 'r3',
      name: 'R3-fixture',
      reason: 'Third release for the fixture.',
      improved: [],
    };
    routes[`${A}/releases`] = () =>
      jsonResponse(list({ releases: recorded ? [r3, r2, r1] : [r2, r1] }));
    routes[`POST ${A}/releases`] = () => {
      recorded = true;
      return jsonResponse(r3, 201);
    };
    renderWithRouter(<ReleasesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Record release' }));
    const dialog = await screen.findByRole('dialog', { name: 'Record release' });
    expect(
      within(dialog).getByText('A release with any fallen measure is recorded as Blocked'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/It is compared with R1-fixture/)).toBeInTheDocument();

    const submit = within(dialog).getByRole('button', { name: 'Evaluate and record' });
    await userEvent.click(submit);
    expect(within(dialog).getByText('Give the release a name.')).toBeInTheDocument();
    expect(
      within(dialog).getByText('Give a reason. It is recorded in the audit log.'),
    ).toBeInTheDocument();

    const name = within(dialog).getByRole('textbox', { name: /Release name/ });
    const reason = within(dialog).getByRole('textbox', { name: /Reason/ });
    await userEvent.type(name, 'R3 fixture');
    await userEvent.type(reason, 'Too short');
    await userEvent.click(submit);
    expect(name).toHaveAccessibleDescription(/Start with a letter or digit/);
    expect(reason).toHaveAccessibleDescription(/at least 10 characters \(9 so far\)/);
    expect(calls('POST', `${A}/releases`)).toBe(0);

    await userEvent.clear(name);
    await userEvent.type(name, 'R3-fixture');
    await userEvent.clear(reason);
    await userEvent.type(reason, 'Third release for the fixture.');
    await userEvent.click(submit);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bodyOf('POST', `${A}/releases`)).toEqual({
      name: 'R3-fixture',
      reason: 'Third release for the fixture.',
    });
    const result = screen.getByText('R3-fixture blocked').closest('[role="status"]');
    expect(result).toHaveTextContent('1 regression(s) against R1-fixture');
    expect(result).toHaveTextContent(
      'fixture-suite · mapping.top1_accuracy: fell from 0.8667 to 0.8',
    );
    expect(result).toHaveTextContent('R1-fixture stays the baseline');
    expect(await screen.findByRole('heading', { name: 'Release R3-fixture' })).toBeInTheDocument();
    expect(
      await within(await screen.findByRole('table', { name: 'Release history' })).findByText(
        'R3-fixture',
      ),
    ).toBeInTheDocument();
  });

  it('shows a refused release name from the server', async () => {
    routes[`${A}/releases`] = () => jsonResponse(list());
    routes[`POST ${A}/releases`] = () => problem(409, 'This release name is already released');
    renderWithRouter(<ReleasesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Record release' }));
    const dialog = await screen.findByRole('dialog', { name: 'Record release' });
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Release name/ }),
      'R1-fixture',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      'Trying the same name again.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Evaluate and record' }));
    expect(
      await within(dialog).findByText('This release name is already released'),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('without the golden run permission, the actions are disabled with the reason', async () => {
    routes['/api/v1/me'] = meWith(['tenant:read']);
    routes[`${A}/releases`] = () => jsonResponse(list({ can_record: false }));
    renderWithRouter(<ReleasesPage />);
    const record = await screen.findByRole('button', { name: 'Record release' });
    expect(record).toBeDisabled();
    expect(record).toHaveAccessibleDescription(
      'Only people with the golden run permission on the platform can do this.',
    );
    const check = screen.getByRole('button', { name: 'Check now' });
    expect(check).toBeDisabled();
    expect(check).toHaveAccessibleDescription(/golden run permission/);
    expect(calls('GET', `${A}/releases/evaluation`)).toBe(0);
  });

  it('shows permission denied when the API refuses the list (403)', async () => {
    routes[`${A}/releases`] = () =>
      problem(403, 'Permission denied', 'You do not have permission to do this.');
    renderWithRouter(<ReleasesPage />);
    expect(
      await screen.findByRole('heading', { name: "You don't have permission to view this" }),
    ).toBeInTheDocument();
    expect(screen.getByText('You do not have permission to do this.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record release' })).toBeNull();
  });

  it('shows permission denied when check now is refused (403)', async () => {
    routes[`${A}/releases`] = () => jsonResponse(list());
    routes[`${A}/releases/evaluation`] = () =>
      problem(403, 'Permission denied', 'You cannot run the release evaluation.');
    renderWithRouter(<ReleasesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('You cannot run the release evaluation.')).toBeInTheDocument();
  });

  it('does not call the API without a permission that can read releases', async () => {
    routes['/api/v1/me'] = meWith(['observability:read']);
    renderWithRouter(<ReleasesPage />);
    expect(
      await screen.findByRole('heading', { name: "You don't have permission to view this page" }),
    ).toBeInTheDocument();
    expect(calls('GET', `${A}/releases`)).toBe(0);
  });
});
