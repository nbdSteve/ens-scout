import { expect, test, type Page } from '@playwright/test'
import { matchCount, openData, openLength, openMore, searchOf, since, visit } from './support'

function namesOn(page: Page): Promise<string[]> {
  return page
    .locator('.name-cell__label')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()))
}

test('a view link writes the view and Back restores default Available', async ({ page }) => {
  await visit(page)
  const landed = await namesOn(page)
  expect(landed).toHaveLength(16)

  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('link', { name: /^Premium/ })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Premium .eth names')
  expect(searchOf(page)).toContain('view=premium')
  await expect(page.locator('.name-cell')).toHaveCount(2)

  await page.goBack()
  expect(searchOf(page)).not.toContain('view=')
  expect(await namesOn(page)).toEqual(landed)
})

test('search reaches the address bar and survives a reload', async ({ page }) => {
  await visit(page, { view: 'all' })
  await page.getByRole('searchbox', { name: 'Search names' }).fill('x')
  await expect(matchCount(page)).toHaveText('2 names')
  await expect.poll(() => searchOf(page)).toContain('q=x')

  const found = await namesOn(page)
  await page.reload()
  await expect(page.getByRole('searchbox', { name: 'Search names' })).toHaveValue('x')
  expect(await namesOn(page)).toEqual(found)
})

test('a cold link naming every control reproduces itself', async ({ page }) => {
  const search = `?view=grace&q=k&status=grace-period&min=3&max=5&dir=desc&now=${encodeURIComponent(since(0))}`
  await page.goto(`/${search}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName(
    'Grace period .eth names',
  )
  expect(searchOf(page)).toBe(search)
})

test('clearing filters keeps the current view', async ({ page }) => {
  await visit(page, { view: 'grace', q: 'no-such-name', min: '3' })
  await page.getByRole('link', { name: 'Clear all filters' }).click()

  expect(searchOf(page)).toContain('view=grace')
  expect(searchOf(page)).not.toContain('q=')
  expect(searchOf(page)).not.toContain('min=')
  await expect(page.locator('.name-cell')).toHaveCount(2)
})

test('sort and length controls keep their URL behavior behind the compact dock', async ({
  page,
}) => {
  await visit(page, { view: 'all' })
  const before = await namesOn(page)

  await openMore(page)
  await page.getByRole('combobox', { name: 'Sort by' }).selectOption('expiry')
  expect(searchOf(page)).toContain('sort=expiry')
  const sorted = await namesOn(page)
  expect(sorted).not.toEqual(before)
  expect([...sorted].sort()).toEqual([...before].sort())

  await openLength(page)
  await page.getByRole('spinbutton', { name: 'Shortest label length' }).fill('5')
  await expect(matchCount(page)).toHaveText('8 names')
  await expect.poll(() => searchOf(page)).toContain('min=5')
})

test('invalid length state is explained only inside Data and survives history', async ({
  page,
}) => {
  await visit(page, { view: 'all', min: '9', max: '5' })
  await expect(page.locator('.discovery').getByText(/Length range not applied/)).toHaveCount(0)

  let drawer = await openData(page)
  await expect(drawer).toContainText('Length range not applied: shortest 9 is above longest 5.')
  await drawer.getByRole('button', { name: 'Close Data' }).click()

  await openMore(page)
  await page.getByRole('combobox', { name: 'Sort by' }).selectOption('expiry')
  await page.goBack()
  drawer = await openData(page)
  await expect(drawer).toContainText('Length range not applied: shortest 9 is above longest 5.')
})

test('a half-typed bound reports itself in Data and clears cleanly', async ({ page }) => {
  await visit(page, { view: 'all' })
  await openLength(page)
  const box = page.getByRole('spinbutton', { name: 'Shortest label length' })
  await box.press('e')

  expect(
    await box.evaluate((node: HTMLInputElement) => ({
      value: node.value,
      badInput: node.validity.badInput,
    })),
  ).toEqual({ value: '', badInput: true })
  let drawer = await openData(page)
  await expect(drawer).toContainText(
    'Shortest length not applied: this box needs a whole number from 1 to 64.',
  )
  await drawer.getByRole('button', { name: 'Close Data' }).click()

  await box.fill('')
  drawer = await openData(page)
  await expect(drawer.getByText('Not applied')).toHaveCount(0)
  await expect(box).toHaveAttribute('aria-invalid', 'false')
  await expect(page.locator('.name-cell')).toHaveCount(24)
})

test('the preview clock is terse in the strip and removable through Data', async ({ page }) => {
  await visit(page)
  await expect(page.locator('.snapshot-strip')).toContainText('Preview')
  await expect(page.locator('.snapshot-strip')).toContainText('Mar 1')
  await expect(page.getByText('Preview clock')).toHaveCount(0)

  const drawer = await openData(page)
  await drawer.getByRole('link', { name: 'Use the real time instead' }).click()
  expect(searchOf(page)).not.toContain('now=')
  await expect(page.getByRole('dialog', { name: 'Data' })).toHaveCount(0)
})
