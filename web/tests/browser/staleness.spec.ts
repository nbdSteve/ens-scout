import { expect, test } from '@playwright/test'
import { DAY, HOUR, openDetails, since, visit } from './support'

/**
 * Staleness, resolved per source list.
 *
 * The `preview` fixture scans three lists on two cadences: `5-letters.txt` daily,
 * and `4-letters.txt` and `3-letters.txt` every three hours. A snapshot-wide flag
 * would call the whole thing fresh or the whole thing stale; the contract instead
 * publishes each list's own window and lets the client resolve it against its own
 * clock. Eight hours after the scan is the case that separates the two: the
 * three-hourly lists have missed more than one scan and the daily one has not.
 *
 * Each window is measured from that list's own last-scanned instant, not from the
 * snapshot-wide scan time. The fixture holds both cases: the two three-hourly lists
 * were scanned at the snapshot's own instant, and the daily list was carried forward
 * from twenty hours before it, which is the shape a stopped schedule leaves behind.
 *
 * The per-list verdict is a badge in the scan details, which is a disclosure, so
 * every test that counts badges opens it first. The banner is not: a snapshot a
 * visitor should not trust says so where they cannot miss it.
 */

const DAILY = 'data/words/5-letters.txt'
const FOUR_LETTERS = 'data/words/4-letters.txt'
const THREE_HOURLY = [FOUR_LETTERS, 'data/words/3-letters.txt']

test('nothing warns while every list is inside its own window', async ({ page }) => {
  await visit(page)
  await openDetails(page)

  const fresh = page.getByText('On schedule', { exact: true })
  await expect(fresh).toHaveCount(3)
  // Rendered and on screen, not merely present: a count alone would pass on badges
  // the disclosure was still hiding.
  await expect(fresh.first()).toBeVisible()
  await expect(page.getByText('Out of date', { exact: true })).toHaveCount(0)
  // No banner at all, rather than a banner saying everything is fine. A warning
  // that is always there is a warning nobody reads.
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('only the lists that missed a scan are called out', async ({ page }) => {
  await visit(page, { now: since(8 * HOUR) })

  const alert = page.getByRole('alert')
  await expect(alert).toContainText('2 source lists are out of date')
  for (const path of THREE_HOURLY) {
    await expect(alert).toContainText(path)
  }
  // The daily list was carried from twenty hours before the scan, so it is
  // twenty-eight hours into its own forty-eight hour window.
  await expect(alert).not.toContainText(DAILY)

  await openDetails(page)
  await expect(page.getByText('Out of date', { exact: true })).toHaveCount(2)
  await expect(page.getByText('On schedule', { exact: true })).toHaveCount(1)
})

test('a list is measured from its own scan, not from the one that published it', async ({
  page,
}) => {
  /*
   * Thirty hours after the snapshot-wide scan, which is the case a snapshot-wide
   * instant got wrong. The daily list was really scanned fifty hours ago, so it is
   * two hours past its own forty-eight hour window; measured from the scan that
   * published it, it would be thirty hours old and eighteen hours inside that window,
   * and the page would have called a stopped schedule on schedule.
   */
  await visit(page, { now: since(30 * HOUR) })

  const alert = page.getByRole('alert')
  await expect(alert).toContainText(`${DAILY} is scanned every 24 hours and is overdue by 2 hours.`)

  await openDetails(page)
  const tiles = page.getByRole('list', { name: 'Source lists' }).getByRole('listitem')
  // Its own instant, beside the figure derived from it.
  const daily = tiles.filter({ hasText: DAILY })
  await expect(daily).toContainText('Last scanned 2026-02-28 16:00:00 UTC')
  await expect(daily).toContainText('Overdue by 2 hours.')
  // And a list in the same snapshot that really was scanned at the snapshot's own
  // instant states that one, so the two are per list rather than shared.
  await expect(tiles.filter({ hasText: FOUR_LETTERS })).toContainText(
    'Last scanned 2026-03-01 12:00:00 UTC',
  )
})

test('the daily list joins them once it has missed a scan too', async ({ page }) => {
  await visit(page, { now: since(3 * DAY) })

  const alert = page.getByRole('alert')
  await expect(alert).toContainText('3 source lists are out of date')
  await expect(alert).toContainText(DAILY)

  await openDetails(page)
  await expect(page.getByText('On schedule', { exact: true })).toHaveCount(0)
})

test('the warning is coarse, so a live region does not re-announce every second', async ({
  page,
}) => {
  await visit(page, { now: since(8 * HOUR) })

  const alert = page.getByRole('alert')
  await expect(alert).toContainText(/overdue by \d+ hours?\./)
  // No seconds anywhere in it.
  await expect(alert).not.toContainText(/\d{2}:\d{2}:\d{2}/)
})

test('the rows are still shown, because history is not nothing', async ({ page }) => {
  // Every name, so the count says the stale snapshot was withheld from none of them.
  await visit(page, { now: since(3 * DAY), view: 'all' })

  await expect(page.getByRole('table').getByRole('rowheader')).toHaveCount(10)
  await expect(page.getByRole('alert')).toContainText('Treat every status below as history')
})
