import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Gate,
  GateItem,
  GateList,
  ProofPack,
  ProofPackList,
  ProofPackVerify,
  SigningKey,
} from '@/api/gates-types';
import type { Project } from '@/api/types';
import { jsonResponse, renderWithRouter } from '@/test/utils';
import { parseProjectSearch } from './blueprints/tabs';
import { GatesTab } from './gates/GatesTab';
import { approveState, attestErrors, sourceTarget, type GatesSearch } from './gates/model';

// Test fixtures only: shapes follow /api/v1 (I11 gates and proof packs, api/routes/gates.py and
// gates.py as_dict); values are synthetic.
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
  vi.restoreAllMocks();
});

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

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
  permissions: ['stage:manage', 'review:resolve'],
  roles: ['migration_lead'],
};

const A = '/api/v1';
const P = `${A}/projects/pr1`;

const me = {
  id: ME,
  email: 'fixture.user@example.test',
  display_name: 'Alex Lead',
  mfa: true,
  roles: [],
  permissions: [],
};

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

const APPROVERS = [
  { role: 'migration_lead', label: 'Migration lead' },
  { role: 'customer_data_owner', label: 'Customer data owner' },
];

function evidence(over: Partial<GateItem> = {}): GateItem {
  return {
    key: 'rehearsal-done',
    kind: 'evidence',
    title: 'A rehearsal ran with approved code',
    met: true,
    detail: 'Rehearsal run 3.',
    source: { type: 'load_run', id: 'r3', href: `${A}/load-runs/r3` },
    control: null,
    evidence: null,
    ...over,
  };
}

const control: GateItem = {
  key: 'control:DP-01',
  kind: 'control',
  title: 'DP-01: Personal data minimised',
  met: false,
  detail: 'Needs evidence: A data protection impact assessment',
  source: null,
  control: {
    id: 'DP-01',
    pack: 'fixture-compliance@1.0.0',
    title: 'Personal data minimised',
    rule: 'Only fields with a documented purpose are migrated.',
    evidence_required: 'A data protection impact assessment',
    compliance_critical: true,
    sources: ['Fixture regulation art. 5'],
  },
  evidence: null,
};

function gate(over: Partial<Gate> = {}): Gate {
  return {
    key: 'build_rehearse',
    title: 'Build and rehearse',
    label: 'G3',
    approvers: APPROVERS,
    items: [evidence()],
    all_met: true,
    digest: 'abcdef0123456789'.repeat(4),
    status: 'open',
    approvals: [],
    passed_at: null,
    ever_passed: false,
    ...over,
  };
}

function gateList(gates: Gate[], over: Partial<GateList> = {}): GateList {
  return { gates, my_roles: ['migration_lead'], can_attest: true, ...over };
}

function eight(): Gate[] {
  return [
    gate({
      key: 'configure',
      title: 'Configure',
      label: 'G0',
      status: 'passed',
      passed_at: '2026-11-01T10:00:00Z',
      ever_passed: true,
      approvals: [
        {
          role: 'migration_lead',
          role_label: 'Migration lead',
          user: 'Alex Lead',
          user_id: ME,
          note: '',
          at: '2026-11-01T09:00:00Z',
        },
        {
          role: 'customer_data_owner',
          role_label: 'Customer data owner',
          user: 'Dana Owner',
          user_id: OTHER,
          note: 'ok',
          at: '2026-11-01T10:00:00Z',
        },
      ],
    }),
    gate({
      key: 'discover',
      title: 'Discover',
      label: 'G1',
      status: 'changed_since_pass',
      ever_passed: true,
      passed_at: '2026-11-02T10:00:00Z',
    }),
    gate({ key: 'plan', title: 'Plan', label: 'Plan' }),
    gate({
      key: 'design',
      title: 'Design',
      label: 'G2',
      all_met: false,
      items: [
        evidence({
          key: 'mappings-decided',
          title: 'Every mapping decided',
          met: false,
          detail: '0 approved, 0 rejected, 4 undecided.',
          source: {
            type: 'design_register',
            id: 'mapping',
            href: `${P}/design/items?stream=mapping`,
          },
        }),
        control,
      ],
    }),
    gate(),
    gate({ key: 'cutover', title: 'Cutover', label: 'G4' }),
    gate({ key: 'stabilise', title: 'Stabilise', label: 'Stabilise' }),
    gate({ key: 'decommission', title: 'Decommission', label: 'Decommission' }),
  ];
}

function Harness({ initial }: { initial: GatesSearch }) {
  const [view, setView] = useState<GatesSearch>(initial);
  return <GatesTab project={project} search={view} onSearch={(n) => setView(n)} />;
}

