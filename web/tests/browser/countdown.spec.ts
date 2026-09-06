import { expect, test } from '@playwright/test'
import { DAY, SCANNED_AT, SECOND, visit } from './support'

/**
 * The countdown, watched while time passes.
 *
 * The clock is Playwright's, not the machine's, so "a second later" is exact and
 * the test does not wait on real time. That matters twice over: a real-clock test
 * would be slow and flaky, and the committed fixture is fixed in the past, so a
 * real-clock run would find every boundary already behind it.
 *
 * What is being checked is presentation only. A countdown reaching zero must not
 * change a published status, because only a later scan can say a name moved on.
 */

/** `400d 00:00:00` and `03:00:00` alike, as a number of seconds. */
function toSeconds(text: string): number {
  const match = /^(?:(\d+)d )?(\d+):(\d{2}):(\d{2})$/.exec(text.trim())
  expect(match, `unreadable countdown "${text}"`).not.toBeNull()
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match ?? []
  return Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
}

test('the value counts down in real time without touching the status', async ({ page }) => {
  await page.clock.install({ time: new Date(SCANNED_AT) })
  // No `?now`, so the page reads the live clock, which is now the one under control.
  // `view=all`, because the name under test is registered and the page opens on the
  // available view.
  await page.goto('/?view=all')

  const row = page.getByRole('row').filter({ hasText: 'quill.eth' })
  const value = row.locator('.countdown__value')

  /*
   * Paused before the first sample, because `install` alone still lets time flow.
   * The value re-renders once a second, so a real second passing between the two
   * reads took its own second off the countdown as well, and the difference came
   * out as six. Pausing makes the fast-forward the only thing that moves the
   * clock. The instant comes from the page rather than from `SCANNED_AT`, because
   * a clock may only ever be moved forward and the page is already past the
   * instant it was installed at. It is five seconds ahead of the read, not one:
   * `pauseAt` throws outright on a target the clock has already passed, so a round
   * trip slower than the cushion would fail the run rather than measure the wrong
   * number. Which instant it pauses at does not matter, because both samples below
   * are taken after the pause.
   */
  const loaded = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(new Date(loaded + 5 * SECOND))

  const before = toSeconds((await value.textContent()) ?? '')
  await page.clock.fastForward(5 * SECOND)

  const after = toSeconds((await value.textContent()) ?? '')
  expect(before - after).toBe(5)
  // The status is what the scan recorded and does not move because time did.
  await expect(row).toContainText('Registered')
})

test('the ticking value is hidden from a screen reader, which gets words instead', async ({
  page,
}) => {
  await visit(page, { view: 'all' })

  const row = page.getByRole('row').filter({ hasText: 'quill.eth' })
  // A value that changes every second, announced fifty times a second on one
  // page, would make the table unusable.
  await expect(row.locator('.countdown__value')).toHaveAttribute('aria-hidden', 'true')
  await expect(row).toHaveAccessibleName(/registration expires in/)
})

test('a boundary already behind the scan says so instead of showing zeroes', async ({ page }) => {
  await page.clock.install({ time: new Date(SCANNED_AT) })
  // `view=all`, because the name under test is in its grace period, and no `?now`,
  // so the page reads the clock installed above.
  await page.goto('/?view=all')

  const row = page.getByRole('row').filter({ hasText: 'flux.eth' })
  await expect(row).toContainText('grace period ends')

  // Three days on, the recorded grace end has passed on this device's clock.
  await page.clock.fastForward(3 * DAY)

  await expect(row).toContainText('grace period ended')
  await expect(row).toContainText('This moment has passed since the scan')
  // And the published status is still the published status.
  await expect(row).toContainText('Grace ending soon')
})
