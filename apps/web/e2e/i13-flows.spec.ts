import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { me, mockApi, signInWithFixtureSession } from './support';

/**
 * Key I13 flows against FIXTURE API responses (see e2e/support.ts): reading the release history and
 * a blocked release's detail; checking now whether a release would pass; and recording a release
 * that is blocked, after the name and reason are validated. Names and values are synthetic.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const health = { status: 'ok', version: '0.0.0-fixture', checks: [] };

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

const R = '/api/v1/releases';

const common = {
  '/api/v1/me': me(['tenant:read', 'golden:run']),
  '/api/v1/health': health,
  '/api/v1/roles': [],
  '/api/v1/jobs': [],
};

const ENGINE = 'e'.repeat(64);

const MEASURE_NAMES = [
  'mapping.top1_accuracy',
  'mapping.auto_precision',
  'mapping.review_recall',
  'configuration.accuracy',
  'code.review_routing_accuracy',
  'code.conversion_accuracy',
  'planning.disposition_accuracy',
  'planning.cycle_recall',
  'planning.cycle_precision',
  'compliance.level_accuracy',
  'compliance.approvers_accuracy',
  'review.order_agreement',
  'review.grouping_agreement',
];

function suites(over: Record<string, number> = {}) {
  return {
    'fixture-suite': {
      digest: 'd'.repeat(64),
      measures: {
        ...Object.fromEntries(MEASURE_NAMES.map((m) => [m, 1])),
        'mapping.top1_accuracy': 0.8667,
        ...over,
      },
    },
  };
}

const fell = {
  suite: 'fixture-suite',
  measure: 'mapping.top1_accuracy',
  baseline: 0.8667,
  current: 0.8,
  detail: 'fell from 0.8667 to 0.8',
};

const r1 = {
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

const r2 = {
  id: 'r2',
  name: 'R2-fixture',
  status: 'blocked',
  baseline_release: 'R1-fixture',
  regressions: [fell],
  improved: [
    { suite: 'fixture-suite', measure: 'review.order_agreement', baseline: 0.9, current: 1 },
  ],
  reason: 'Second release attempt for the fixture.',
  recorded_by: 'Fixture Lead',
  created_at: '2026-11-19T09:00:00Z',
  engine_digest: ENGINE,
};

test('History: read a blocked release, its regressions and scorecard by area', async ({ page }) => {
  await signInWithFixtureSession(page);
  await mockApi(page, {
    ...common,
    [`GET ${R}`]: { releases: [r2, r1], can_record: true },
    [`GET ${R}/r2`]: { ...r2, suites: suites({ 'mapping.top1_accuracy': 0.8 }) },
  });
  await page.goto('/releases');
  await expect(page.getByRole('heading', { name: 'Releases', level: 1 })).toBeVisible();
  const history = page.getByRole('table', { name: 'Release history' });
  await expect(history.getByRole('row', { name: /R2-fixture/ })).toContainText('Blocked');
  await expect(
    page.getByText('python -m astra_migrate.evaluation gate', { exact: false }),
  ).toBeVisible();
  await axe(page);

  await history.getByRole('row', { name: /R2-fixture/ }).click();
  await expect(page).toHaveURL(/release=r2/);
  await expect(page.getByRole('heading', { name: 'Release R2-fixture' })).toBeVisible();
  const regressions = page.getByRole('region', { name: 'Regressions of release R2-fixture' });
  await expect(regressions).toContainText('fell from 0.8667 to 0.8');
  const measures = page.getByRole('region', { name: 'Measures of suite fixture-suite' });
  await expect(measures.getByRole('row', { name: /top1_accuracy/ })).toContainText('0.800');
  await expect(measures.getByRole('row', { name: /review_recall/ })).toContainText(
    'Wrong proposals go to review.',
  );
  await page.evaluate('window.scrollTo(0, 0)');
  await axe(page);
});

test('Check now: a release would be blocked; baseline and now side by side', async ({ page }) => {
  await signInWithFixtureSession(page);
  const { requests } = await mockApi(page, {
    ...common,
    [`GET ${R}`]: { releases: [r1], can_record: true },
    [`GET ${R}/r1`]: { ...r1, suites: suites() },
    [`GET ${R}/evaluation`]: {
      baseline_release: 'R1-fixture',
      passed: false,
      regressions: [fell],
      improved: [],
      changed_suites: [],
      suites: suites({ 'mapping.top1_accuracy': 0.8 }),
      engine_digest: ENGINE,
    },
  });
  await page.goto('/releases');
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Would be blocked' })).toContainText(
    '1 regression(s) against R1-fixture',
  );
  const compare = page.getByRole('region', { name: 'Baseline and now for suite fixture-suite' });
  await expect(compare.getByRole('row', { name: /top1_accuracy/ }).getByRole('cell')).toHaveText([
    '0.867',
    '0.800',
    '−0.067',
    'Fell',
    'The first mapping proposed for a column is the expected target.',
  ]);
  expect(requests.some((r) => r.method === 'POST')).toBe(false);
  await page.evaluate('window.scrollTo(0, 0)');
  await axe(page);
});

test('Record release: validation, then a blocked result announced', async ({ page }) => {
  await signInWithFixtureSession(page);
  let releases: unknown[] = [r1];
  const r3 = {
    ...r2,
    id: 'r3',
    name: 'R3-fixture',
    reason: 'Third release for the fixture.',
    improved: [],
    suites: suites({ 'mapping.top1_accuracy': 0.8 }),
  };
  const { requests } = await mockApi(page, {
    ...common,
    [`GET ${R}`]: () => ({ releases, can_record: true }),
    [`POST ${R}`]: () => {
      releases = [r3, r1];
      return r3;
    },
    [`GET ${R}/r3`]: r3,
  });
  await page.goto('/releases');
  await page.getByRole('button', { name: 'Record release' }).click();
  const dialog = page.getByRole('dialog', { name: 'Record release' });
  await expect(
    dialog.getByText('A release with any fallen measure is recorded as Blocked'),
  ).toBeVisible();
  await dialog.getByRole('textbox', { name: /Release name/ }).fill('R3 fixture');
  await dialog.getByRole('textbox', { name: /Reason/ }).fill('Too short');
  await dialog.getByRole('button', { name: 'Evaluate and record' }).click();
  await expect(dialog.getByText(/Start with a letter or digit/)).toBeVisible();
  await expect(dialog.getByText(/at least 10 characters \(9 so far\)/)).toBeVisible();
  expect(requests.some((r) => r.method === 'POST')).toBe(false);
  await axe(page);

  await dialog.getByRole('textbox', { name: /Release name/ }).fill('R3-fixture');
  await dialog.getByRole('textbox', { name: /Reason/ }).fill('Third release for the fixture.');
  await dialog.getByRole('button', { name: 'Evaluate and record' }).click();
  await expect(dialog).toHaveCount(0);
  expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
    name: 'R3-fixture',
    reason: 'Third release for the fixture.',
  });
  const result = page.getByRole('status').filter({ hasText: 'R3-fixture blocked' });
  await expect(result).toContainText('fell from 0.8667 to 0.8');
  await expect(result).toContainText('R1-fixture stays the baseline');
  await expect(page).toHaveURL(/release=r3/);
  await expect(
    page.getByRole('table', { name: 'Release history' }).getByRole('row', { name: /R3-fixture/ }),
  ).toContainText('Blocked');
  await page.evaluate('window.scrollTo(0, 0)');
  await axe(page);
});