function gatesRoute(list: GateList) {
  routes[`GET ${P}/gates`] = () => jsonResponse(list);
  routes[`GET ${A}/me`] = () => jsonResponse(me);
}

// ---------------------------------------------------------------- models

describe('gates model', () => {
  it('reads the gates view from the URL', () => {
    expect(parseProjectSearch({ tab: 'gates', section: 'packs' })).toEqual({
      tab: 'gates',
      section: 'packs',
    });
    expect(parseProjectSearch({ tab: 'gates', gate: 'design' })).toEqual({
      tab: 'gates',
      gate: 'design',
    });
    expect(parseProjectSearch({ tab: 'gates', section: 'parity' })).toEqual({ tab: 'gates' });
    expect(parseProjectSearch({ tab: 'loads', gate: 'design' })).toEqual({ tab: 'loads' });
  });

  it('maps record paths to the screens that show them', () => {
    expect(sourceTarget(`${P}/blueprint/versions/2`)).toEqual({
      to: 'project',
      search: { tab: 'versions', version: 2 },
    });
    expect(sourceTarget(`${A}/discovery-runs/d1`)).toEqual({ to: 'discovery-run', runId: 'd1' });
    expect(sourceTarget(`${P}/plan/baselines`)?.to).toBe('project');
    expect(sourceTarget(`${P}/plan/cutover/choice`)).toEqual({
      to: 'project',
      search: { tab: 'plan', section: 'cutover' },
    });
    expect(sourceTarget(`${P}/design/items?stream=code`)).toEqual({
      to: 'project',
      search: { tab: 'design', section: 'code' },
    });
    expect(sourceTarget(`${P}/build-artifacts?kind=transformation`)).toEqual({
      to: 'project',
      search: { tab: 'design', section: 'build' },
    });
    expect(sourceTarget(`${A}/load-runs/r1/document-checks`)).toEqual({
      to: 'project',
      search: { tab: 'loads', section: 'documents', run: 'r1' },
    });
    expect(sourceTarget(`${P}/recon-breaks?load_run_id=r1`)).toEqual({
      to: 'project',
      search: { tab: 'loads', section: 'breaks', run: 'r1' },
    });
    expect(sourceTarget(`${P}/parity-runs`)?.to).toBe('project');
    expect(sourceTarget(`${P}/coexistence`)).toEqual({
      to: 'project',
      search: { tab: 'loads', section: 'coexistence' },
    });
    expect(sourceTarget(`${A}/unknown/x`)).toBeNull();
    expect(sourceTarget('https://docs.example.test/dpia')).toBeNull();
  });

  it('checks attestations and approvals like the API', () => {
    expect(attestErrors('', '').note).toBe('Describe the evidence.');
    expect(attestErrors('too short', '').note).toMatch(/at least 10/);
    expect(attestErrors('Long enough evidence', 'x'.repeat(1001)).reference).toMatch(/under 1000/);
    expect(attestErrors('Long enough evidence', '')).toEqual({});
    const g = gate();
    expect(approveState(g, ['migration_lead'], ME).roles.map((r) => r.role)).toEqual([
      'migration_lead',
    ]);
    expect(approveState(g, ['data_sme'], ME).reason).toMatch(/none of this gate’s approver roles/);
  });
});

// ---------------------------------------------------------------- gates

