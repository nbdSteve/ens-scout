import { expect, test } from '@playwright/test'
import {
  DAY,
  expectAccessible,
  openData,
  openLength,
  openMore,
  since,
  visit,
  visitFeatured,
} from './support'

test('the reviewed featured hero has no automated accessibility violations', async ({ page }) => {
  test.setTimeout(120_000)
  await visitFeatured(page)
  await expect(page.locator('.featured-hero')).toHaveAttribute(
    'data-featured-source',
    'reviewed-artifact',
  )
  await expectAccessible(page)
})

test('the deterministic fallback hero has no automated accessibility violations', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.route('**/data/og-rank-v1.json', async (route) => {
    await route.fulfill({
      body: '{"format_version":99}',
      headers: { 'content-type': 'application/json' },
    })
  })
  await visitFeatured(page)
  await expect(page.locator('.featured-hero')).toHaveAttribute(
    'data-featured-source',
    'deterministic-fallback',
  )
  await expectAccessible(page)
})

for (const view of ['available', 'premium', 'expiring', 'grace', 'all']) {
  test(`${view} has no automated accessibility violations`, async ({ page }) => {
    test.setTimeout(120_000)
    await visit(page, { view })
    await expect(page.getByRole('region', { name: /\.eth names$/ })).toBeVisible()
    await expectAccessible(page)
  })
}

test('the open filter panels are accessible', async ({ page }) => {
  test.setTimeout(120_000)
  await visit(page, { view: 'all' })
  await openLength(page)
  await openMore(page)
  await expectAccessible(page)
})

test('the Data drawer is accessible', async ({ page }) => {
  test.setTimeout(120_000)
  await visit(page, { view: 'all' })
  await openData(page)
  await expectAccessible(page)
})

test('the Data drawer remains accessible from the featured hero', async ({ page }) => {
  test.setTimeout(120_000)
  await visitFeatured(page)
  await openData(page)
  await expect(page.locator('.featured-source')).toContainText('Reviewed ranking')
  await expectAccessible(page)
})

test('the empty and stale states remain accessible', async ({ page }) => {
  test.setTimeout(120_000)
  await visit(page, { q: 'no-such-spectrum-name' })
  await expect(page.getByRole('heading', { name: 'No names to show' })).toBeVisible()
  await expectAccessible(page)

  await visit(page, { now: since(3 * DAY) })
  await expect(page.locator('.snapshot-badge')).toContainText('Stale')
  await openData(page)
  await expect(page.getByRole('alert')).toBeVisible()
  await expectAccessible(page)
})

test('landmarks match the editorial header and discovery hierarchy', async ({ page }) => {
  await visit(page)

  await expect(page.getByRole('banner')).toHaveCount(1)
  await expect(page.getByRole('main')).toHaveCount(1)
  await expect(page.getByRole('contentinfo')).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Site' })).toHaveCount(1)
  await expect(page.getByRole('navigation', { name: 'Views' })).toHaveCount(1)
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
})

test('the canonical route keeps one H1 in the hero and a labelled discovery H2', async ({
  page,
}) => {
  await visitFeatured(page)

  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName(
    'The good ones are still out there.',
  )
  await expect(page.getByRole('heading', { level: 2, name: 'Available .eth names' })).toHaveCount(1)
  await expect(page.getByRole('region', { name: 'Available .eth names' })).toHaveCount(1)
})
