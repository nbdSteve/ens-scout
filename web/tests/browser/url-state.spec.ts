import { expect, test } from '@playwright/test'
import { openMore, searchOf, since, visit } from './support'

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
  const landed = await namesOn(page)

  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('link', { name: /^Premium/ })
    .click()
  await expect(
    page.getByRole('heading', { level: 1, name: 'Premium .eth names', exact: true }),
  ).toBeVisible()
  expect(searchOf(page)).toContain('view=premium')
  await expect(page.getByRole('table').getByRole('rowheader')).toHaveCount(2)

  await page.goBack()
  // Back to the default view, which is written as the absence of the parameter.
  expect(searchOf(page)).not.toContain('view=')
  expect(await namesOn(page)).toEqual(landed)
})

test('the search reaches the address bar and survives a reload', async ({ page }) => {
  // `view=all`, because the two names the fixture has available hold no `x` and a
  // search that found nothing would prove nothing about the round trip.
  await visit(page, { view: 'all' })

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
    page.getByRole('heading', { level: 1, name: 'Grace period .eth names', exact: true }),
  ).toBeVisible()

  // Nothing is rewritten on arrival: the link a visitor was given is the link they
  // keep, so copying it out of the address bar hands on the same page.
  expect(searchOf(page)).toBe(search)
})

test('clearing the filters keeps the view and drops only the filters', async ({ page }) => {
  await visit(page, { view: 'grace', q: 'nosuchname', min: '3' })
  await expect(page.getByRole('heading', { name: 'No names to show' })).toBeVisible()

  // The toolbar offers "Clear filters" and the empty table offers "Clear all
  // filters", so this is the one a visitor who has just been told there is nothing
  // to show would reach for.
  await page
    .getByRole('region', { name: 'Grace period .eth names', exact: true })
    .getByRole('link', { name: 'Clear all filters' })
    .click()

  expect(searchOf(page)).toContain('view=grace')
  expect(searchOf(page)).not.toContain('q=')
  expect(searchOf(page)).not.toContain('min=')
  await expect(page.getByRole('table').getByRole('rowheader')).toHaveCount(2)
})

test('a sort choice reorders the rows and is written down', async ({ page }) => {
  // Ten names rather than two, so a reorder is visible, and the sort control opened
  // because it lives behind the extra-filters disclosure.
  await visit(page, { view: 'all' })
  await openMore(page)
  const byName = await namesOn(page)

  await page.getByRole('combobox', { name: 'Sort by' }).selectOption({ label: 'Expiry' })

  expect(searchOf(page)).toContain('sort=expiry')
  const byExpiry = await namesOn(page)
  expect(byExpiry).not.toEqual(byName)
  // Reordering is not filtering.
  expect([...byExpiry].sort()).toEqual([...byName].sort())
})

test('a length range that is not applied keeps saying so through the back button', async ({
  page,
}) => {
  // The bounds are kept rather than repaired, so every history entry below still holds
  // them and the length filter is still doing nothing on every one of them.
  await visit(page, { view: 'all', min: '9', max: '5' })
  // A named region, not an alert: the band's length lines change as the visitor types, so
  // it announces politely rather than interrupting on every digit.
  const advisory = page.getByRole('region', { name: 'Not applied' })
  await expect(advisory).toContainText('Length range not applied: shortest 9 is above longest 5.')

  // A same-document history entry, which is what makes going back a `popstate` rather
  // than a fresh document. A real browser is the only place that distinction exists.
  await openMore(page)
  await page.getByRole('combobox', { name: 'Sort by' }).selectOption({ label: 'Expiry' })
  expect(searchOf(page)).toContain('sort=expiry')
  await expect(advisory).toContainText('Length range not applied')

  await page.goBack()

  expect(searchOf(page)).toContain('min=9')
  expect(searchOf(page)).toContain('max=5')
  await expect(advisory).toContainText('Length range not applied: shortest 9 is above longest 5.')
})

test('a half-typed length is reported, and the report goes when the box is emptied', async ({
  page,
}) => {
  /*
   * Only a real browser has the state this is about, and every unit test of it has to say so
   * by hand. Here Chromium says it: a lone `e` is the exponent of a number the visitor has
   * not finished, so the field shows the character and reports its value as the empty string.
   *
   * That is also the harder half. Nothing the page can see changes - the value was empty and
   * still is, so React dispatches no change at all - which is why the validity is read from
   * the native `input` event instead.
   */
  await visit(page, { view: 'all' })
  const box = page.getByRole('spinbutton', { name: 'Shortest label length' })
  const advisory = page.getByRole('region', { name: 'Not applied' })
  const rows = page.getByRole('table').getByRole('rowheader')

  await box.press('e')

  expect(
    await box.evaluate((node: HTMLInputElement) => ({
      value: node.value,
      badInput: node.validity.badInput,
    })),
    'Chromium no longer reports a half-typed number this way',
  ).toEqual({ value: '', badInput: true })
  await expect(advisory).toContainText(
    'Shortest length not applied: this box needs a whole number from 1 to 64.',
  )
  await expect(box).toHaveAttribute('aria-invalid', 'true')
  // Nothing is filtering by length, which is what the notice is there to explain.
  await expect(rows).toHaveCount(10)

  await box.fill('')

  // The box is empty and nothing is wrong, so the page has nothing to say about it.
  await expect(advisory).toHaveCount(0)
  await expect(box).toHaveAttribute('aria-invalid', 'false')
  await expect(rows).toHaveCount(10)
})

test('the simulated clock can be given up, and says so on the way out', async ({ page }) => {
  await visit(page)
  await expect(page.getByRole('region', { name: 'Showing a simulated time' })).toBeVisible()

  await page.getByRole('link', { name: 'Use the real time instead' }).click()

  expect(searchOf(page)).not.toContain('now=')
  await expect(page.getByRole('region', { name: 'Showing a simulated time' })).toBeHidden()
})
