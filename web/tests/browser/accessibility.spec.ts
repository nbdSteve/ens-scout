import { expect, test } from '@playwright/test'
import { DAY, expectAccessible, openDetails, openMore, since, visit } from './support'

/**
 * Automated accessibility checks, run at every configured viewport.
 *
 * axe cannot decide whether the page is usable, so it is not the whole of the
 * accessibility coverage: the keyboard and layout suites carry the parts a tool
 * cannot see. What axe is good at is the machine-checkable half - contrast, names,
 * roles, landmark structure - and it has to run on each state the page can be in,
 * because a violation introduced by a filtered or empty view would not appear on
 * the state the page loads in.
 */

const VIEWS = ['all', 'available', 'premium', 'expiring', 'grace'] as const

/*
 * Both colour schemes, because the palettes are independent and axe only ever sees
 * the one the browser asked for. A contrast failure was found this way: the light
 * palette's link colour cleared 4.5:1 on white and missed it on the tinted banner
 * backgrounds, which the default light-only run would have gone on passing.
 */
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`in the ${colorScheme} palette`, () => {
    test.use({ colorScheme })

    for (const view of VIEWS) {
      test(`the ${view} view has no automated accessibility violations`, async ({ page }) => {
        await visit(page, { view })
        await expect(page.getByRole('table')).toBeVisible()
        await expectAccessible(page)
      })
    }

    test('and neither has anything behind a disclosure', async ({ page }) => {
      /*
       * axe examines what is rendered, and a closed `<details>` renders nothing, so
       * the two disclosures would otherwise never be checked in either palette.
       * Between them they hold every select, every checkbox, the source-list
       * schedules, the counts, and the lifecycle rules - which is most of the
       * page's text and most of its controls.
       */
      await visit(page, { view: 'all' })
      await openMore(page)
      await openDetails(page)
      await expectAccessible(page)
    })
  })
}

test('a filtered view has none either', async ({ page }) => {
  await visit(page, { q: 'a', status: 'available', min: '3', max: '5', dir: 'desc' })
  await expect(page.getByRole('table')).toBeVisible()
  await expectAccessible(page)
})

test('the empty state has none, including the way out of it', async ({ page }) => {
  await visit(page, { q: 'nosuchname' })
  const empty = page.getByRole('region', { name: 'Available .eth names', exact: true })
  await expect(empty.getByRole('heading', { name: 'No names to show' })).toBeVisible()
  await expect(empty.getByRole('link', { name: 'Clear all filters' })).toBeVisible()
  await expectAccessible(page)
})

test('the stale warning has none, and it is the alert that says so', async ({ page }) => {
  await visit(page, { now: since(3 * DAY) })
  await expect(page.getByRole('alert')).toContainText('out of date')
  await expectAccessible(page)
})

test('the page has one of each landmark a visitor navigates by', async ({ page }) => {
  await visit(page)

  // No `banner`, and that is the requirement rather than an omission. The page
  // carries no name and no bar, so there is nothing for a header landmark to hold,
  // and announcing an empty one would send a screen-reader user to a dead stop.
  await expect(page.getByRole('banner')).toHaveCount(0)
  await expect(page.getByRole('main')).toHaveCount(1)
  await expect(page.getByRole('contentinfo')).toHaveCount(1)
  await expect(page.getByRole('navigation', { name: 'Views' })).toHaveCount(1)
})

test('the headings step down one level at a time', async ({ page }) => {
  await visit(page)

  const levels = await page
    .locator('h1, h2, h3, h4, h5, h6')
    .evaluateAll((nodes) => nodes.map((node) => Number(node.tagName.slice(1))))

  expect(levels[0]).toBe(1)
  expect(levels.filter((level) => level === 1)).toHaveLength(1)
  for (const [index, level] of levels.entries()) {
    if (index === 0) {
      continue
    }
    // A skipped level leaves a screen-reader user guessing what the outline is.
    expect(level).toBeLessThanOrEqual((levels[index - 1] ?? 1) + 1)
  }
})
