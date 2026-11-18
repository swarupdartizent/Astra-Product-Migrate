import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdapterRun,
  AdapterRunDetail,
  AdapterTrap,
  ConceptPrecedents,
  ConceptDetail,
  ConceptFind,
  Job,
  Me,
} from '@/api/types';
import { jsonResponse, renderWithProviders, renderWithRouter } from '@/test/utils';
import { TrapsPanel } from './adapters/TrapsPanel';
import {
  checkSummary,
  countsMismatch,
  isBlockedMessage,
  loadBlockedReason,
  orderDocuments,
  parseDefinition,
  trapFieldLabel,
  WRITABLE_ACCOUNT,
} from './adapters/model';
import { Scorecard } from './golden/GoldenPage';
import { formatRatio, orderMeasures, parseDataset } from './golden/model';
import { ConceptPage } from './ontology/ConceptPage';
import { OntologyPage } from './ontology/OntologyPage';
import { namespaceOf, parsePacksParam } from './ontology/tabs';
import { AdapterRunPage } from './sources/AdapterRunPage';
import { validateConnection } from './sources/model';
import { LoadJob } from './sources/TargetsTab';

// Test fixtures only: shapes follow /api/v1; values are synthetic.
const fetchMock = vi.fn<typeof fetch>();
let routes: Record<string, (init?: RequestInit) => Response> = {};

function me(permissions: string[]): Me {
  return {
    id: 'u1',
    email: 'fixture@example.test',
    display_name: 'Fixture User',
    mfa: true,
    roles: [],
    permissions,
  };
}

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

function run(over: Partial<AdapterRun>): AdapterRun {
  return {
    id: 'r1',
    connection_id: 'c1',
    kind: 'check',
    mode: null,
    adapter: 'fixture-source@1.0.0',
    status: 'succeeded',
    status_detail: null,
    summary: {},
    job_id: null,
    requested_by: 'Fixture User',
    created_at: '2026-11-18T10:00:00Z',
    finished_at: '2026-11-18T10:00:05Z',
    ...over,
  };
}

describe('adapter model', () => {
  it('reads a load config with no endpoints as Blocked', () => {
    const base = {
      method: 'rest_api',
      auth: 'oauth2_client_credentials',
      scopes: [],
      rate_limit: {
        requests_per_minute: 60,
        burst: 5,
        source: { reference: 'Fixture source' },
        recorded_on: '2026-11-01',
      },
      approved_tools: [],
    };
    expect(loadBlockedReason({ ...base, token_path: null, endpoints: [] })).toMatch(
      /^Loads are Blocked: the target's API endpoints are not yet recorded/,
    );
    expect(
      loadBlockedReason({
        ...base,
        token_path: '/token',
        endpoints: [{ entity: 'party', method: 'POST', path: '/parties', batch_size: 50 }],
      }),
    ).toBeNull();
  });

  it('reads a check summary and keeps read_only exactly', () => {
    const chk = checkSummary(
      run({ summary: { ok: false, engine: 'sqlserver', read_only: false, problems: ['x'] } }),
    );
    expect(chk?.read_only).toBe(false);
    expect(chk?.problems).toEqual(['x']);
    expect(checkSummary(run({ kind: 'harvest', summary: { read_only: true } }))).toBeNull();
  });

  it('puts broken document links first and flags count mismatches', () => {
    const doc = (k: string, ok: boolean) => ({
      doc_key: k,
      name: k,
      link_type: null,
      link_entity: null,
      link_key: null,
      link_resolved: ok,
      size_bytes: null,
      sha256: null,
    });
    expect(orderDocuments([doc('a', true), doc('b', false)]).map((d) => d.doc_key)).toEqual([
      'b',
      'a',
    ]);
    const c = { entity: 'e', mode: 'full', watermark: null };
    expect(countsMismatch({ ...c, source_count: 10, extracted: 9 })).toBe(true);
    expect(countsMismatch({ ...c, source_count: 10, extracted: 10 })).toBe(false);
    expect(countsMismatch({ ...c, source_count: null, extracted: 3 })).toBe(false);
  });

  it('recognises Blocked messages, YAML/JSON trap definitions and field paths', () => {
    expect(isBlockedMessage('Blocked: no endpoints')).toBe(true);
    expect(isBlockedMessage('Failed: timeout')).toBe(false);
    expect(isBlockedMessage(null)).toBe(false);
    expect(parseDefinition('id: A\ntitle: B')).toEqual({ value: { id: 'A', title: 'B' } });
    expect(parseDefinition('{"id": "A"}')).toEqual({ value: { id: 'A' } });
    expect(parseDefinition('- a\n- b')).toHaveProperty('error');
    expect(parseDefinition('id: [')).toHaveProperty('error');
    expect(trapFieldLabel('trap.detect.queries.sqlserver')).toBe('detect › queries › sqlserver');
    expect(trapFieldLabel('trap')).toBe('trap');
  });
});

