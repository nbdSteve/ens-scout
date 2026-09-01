import { expect, test } from '@playwright/test'
import { searchOf, since, visit } from './support'

/**
 * The address bar as the state, exercised through real navigation.
 *
 * `query.test.ts` already proves the parse and serialize round trip as arithmetic.
 * What it cannot prove is that the browser agrees: that a control writes a history
 * entry rather than replacing one, that the back button restores the rows a visitor
 * came from, and that a shared link reproduces the same page on a cold load. Those
 * need real history and a real reload.
 */

/** The names in the table, in the order the page shows them. */
function namesOn(page: import('@playwright/test').Page): Promise<string[]> {
  return page
    .getByRole('table')
    .getByRole('link')
    .evaluateAll((nodes) => nodes.map((node) => node.firstChild?.textContent ?? ''))
}

test('a view link writes the view and the back button returns', async ({ page }) => {
  await visit(page)
  const everything = await namesOn(page)

  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('link', { name: /^Premium/ })
    .click()
  await expect(page.getByRole('heading', { level: 2, name: 'Premium', exact: true })).toBeVisible()
  expect(searchOf(page)).toContain('view=premium')
  await expect(page.getByRole('table').getByRole('rowheader')).toHaveCount(2)

  await page.goBack()
  expect(searchOf(page)).not.toContain('view=')
  expect(await namesOn(page)).toEqual(everything)
})

test('the search reaches the address bar and survives a reload', async ({ page }) => {
  await visit(page)

  // A substring, not a prefix: `x` is in the middle of `flux` and the end of `vex`,
  // so a search that only matched the start of a label would return nothing here.
  await page.getByRole('searchbox', { name: 'Search names' }).fill('x')
  await expect(page.getByRole('status')).toContainText('2 names match')
  await expect.poll(() => searchOf(page)).toContain('q=x')

  const found = await namesOn(page)
  await page.reload()
  // The reloaded page is built only from the link, so the same rows must come back.
  await expect(page.getByRole('searchbox', { name: 'Search names' })).toHaveValue('x')
  expect(await namesOn(page)).toEqual(found)
})

test('a link naming every control reproduces itself on a cold load', async ({ page }) => {
  const search = `?view=grace&q=k&status=grace-period&min=3&max=5&dir=desc&now=${encodeURIComponent(since(0))}`
  await page.goto(`/${search}`)
  await expect(
    page.getByRole('heading', { level: 2, name: 'Grace period', exact: true }),
  ).toBeVisible()

  // Nothing is rewritten on arrival: the link a visitor was given is the link they
  // keep, so copying it out of the address bar hands on the same page.
  expect(searchOf(page)).toBe(search)
})

test('clearing the filters keeps the view and drops only the filters', async ({ page }) => {
  await visit(page, { view: 'grace', q: 'nosuchname', min: '3' })
  await expect(page.getByRole('heading', { name: 'No names to show' })).toBeVisible()

  // The same link is offered in the filter card and in the empty table, so the one
  // a visitor who has just been told there is nothing to show would reach for.
  await page
    .getByRole('region', { name: 'Grace period', exact: true })
    .getByRole('link', { name: 'Clear all filters' })
    .click()

  expect(searchOf(page)).toContain('view=grace')
  expect(searchOf(page)).not.toContain('q=')
  expect(searchOf(page)).not.toContain('min=')
  await expect(page.getByRole('table').getByRole('rowheader')).toHaveCount(2)
})

test('a sort choice reorders the rows and is written down', async ({ page }) => {
  await visit(page)
  const byName = await namesOn(page)

  await page.getByRole('combobox', { name: 'Sort by' }).selectOption({ label: 'Expiry' })

  expect(searchOf(page)).toContain('sort=expiry')
  const byExpiry = await namesOn(page)
  expect(byExpiry).not.toEqual(byName)
  // Reordering is not filtering.
  expect([...byExpiry].sort()).toEqual([...byName].sort())
})

test('the simulated clock can be given up, and says so on the way out', async ({ page }) => {
  await visit(page)
  await expect(page.getByRole('region', { name: 'Showing a simulated time' })).toBeVisible()

  await page.getByRole('link', { name: 'Use the real time instead' }).click()

  expect(searchOf(page)).not.toContain('now=')
  await expect(page.getByRole('region', { name: 'Showing a simulated time' })).toBeHidden()
})
