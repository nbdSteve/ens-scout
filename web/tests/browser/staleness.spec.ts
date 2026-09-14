import { expect, test } from '@playwright/test'
import { DAY, HOUR, openData, since, visit } from './support'

const DAILY = 'data/words/5-letters.txt'
const FOUR_LETTERS = 'data/words/4-letters.txt'
const THREE_HOURLY = [FOUR_LETTERS, 'data/words/3-letters.txt']

test('all five preview sources are on schedule at the scan instant', async ({ page }) => {
  await visit(page)
  await expect(page.locator('.snapshot-badge')).not.toContainText('Stale')

  const drawer = await openData(page)
  await expect(drawer.getByText('On schedule', { exact: true })).toHaveCount(5)
  await expect(drawer.getByText('Out of date', { exact: true })).toHaveCount(0)
  await expect(drawer.getByRole('alert')).toHaveCount(0)
})

test('only the two three-hourly lists warn after eight hours', async ({ page }) => {
  await visit(page, { now: since(8 * HOUR) })
  await expect(page.locator('.snapshot-badge')).toContainText('Stale')

  const drawer = await openData(page)
  const alert = drawer.getByRole('alert')
  await expect(alert).toContainText('2 source lists are out of date')
  for (const path of THREE_HOURLY) {
    await expect(alert).toContainText(path)
  }
  await expect(alert).not.toContainText(DAILY)
  await expect(drawer.getByText('Out of date', { exact: true })).toHaveCount(2)
  await expect(drawer.getByText('On schedule', { exact: true })).toHaveCount(3)
})

test('each source is measured from its own last scan', async ({ page }) => {
  await visit(page, { now: since(30 * HOUR) })
  const drawer = await openData(page)

  await expect(drawer.getByRole('alert')).toContainText(
    `${DAILY} is scanned every 24 hours and is overdue by 2 hours.`,
  )
  const sources = drawer.getByRole('list', { name: 'Source lists' }).getByRole('listitem')
  await expect(sources.filter({ hasText: DAILY })).toContainText(
    'Last scanned 2026-02-28 16:00:00 UTC',
  )
  await expect(sources.filter({ hasText: FOUR_LETTERS })).toContainText(
    'Last scanned 2026-03-01 12:00:00 UTC',
  )
})

test('staleness never withholds the names', async ({ page }) => {
  await visit(page, { now: since(3 * DAY), view: 'all' })

  await expect(page.locator('.name-cell')).toHaveCount(24)
  const drawer = await openData(page)
  await expect(drawer.getByRole('alert')).toContainText('5 source lists are out of date')
  await expect(drawer.getByRole('alert')).toContainText('Treat every status below as history')
})