describe('golden and ontology helpers', () => {
  it('parses dataset refs and orders failing measures first', () => {
    expect(parseDataset('fixture-source@1.2.3:small')).toEqual({
      adapter: 'fixture-source',
      version: '1.2.3',
      name: 'small',
    });
    expect(parseDataset('nonsense')).toBeNull();
    const m = (name: string, passed: boolean) => ({
      name,
      passed,
      expected: 1,
      actual: 1,
      precision: null,
      recall: null,
      detail: '',
    });
    expect(orderMeasures([m('a', true), m('b', false)]).map((x) => x.name)).toEqual(['b', 'a']);
    expect(formatRatio(null)).toBe('—');
    expect(formatRatio(1)).toBe('100%');
    expect(formatRatio(0.5)).toBe('50.0%');
  });

  it('reads pack scope and namespaces', () => {
    expect(parsePacksParam('a@1.0.0,b@2.0.0')).toEqual(['a@1.0.0', 'b@2.0.0']);
    expect(parsePacksParam(undefined)).toEqual([]);
    expect(namespaceOf('ns.concept')).toBe('ns');
    expect(namespaceOf('flat')).toBe('flat');
  });

  it('validates a source connection on the client', () => {
    const errors = validateConnection({
      name: 'Bad Name',
      adapter: '',
      engine: '',
      host: '',
      port: '99999',
      database: '',
      username: '',
      password_ref: 'plain',
      encrypt: true,
    });
    expect(Object.keys(errors).sort()).toEqual(
      ['adapter', 'database', 'engine', 'host', 'name', 'password_ref', 'port', 'username'].sort(),
    );
  });
});

describe('AdapterRunPage', () => {
  it('says plainly when the account can write to the source', async () => {
    const detail: AdapterRunDetail = {
      run: run({
        status: 'failed',
        status_detail: 'The connection check found problems.',
        summary: {
          ok: false,
          engine: 'sqlserver',
          engine_version: '16.0',
          edition: 'Developer',
          database: 'fixture_db',
          login: 'fixture_login',
          read_only: false,
          read_only_evidence: ['member of db_datawriter'],
          supported: true,
          problems: ['The login can write.'],
        },
      }),
    };
    routes['/api/v1/adapter-runs/r1'] = () => jsonResponse(detail);
    renderWithRouter(<AdapterRunPage runId="r1" />);
    expect(await screen.findByText(WRITABLE_ACCOUNT)).toBeInTheDocument();
    expect(screen.getByText('The login can write.')).toBeInTheDocument();
    expect(screen.getByText(/member of db_datawriter/)).toBeInTheDocument();
  });

  it('shows the harvest coverage table with failures and missing code', async () => {
    const detail: AdapterRunDetail = {
      run: run({
        kind: 'harvest',
        summary: {
          objects: 12,
          objects_by_type: { table: 10, procedure: 2 },
          coverage_complete: false,
        },
      }),
      coverage: [
        {
          object_type: 'table',
          label: 'Tables',
          required: true,
          status: 'complete',
          count: 10,
          error: null,
          dependencies: null,
          code_missing: null,
        },
        {
          object_type: 'procedure',
          label: 'Procedures',
          required: true,
          status: 'failed',
          count: 2,
          error: 'Permission denied on the catalogue view.',
          dependencies: 0,
          code_missing: 2,
        },
      ],
      traps: [],
    };
    routes['/api/v1/adapter-runs/r1'] = () => jsonResponse(detail);
    routes['/api/v1/adapter-runs/r1/objects'] = () =>
      jsonResponse({ total: 0, offset: 0, items: [] });
    renderWithRouter(<AdapterRunPage runId="r1" />);
    const table = await screen.findByRole('table', { name: /Coverage by object type/ });
    expect(table).toHaveTextContent('Procedures');
    expect(table).toHaveTextContent('Permission denied on the catalogue view.');
    expect(screen.getAllByText(/incomplete/i).length).toBeGreaterThan(0);
  });

  it('shows a blocked run with the API reason', async () => {
    routes['/api/v1/adapter-runs/r1'] = () =>
      jsonResponse({
        run: run({
          kind: 'extract',
          status: 'blocked',
          status_detail: 'Run a passing connection check first.',
        }),
      });
    renderWithRouter(<AdapterRunPage runId="r1" />);
    expect(await screen.findByText('Run a passing connection check first.')).toBeInTheDocument();
  });
});