describe('Gates', () => {
  it('lists the eight gates with status, met counts and approvals per role', async () => {
    gatesRoute(gateList(eight()));
    renderWithRouter(<Harness initial={{}} />);
    const list = await screen.findByRole('list', { name: 'Gates' });
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(8);
    expect(within(rows[0]!).getByText('G0 · Configure')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Passed')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Migration lead: approved')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('2 of 2 approvals')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Changed since pass')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('Open')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('0 of 2 met')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('Customer data owner: pending')).toBeInTheDocument();
    // Without a blueprint label the title is shown once.
    expect(within(rows[2]!).getByText('Plan')).toBeInTheDocument();
  });

  it('explains a gate whose checklist changed since it passed', async () => {
    gatesRoute(gateList(eight()));
    renderWithRouter(<Harness initial={{ gate: 'discover' }} />);
    expect(
      await screen.findByText('The checklist changed since this gate passed'),
    ).toBeInTheDocument();
    expect(screen.getByText(/do not count for this one/)).toBeInTheDocument();
    expect(screen.getByText('abcdef012345…')).toBeInTheDocument();
    expect(screen.getByText(/Approvals bind to this checklist version/)).toBeInTheDocument();
  });

  it('groups the checklist, links evidence and shows a control’s rule', async () => {
    gatesRoute(gateList(eight()));
    renderWithRouter(<Harness initial={{ gate: 'design' }} />);
    const ev = await screen.findByRole('region', { name: /Evidence from the platform’s records/ });
    const link = within(ev).getByRole('link', { name: /Open the record/ });
    expect(link.getAttribute('href')).toContain('tab=design');
    expect(link.getAttribute('href')).toContain('section=mapping');
    const ctl = screen.getByRole('region', { name: /Compliance controls/ });
    expect(
      within(ctl).getByText('Only fields with a documented purpose are migrated.'),
    ).toBeInTheDocument();
    expect(within(ctl).getByText('fixture-compliance@1.0.0')).toBeInTheDocument();
    expect(within(ctl).getByText('Fixture regulation art. 5')).toBeInTheDocument();
    expect(within(ctl).getByText('Compliance critical')).toBeInTheDocument();
  });

  it('disables approval with the unmet items when the checklist is incomplete', async () => {
    gatesRoute(gateList(eight()));
    renderWithRouter(<Harness initial={{ gate: 'design' }} />);
    const btn = await screen.findByRole('button', { name: 'Approve G2' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription(/The checklist is not complete: 2 item\(s\)/);
    const unmet = screen.getByRole('list', { name: 'Items not met' });
    expect(within(unmet).getByText('Every mapping decided')).toBeInTheDocument();
    expect(within(unmet).getByText('DP-01: Personal data minimised')).toBeInTheDocument();
  });

  it('disables approval when I approved already or hold no approver role', async () => {
    const mine = gate({
      approvals: [
        {
          role: 'migration_lead',
          role_label: 'Migration lead',
          user: 'Alex Lead',
          user_id: ME,
          note: '',
          at: '2026-11-18T09:00:00Z',
        },
      ],
    });
    gatesRoute(gateList([mine], { my_roles: ['migration_lead', 'customer_data_owner'] }));
    const { unmount } = renderWithRouter(<Harness initial={{ gate: 'build_rehearse' }} />);
    const btn = await screen.findByRole('button', { name: 'Approve G3' });
    await waitFor(() =>
      expect(btn).toHaveAccessibleDescription(/You approved this checklist already/),
    );
    expect(btn).toBeDisabled();
    unmount();

    gatesRoute(gateList([gate()], { my_roles: ['data_sme'] }));
    renderWithRouter(<Harness initial={{ gate: 'build_rehearse' }} />);
    const b2 = await screen.findByRole('button', { name: 'Approve G3' });
    expect(b2).toBeDisabled();
    expect(b2).toHaveAccessibleDescription(
      /none of this gate’s approver roles on this project \(Migration lead, Customer data owner\)/,
    );
  });

  it('validates an attestation and records it with a reference', async () => {
    const g = eight()[3]!;
    gatesRoute(gateList([g]));
    const attested: Gate = {
      ...g,
      items: g.items.map((i) =>
        i.key === control.key
          ? {
              ...i,
              met: true,
              evidence: {
                note: 'DPIA signed off by the DPO',
                reference: 'https://docs.example.test/dpia',
                by: 'Alex Lead',
                at: '2026-11-19T09:00:00Z',
              },
            }
          : i,
      ),
    };
    routes[`PUT ${P}/gates/design/evidence`] = () => jsonResponse(attested);
    renderWithRouter(<Harness initial={{ gate: 'design' }} />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Attest DP-01: Personal data minimised' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Attest a control' });
    expect(within(dialog).getByText('A data protection impact assessment')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record attestation' }));
    expect(await within(dialog).findByText('Describe the evidence.')).toBeInTheDocument();
    const note = within(dialog).getByRole('textbox', { name: /Evidence/ });
    await userEvent.type(note, 'too short');
    expect(
      within(dialog).getByText('Write at least 10 characters (9 so far).'),
    ).toBeInTheDocument();
    expect(calls('PUT', `${P}/gates/design/evidence`)).toBe(0);
    await userEvent.clear(note);
    await userEvent.type(note, 'DPIA signed off by the DPO');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Reference/ }),
      'https://docs.example.test/dpia',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record attestation' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bodyOf('PUT', `${P}/gates/design/evidence`)).toEqual({
      item_key: 'control:DP-01',
      note: 'DPIA signed off by the DPO',
      reference: 'https://docs.example.test/dpia',
    });
  });

  it('approves for my role and shows the gate passed', async () => {
    const other = {
      role: 'customer_data_owner',
      role_label: 'Customer data owner',
      user: 'Dana Owner',
      user_id: OTHER,
      note: 'Checked',
      at: '2026-11-18T09:00:00Z',
    };
    const before = gate({ approvals: [other] });
    const after = gate({
      status: 'passed',
      ever_passed: true,
      passed_at: '2026-11-19T10:00:00Z',
      approvals: [
        other,
        {
          role: 'migration_lead',
          role_label: 'Migration lead',
          user: 'Alex Lead',
          user_id: ME,
          note: 'Rehearsal reconciled',
          at: '2026-11-19T10:00:00Z',
        },
      ],
    });
    let current = before;
    routes[`GET ${P}/gates`] = () => jsonResponse(gateList([current]));
    routes[`GET ${A}/me`] = () => jsonResponse(me);
    routes[`POST ${P}/gates/build_rehearse/approvals`] = () => {
      current = after;
      return jsonResponse(after);
    };
    renderWithRouter(<Harness initial={{ gate: 'build_rehearse' }} />);
    const btn = await screen.findByRole('button', { name: 'Approve G3' });
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);
    const dialog = await screen.findByRole('dialog', { name: 'Approve G3: Build and rehearse' });
    expect(within(dialog).getByText(/version abcdef012345…/)).toBeInTheDocument();
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Note/ }),
      'Rehearsal reconciled',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bodyOf('POST', `${P}/gates/build_rehearse/approvals`)).toEqual({
      role: 'migration_lead',
      note: 'Rehearsal reconciled',
    });
    expect(
      await screen.findByText('Every required role approved this checklist', { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve G3' })).toHaveAccessibleDescription(
      /You approved this checklist already/,
    );
  });
});

