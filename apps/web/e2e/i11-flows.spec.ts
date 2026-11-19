import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { me, mockApi, signInWithFixtureSession } from './support';

/**
 * Key I11 flows against FIXTURE API responses (see e2e/support.ts): a deep-linked gate whose
 * checklist is incomplete, with a control attested; approving a complete gate until it passes;
 * creating and verifying a wave proof pack; and downloading a pack and reading the signing key.
 * Values are synthetic.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const health = { status: 'ok', version: '0.0.0-fixture', checks: [] };

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

const ME = me([]).id;
const OTHER = '00000000-0000-4000-8000-000000000002';
const P = '/api/v1/projects/pr1';

const project = {
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

const common = {
  '/api/v1/me': me(['tenant:read']),
  '/api/v1/health': health,
  '/api/v1/projects/pr1': project,
  '/api/v1/projects/pr1/stages': [],
  '/api/v1/roles': [{ key: 'migration_lead', label: 'Migration lead' }],
  '/api/v1/jobs': [],
};

const APPROVERS = [
  { role: 'migration_lead', label: 'Migration lead' },
  { role: 'customer_data_owner', label: 'Customer data owner' },
];

const control = {
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

function gate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'build_rehearse',
    title: 'Build and rehearse',
    label: 'G3',
    approvers: APPROVERS,
    items: [
      {
        key: 'rehearsal-done',
        kind: 'evidence',
        title: 'A rehearsal ran with approved code',
        met: true,
        detail: 'Rehearsal run 3.',
        source: { type: 'load_run', id: 'r3', href: '/api/v1/load-runs/r3' },
        control: null,
        evidence: null,
      },
    ],
    all_met: true,
    digest: 'abcdef0123456789'.repeat(4),
    status: 'open',
    approvals: [],
    passed_at: null,
    ever_passed: false,
    ...over,
  };
}

const designGate = gate({
  key: 'design',
  title: 'Design',
  label: 'G2',
  all_met: false,
  items: [
    {
      key: 'mappings-decided',
      kind: 'evidence',
      title: 'Every mapping decided',
      met: false,
      detail: '0 approved, 0 rejected, 4 undecided.',
      source: {
        type: 'design_register',
        id: 'mapping',
        href: '/api/v1/projects/pr1/design/items?stream=mapping',
      },
      control: null,
      evidence: null,
    },
    control,
  ],
});

function eight(): Record<string, unknown>[] {
  return [
    gate({ key: 'configure', title: 'Configure', label: 'G0' }),
    gate({
      key: 'discover',
      title: 'Discover',
      label: 'G1',
      status: 'changed_since_pass',
      ever_passed: true,
      passed_at: '2026-11-02T10:00:00Z',
    }),
    gate({ key: 'plan', title: 'Plan', label: 'Plan' }),
    designGate,
    gate(),
    gate({ key: 'cutover', title: 'Cutover', label: 'G4' }),
    gate({ key: 'stabilise', title: 'Stabilise', label: 'Stabilise' }),
    gate({ key: 'decommission', title: 'Decommission', label: 'Decommission' }),
  ];
}

const list = (gates: Record<string, unknown>[]) => ({
  gates,
  my_roles: ['migration_lead'],
  can_attest: true,
});

function pack(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pk1',
    number: 1,
    scope: 'project',
    wave: null,
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
    created_by: 'Fixture User',
    created_at: '2026-11-19T09:00:00Z',
    document_url: '/api/v1/proof-packs/pk1/document',
    pdf_url: '/api/v1/proof-packs/pk1/pdf',
    ...over,
  };
}

test('Gates: a deep-linked incomplete gate explains why it cannot be approved, and a control is attested', async ({
  page,
}) => {
  await signInWithFixtureSession(page);
  let attested = false;
  const { requests } = await mockApi(page, {
    ...common,
    [`GET ${P}/gates`]: () =>
      list(
        eight().map((g) =>
          g.key === 'design' && attested
            ? {
                ...g,
                items: [
                  (g.items as unknown[])[0],
                  {
                    ...control,
                    met: true,
                    evidence: {
                      note: 'DPIA signed off by the DPO',
                      reference: 'DPIA-42',
                      by: 'Fixture User',
                      at: '2026-11-19T09:00:00Z',
                    },
                  },
                ],
              }
            : g,
        ),
      ),
    [`PUT ${P}/gates/design/evidence`]: () => {
      attested = true;
      return {
        ...designGate,
        items: [
          (designGate.items as unknown[])[0],
          {
            ...control,
            met: true,
            evidence: {
              note: 'DPIA signed off by the DPO',
              reference: 'DPIA-42',
              by: 'Fixture User',
              at: '2026-11-19T09:00:00Z',
            },
          },
        ],
      };
    },
  });
  await page.goto('/projects/pr1?tab=gates&gate=design');
  await expect(page.getByRole('list', { name: 'Gates' }).getByRole('button')).toHaveCount(8);
  const approve = page.getByRole('button', { name: 'Approve G2' });
  await expect(approve).toBeDisabled();
  await expect(approve).toHaveAccessibleDescription(/The checklist is not complete/);
  await expect(
    page.getByRole('list', { name: 'Items not met' }).getByText('Every mapping decided'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /Open the record/ })).toHaveAttribute(
    'href',
    /tab=design.*section=mapping|section=mapping.*tab=design/,
  );
  await axe(page);

  await page.getByRole('button', { name: 'Attest DP-01: Personal data minimised' }).click();
  const dialog = page.getByRole('dialog', { name: 'Attest a control' });
  await dialog.getByRole('textbox', { name: /Evidence/ }).fill('short');
  await dialog.getByRole('button', { name: 'Record attestation' }).click();
  await expect(dialog.getByText('Write at least 10 characters (5 so far).')).toBeVisible();
  await axe(page);
  await dialog.getByRole('textbox', { name: /Evidence/ }).fill('DPIA signed off by the DPO');
  await dialog.getByRole('textbox', { name: /Reference/ }).fill('DPIA-42');
  await dialog.getByRole('button', { name: 'Record attestation' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/Reference:/)).toContainText('DPIA-42');
  expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({
    item_key: 'control:DP-01',
    note: 'DPIA signed off by the DPO',
    reference: 'DPIA-42',
  });
});

test('Gates: approving the last required role passes the gate', async ({ page }) => {
  await signInWithFixtureSession(page);
  const other = {
    role: 'customer_data_owner',
    role_label: 'Customer data owner',
    user: 'Dana Owner',
    user_id: OTHER,
    note: 'Checked',
    at: '2026-11-18T09:00:00Z',
  };
  const passed = gate({
    status: 'passed',
    ever_passed: true,
    passed_at: '2026-11-19T10:00:00Z',
    approvals: [
      other,
      {
        role: 'migration_lead',
        role_label: 'Migration lead',
        user: 'Fixture User',
        user_id: ME,
        note: '',
        at: '2026-11-19T10:00:00Z',
      },
    ],
  });
  let current = gate({ approvals: [other] });
  const { requests } = await mockApi(page, {
    ...common,
    [`GET ${P}/gates`]: () => list([current]),
    [`POST ${P}/gates/build_rehearse/approvals`]: () => {
      current = passed;
      return passed;
    },
  });
  await page.goto('/projects/pr1?tab=gates&gate=build_rehearse');
  await page.getByRole('button', { name: 'Approve G3' }).click();
  const dialog = page.getByRole('dialog', { name: 'Approve G3: Build and rehearse' });
  await expect(dialog.getByText(/version abcdef012345…/)).toBeVisible();
  await axe(page);
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/Every required role approved this checklist/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve G3' })).toBeDisabled();
  expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
    role: 'migration_lead',
    note: '',
  });
});

test('Proof packs: create a wave pack and verify it', async ({ page }) => {
  await signInWithFixtureSession(page);
  let packs = [pack()];
  const wavePack = pack({ id: 'pk2', number: 2, scope: 'wave', wave: 'w2' });
  const { requests } = await mockApi(page, {
    ...common,
    [`GET ${P}/proof-packs`]: () => ({ packs, waves: ['w1', 'w2'], can_create: true }),
    [`POST ${P}/proof-packs`]: () => {
      packs = [wavePack, ...packs];
      return wavePack;
    },
    '/api/v1/proof-packs/pk2/verify': {
      json_sha256: 'a'.repeat(64),
      pdf_sha256: 'b'.repeat(64),
      signature_valid: true,
      matches_record: true,
      valid: true,
      key_version: 1,
    },
  });
  await page.goto('/projects/pr1?tab=gates&section=packs');
  await expect(page.getByRole('region', { name: 'Proof packs', exact: true })).toBeVisible();
  await axe(page);
  await page.getByRole('button', { name: 'Create proof pack' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a proof pack' });
  await dialog.getByRole('radio', { name: /One wave/ }).check();
  await dialog.getByRole('combobox', { name: /Wave/ }).click();
  await page.getByRole('option', { name: 'w2' }).click();
  await axe(page);
  await dialog.getByRole('button', { name: 'Create and sign' }).click();
  await expect(dialog).toHaveCount(0);
  expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ wave: 'w2' });
  await expect(page.getByRole('rowheader', { name: 'Pack 2' })).toBeVisible();
  await page.getByRole('button', { name: 'Verify pack 2' }).click();
  await expect(page.getByText('Pack 2 is intact and its signature is valid')).toBeVisible();
  await axe(page);
});

test('Proof packs: download the signed JSON, and read the signing key', async ({ page }) => {
  await signInWithFixtureSession(page);
  await mockApi(page, {
    ...common,
    [`GET ${P}/proof-packs`]: { packs: [pack()], waves: [], can_create: false },
    '/api/v1/proof-packs/signing-key': {
      key: 'platform-proof-pack',
      type: 'ed25519',
      algorithm: 'Ed25519',
      message: "utf-8 bytes of '<sha256 of the JSON>:<sha256 of the PDF>'",
      versions: { '1': 'fixturepublickeyone=' },
    },
  });
  await page.route('**/api/v1/proof-packs/pk1/document', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Content-Disposition': 'attachment; filename="proof-pack-1.json"' },
      body: '{"format":"astra.proofpack/v1"}',
    });
  });
  await page.goto('/projects/pr1?tab=gates&section=packs');
  await expect(page.getByRole('button', { name: 'Create proof pack' })).toHaveAccessibleDescription(
    /needs stage management/,
  );
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download pack 1 as JSON' }).click();
  expect((await download).suggestedFilename()).toBe('proof-pack-1.json');

  await page.getByRole('tab', { name: 'Signing key' }).click();
  await expect(page).toHaveURL(/section=signing-key/);
  await expect(
    page.getByRole('region', { name: 'Public keys' }).getByText('fixturepublickeyone='),
  ).toBeVisible();
  await expect(page.getByText('<sha256 of the JSON>:<sha256 of the PDF>').first()).toBeVisible();
  await axe(page);
});