describe('LoadJob', () => {
  it('renders a job that failed with "Blocked:" as Blocked, not as a failure', async () => {
    const job: Job = {
      id: 'j1',
      kind: 'target.load',
      title: 'Load party',
      status: 'failed',
      progress: 0,
      progress_message: null,
      can_cancel: false,
      result: null,
      error: "Blocked: the target's API endpoints are not yet recorded.",
      attempts: 1,
      max_attempts: 1,
      tenant_id: 't1',
      project_id: null,
      requested_by: 'Fixture User',
      trace_id: null,
      created_at: '2026-11-18T10:00:00Z',
      started_at: '2026-11-18T10:00:01Z',
      finished_at: '2026-11-18T10:00:02Z',
    };
    routes['/api/v1/jobs/j1'] = () => jsonResponse(job);
    renderWithProviders(<LoadJob jobId="j1" onFinished={() => undefined} />);
    expect(await screen.findByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText(/endpoints are not yet recorded/)).toBeInTheDocument();
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
  });
});

describe('Scorecard', () => {
  it('lists failing measures first with expected vs actual and the detail', () => {
    renderWithProviders(
      <Scorecard
        database="golden_fixture"
        measures={[
          {
            name: 'object_count',
            passed: true,
            expected: 10,
            actual: 10,
            precision: null,
            recall: null,
            detail: 'Matches.',
          },
          {
            name: 'trap_hits',
            passed: false,
            expected: ['T-1', 'T-2'],
            actual: ['T-1'],
            precision: 1,
            recall: 0.5,
            detail: 'Missed T-2.',
          },
        ]}
      />,
    );
    const table = screen.getByRole('table', { name: /Golden run scorecard/ });
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('trap_hits');
    expect(rows[1]).toHaveTextContent('Fail');
    expect(rows[1]).toHaveTextContent('50.0%');
    expect(rows[1]).toHaveTextContent('Missed T-2.');
    expect(rows[2]).toHaveTextContent('Pass');
  });
});

const trap: AdapterTrap = {
  id: 'PACK-1',
  title: 'Fixture trap',
  description: 'A synthetic trap.',
  severity: 'high',
  stream: 'data',
  advice: 'Check it.',
  detect: { kind: 'query', queries: { sqlserver: 'SELECT 1 AS hit' } },
  origin: 'pack',
  active: true,
  added_by: null,
  reason: null,
};