// ---------------------------------------------------------------- proof packs

function pack(over: Partial<ProofPack> = {}): ProofPack {
  return {
    id: 'pk2',
    number: 2,
    scope: 'wave',
    wave: 'w1',
    json_sha256: 'a'.repeat(64),
    pdf_sha256: 'b'.repeat(64),
    signature: 'vault:v1:c2lnbmF0dXJl',
    signing_key: 'platform-proof-pack',
    key_version: 1,
    summary: {
      counts: {
        configuration: 4,
        scope: 12,
        lineage: 6,
        decisions: 9,
        controls: 10,
        tests: 3,
        agents: 2,
        cutover: 5,
        decommission: 1,
      },
      items: 52,
      bytes: 20480,
    },
    created_by: 'Alex Lead',
    created_at: '2026-11-19T09:00:00Z',
    document_url: `${A}/proof-packs/pk2/document`,
    pdf_url: `${A}/proof-packs/pk2/pdf`,
    ...over,
  };
}

function packs(over: Partial<ProofPackList> = {}): ProofPackList {
  return {
    packs: [pack(), pack({ id: 'pk1', number: 1, scope: 'project', wave: null })],
    waves: ['w1', 'w2'],
    can_create: true,
    ...over,
  };
}

describe('Proof packs', () => {
  it('lists packs with scope, item counts, digests and key version', async () => {
    routes[`GET ${P}/proof-packs`] = () => jsonResponse(packs());
    renderWithRouter(<Harness initial={{ section: 'packs' }} />);
    const table = await screen.findByRole('region', { name: 'Proof packs' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText('Pack 2')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Wave w1')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Whole project')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Controls and gates').nextSibling?.textContent).toBe('10');
    expect(within(rows[1]!).getByText('52')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('aaaaaaaaaaaa…')).toBeInTheDocument();
    expect(
      within(rows[1]!).getByRole('button', { name: 'Copy the JSON sha256 of pack 2' }),
    ).toBeInTheDocument();
    expect(within(rows[1]!).getByText('v1', { exact: false })).toBeInTheDocument();
  });

  it('creates a whole-project pack and a wave pack', async () => {
    routes[`GET ${P}/proof-packs`] = () => jsonResponse(packs());
    routes[`POST ${P}/proof-packs`] = () => jsonResponse(pack({ id: 'pk3', number: 3 }), 201);
    renderWithRouter(<Harness initial={{ section: 'packs' }} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Create proof pack' }));
    let dialog = await screen.findByRole('dialog', { name: 'Create a proof pack' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create and sign' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bodyOf('POST', `${P}/proof-packs`)).toEqual({});

    await userEvent.click(screen.getByRole('button', { name: 'Create proof pack' }));
    dialog = await screen.findByRole('dialog', { name: 'Create a proof pack' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /One wave/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create and sign' }));
    expect(await within(dialog).findByText('Choose the wave the pack covers.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('combobox', { name: /Wave/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'w2' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create and sign' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bodyOf('POST', `${P}/proof-packs`)).toEqual({ wave: 'w2' });
  });

  it('explains why a pack cannot be created', async () => {
    routes[`GET ${P}/proof-packs`] = () => jsonResponse(packs({ can_create: false, packs: [] }));
    renderWithRouter(<Harness initial={{ section: 'packs' }} />);
    const btn = await screen.findByRole('button', { name: 'Create proof pack' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription(/needs stage management/);
    expect(screen.getByText('No proof packs yet')).toBeInTheDocument();
  });

  it('verifies a pack: digests recomputed and the signature valid', async () => {
    routes[`GET ${P}/proof-packs`] = () => jsonResponse(packs());
    const v: ProofPackVerify = {
      json_sha256: 'a'.repeat(64),
      pdf_sha256: 'b'.repeat(64),
      signature_valid: true,
      matches_record: true,
      valid: true,
      key_version: 1,
    };
    routes[`GET ${A}/proof-packs/pk2/verify`] = () => jsonResponse(v);
    renderWithRouter(<Harness initial={{ section: 'packs' }} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Verify pack 2' }));
    const card = await screen.findByRole('region', { name: 'Verification of pack 2' });
    expect(
      await within(card).findByText('Pack 2 is intact and its signature is valid'),
    ).toBeInTheDocument();
    expect(within(card).getAllByText('Matches the record')).toHaveLength(2);
    expect(within(card).getByText('Valid')).toBeInTheDocument();
  });

  it('shows a failed verification', async () => {
    routes[`GET ${P}/proof-packs`] = () => jsonResponse(packs());
    routes[`GET ${A}/proof-packs/pk2/verify`] = () =>
      jsonResponse({
        json_sha256: 'f'.repeat(64),
        pdf_sha256: 'b'.repeat(64),
        signature_valid: false,
        matches_record: false,
        valid: false,
        key_version: 1,
      });
    renderWithRouter(<Harness initial={{ section: 'packs' }} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Verify pack 2' }));
    expect(await screen.findByText('Pack 2 failed verification')).toBeInTheDocument();
    expect(screen.getByText('Differs from the record')).toBeInTheDocument();
    expect(screen.getByText(/The signature does not verify/)).toBeInTheDocument();
  });

  it('downloads the JSON and the PDF through the authenticated client', async () => {
    routes[`GET ${P}/proof-packs`] = () => jsonResponse(packs());
    routes[`GET ${A}/proof-packs/pk2/document`] = () =>
      new Response('{"format":"astra.proofpack/v1"}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': 'attachment; filename="proof-pack-2.json"',
        },
      });
    routes[`GET ${A}/proof-packs/pk2/pdf`] = () =>
      new Response(new Blob(['%PDF-1.4']), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="proof-pack-2.pdf"',
        },
      });
    const create = vi.fn(() => 'blob:fixture');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    renderWithRouter(<Harness initial={{ section: 'packs' }} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Download pack 2 as JSON' }));
    await waitFor(() => expect(names).toEqual(['proof-pack-2.json']));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Download pack 2 as PDF' })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Download pack 2 as PDF' }));
    await waitFor(() => expect(names).toEqual(['proof-pack-2.json', 'proof-pack-2.pdf']));
    expect(create).toHaveBeenCalledTimes(2);
    expect(calls('GET', `${A}/proof-packs/pk2/document`)).toBe(1);
    expect(calls('GET', `${A}/proof-packs/pk2/pdf`)).toBe(1);
  });
});

describe('Signing key', () => {
  it('shows the public key per version, the signed message and offline steps', async () => {
    const key: SigningKey = {
      key: 'platform-proof-pack',
      type: 'ed25519',
      algorithm: 'Ed25519',
      message: "utf-8 bytes of '<sha256 of the JSON>:<sha256 of the PDF>'",
      versions: { '1': 'MCowBQYDK2VwAyEAfixturekeyone=', '2': 'fixturekeytwo=' },
    };
    routes[`GET ${A}/proof-packs/signing-key`] = () => jsonResponse(key);
    renderWithRouter(<Harness initial={{ section: 'signing-key' }} />);
    const table = await screen.findByRole('region', { name: 'Public keys' });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]!).getByText('v2')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('MCowBQYDK2VwAyEAfixturekeyone=')).toBeInTheDocument();
    expect(screen.getByText('<sha256 of the JSON>:<sha256 of the PDF>')).toBeInTheDocument();
    expect(screen.getByText('Ed25519')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'How to verify a pack offline' }),
    ).toBeInTheDocument();
  });
});
