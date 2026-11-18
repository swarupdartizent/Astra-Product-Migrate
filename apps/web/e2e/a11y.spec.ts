import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`signed-out page (${colorScheme})`, () => {
    test.use({ colorScheme });

    test('redirects to sign-in and has no WCAG 2.2 AA violations', async ({ page }) => {
      await page.goto('/');
      await expect(page).toHaveURL(/\/sign-in/);
      await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Sign in with your organisation' }),
      ).toBeEnabled();

      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });
  });
}

test('unknown routes show the not-found page', async ({ page }) => {
  await page.goto('/this-route-does-not-exist');
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations).toEqual([]);
});

for (const path of [
  '/tenants',
  '/tenants/00000000-0000-4000-8000-000000000000?tab=policy',
  '/programmes',
  '/access',
  '/audit',
  '/observability',
  '/observability/traces/abc',
  '/packs',
  '/packs/compose',
  '/packs/fixture-pack/1.0.0?tab=controls',
  '/projects/00000000-0000-4000-8000-000000000000?tab=versions&version=2',
  '/templates',
  '/models?tab=aliases',
  '/agents?tab=readiness',
  '/agents/register',
  '/agents/fixture-agent/1.0.0?tab=tests',
  '/projects/00000000-0000-4000-8000-000000000000?tab=reviews',
]) {
  test(`deep link ${path} while signed out goes to sign-in and keeps the destination`, async ({
    page,
  }) => {
    await page.goto(path);
    await expect(page).toHaveURL(/\/sign-in\?redirect=/);
    const redirect = new URL(page.url()).searchParams.get('redirect');
    expect(redirect).toBe(path);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });
}