describe('TrapsPanel', () => {
  it('shows pack traps read-only to people without trap:curate', async () => {
    routes['/api/v1/me'] = () => jsonResponse(me([]));
    routes['/api/v1/adapters/fixture-source/traps'] = () => jsonResponse([trap]);
    renderWithProviders(<TrapsPanel name="fixture-source" version="1.0.0" />);
    expect(await screen.findByText('Fixture trap')).toBeInTheDocument();
    expect(screen.getByText('From the pack')).toBeInTheDocument();
    expect(screen.getByLabelText(/sqlserver query for PACK-1/)).toHaveTextContent(
      'SELECT 1 AS hit',
    );
    expect(screen.queryByRole('button', { name: /Add curated trap/ })).not.toBeInTheDocument();
  });

  it('maps 422 trap field paths into the editor', async () => {
    routes['/api/v1/me'] = () => jsonResponse(me(['trap:curate']));
    routes['/api/v1/adapters/fixture-source/traps'] = () => jsonResponse([trap]);
    routes['POST /api/v1/adapters/fixture-source/traps'] = () =>
      jsonResponse(
        {
          type: '/problems/validation',
          title: 'Some fields need attention',
          status: 422,
          errors: [
            {
              field: 'trap.detect.queries.sqlserver',
              message: 'Queries must be read-only.',
            },
          ],
        },
        422,
        'application/problem+json',
      );
    renderWithProviders(<TrapsPanel name="fixture-source" version="1.0.0" />);
    await userEvent.click(await screen.findByRole('button', { name: /Add curated trap/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      'Seen on a fixture estate.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add trap' }));
    expect(await within(dialog).findByText(/Queries must be read-only\./)).toBeInTheDocument();
    expect(within(dialog).getByText('detect › queries › sqlserver')).toBeInTheDocument();
  });
});

describe('Ontology', () => {
  it('shows exact and similar matches with their scores and the ontology version', async () => {
    const find: ConceptFind = {
      ontology_version: 'fixture-domain@1.0.0',
      query: 'party',
      results: [
        {
          id: 'ns.party',
          label: 'Party',
          definition: 'A person or organisation.',
          pack: 'fixture-domain@1.0.0',
          match: 'exact',
          parent: null,
          synonyms: [],
          score: 1,
        },
        {
          id: 'ns.contact',
          label: 'Contact',
          definition: 'A way to reach a party.',
          pack: 'fixture-domain@1.0.0',
          match: 'similar',
          parent: null,
          synonyms: [],
          score: 0.62,
        },
      ],
    };
    routes['/api/v1/packs'] = () => jsonResponse([]);
    routes['/api/v1/ontology/scope'] = () =>
      jsonResponse({
        ontology_version: 'fixture-domain@1.0.0',
        packs: [{ ref: 'fixture-domain@1.0.0', concepts: 2 }],
      });
    routes['/api/v1/ontology/concepts'] = () =>
      jsonResponse({ ontology_version: 'fixture-domain@1.0.0', concepts: [] });
    routes['/api/v1/ontology/find'] = () => jsonResponse(find);
    renderWithRouter(<OntologyPage packs={[]} />);
    await userEvent.type(await screen.findByRole('searchbox'), 'party');
    const results = await screen.findByRole('list', { name: 'Search results' });
    expect(results).toHaveTextContent('Exact');
    expect(results).toHaveTextContent('Similar');
    expect(results).toHaveTextContent('score 0.62');
    expect(screen.getAllByText('fixture-domain@1.0.0').length).toBeGreaterThan(0);
  });

  it('shows the note when a concept has no precedents', async () => {
    const detail: ConceptDetail = {
      ontology_version: 'fixture-domain@1.0.0',
      concept: {
        id: 'ns.party',
        label: 'Party',
        definition: 'A person or organisation.',
        parent: null,
        synonyms: [],
        standards: [],
        attributes: [],
        pack: 'fixture-domain@1.0.0',
      },
      ancestors: [],
      children: [],
      relations: [],
      referenced_by: [],
      code_lists: [],
    };
    const precedents: ConceptPrecedents = {
      ontology_version: 'fixture-domain@1.0.0',
      concept: 'ns.party',
      precedents: [],
      note: 'No decisions recorded yet for this concept.',
    };
    routes['/api/v1/ontology/concepts/ns.party'] = () => jsonResponse(detail);
    routes['/api/v1/ontology/concepts/ns.party/precedents'] = () => jsonResponse(precedents);
    renderWithRouter(<ConceptPage conceptId="ns.party" packs={[]} tab="precedents" />);
    expect(
      await screen.findByText('No decisions recorded yet for this concept.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByText('fixture-domain@1.0.0').length).toBeGreaterThan(0),
    );
  });
});
