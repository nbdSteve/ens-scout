import { expect, test, type Page } from '@playwright/test'
import { openMore, searchOf, visit } from './support'

/**
 * The page driven by the keyboard alone.
 *
 * None of this can be checked in jsdom: sequential focus, whether a focus ring is
 * actually drawn, and whether a skip link is on screen once it is focused are all
 * questions about layout and about the browser's own focus model.
 */

/** What is focused now, as a short label, plus whether a focus ring is drawn. */
async function focused(page: Page): Promise<{ label: string; ringed: boolean } | null> {
  return page.evaluate(() => {
    const element = document.activeElement
    if (element === null || element === document.body) {
      return null
    }
    const style = getComputedStyle(element)
    const outline = style.outlineStyle === 'none' ? 0 : Number.parseFloat(style.outlineWidth)
    return {
      label: `${element.tagName}:${(element.getAttribute('aria-label') ?? element.textContent).trim().slice(0, 48)}`,
      // Either mechanism counts. What must not happen is a stop with neither,
      // which leaves a keyboard user with no idea where they are.
      ringed: outline > 0 || style.boxShadow !== 'none',
    }
  })
}

test('the first tab stop is the skip link, and it leads to the names', async ({ page }) => {
  await visit(page)
  await page.keyboard.press('Tab')

  const skip = page.getByRole('link', { name: 'Skip to the names' })
  await expect(skip).toBeFocused()
  // It is hidden until focused, so the one thing it must do is appear.
  await expect(skip).toBeInViewport()

  await skip.press('Enter')
  await expect(page).toHaveURL(/#results$/)
  await expect(page.locator('#results')).toBeInViewport()

  /*
   * The next stop is at the names or past them, never back at the top of the page.
   * Stated as document order rather than as "a link inside the results", because what
   * is focusable in there depends on the build: a deployment with a verifier offers a
   * tick box per row, and this one, with no read API, offers nothing at all. The
   * requirement is the same either way - the skip link must not be undone by the next
   * key press - and document order is what expresses it.
   */
  await page.keyboard.press('Tab')
  const wentForward = await page.evaluate(() => {
    const results = document.querySelector('#results')
    const target = document.activeElement
    if (results === null || target === null) {
      return false
    }
    // `CONTAINED_BY` is the verifier build, `FOLLOWING` this one. Both are forward.
    const where = results.compareDocumentPosition(target)
    return (
      (where & Node.DOCUMENT_POSITION_CONTAINED_BY) !== 0 ||
      (where & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    )
  })
  expect(wentForward, 'the stop after the skip link is before the names').toBe(true)
})

test('every keyboard stop draws a focus indicator', async ({ page }) => {
  await visit(page, { view: 'all' })

  /*
   * Opened, because a closed disclosure is one stop rather than eleven and the controls
   * inside it are the ones most likely to be styled by hand.
   *
   * Opened by setting the property the browser owns, not by clicking the summary the way
   * `openMore` does. A click leaves that summary as the sequential focus navigation
   * starting point, which blurring does not clear, so the walk below would begin in the
   * middle of the toolbar and never reach the skip link or the views - and its count
   * would then be made of whatever follows, which is how it came to rest on rows being
   * links. The gesture is covered by the test below; what this one needs is the state.
   */
  await page
    .locator('details')
    .filter({ has: page.locator('summary').filter({ hasText: 'More filters' }) })
    .evaluate((node: HTMLDetailsElement) => {
      node.open = true
    })

  const seen: string[] = []
  for (let step = 0; step < 200; step += 1) {
    await page.keyboard.press('Tab')
    const current = await focused(page)
    // Focus left the document, or wrapped back round to the skip link. Stopping on
    // any repeated label would end the walk early instead: a shared label is not
    // evidence that the walk has come round, and stops here do share one.
    if (current === null || (seen.length > 0 && current.label === seen[0])) {
      break
    }
    seen.push(current.label)
    expect(current.ringed, `${current.label} has no focus indicator`).toBe(true)
  }

  // Guards against the loop ending early and passing vacuously. The skip link, the three
  // links in the lines above the tabs, the five views, the three visible filters, the two
  // disclosures, the ten controls inside the opened one, and the link out of the closed
  // one come to more than twenty, none of them a row.
  expect(seen.length).toBeGreaterThan(20)
})

test('the filter controls are reached in the order they are shown', async ({ page }) => {
  // `view=all` for the seven-status list, and so `Registered (2)` exists to be the
  // first checkbox. The order under test is the same in every view.
  await visit(page, { view: 'all' })

  const search = page.getByRole('searchbox', { name: 'Search names' })
  await search.focus()

  // The two lengths, then the one control that stands for everything else. Nothing
  // inside the disclosure is reachable while it is closed, which is the point of
  // putting it there: the visible row costs four stops rather than fourteen.
  const visible = [
    page.getByRole('spinbutton', { name: 'Shortest label length' }),
    page.getByRole('spinbutton', { name: 'Longest label length' }),
    // The element, not a role: browsers disagree on what a `<summary>` is called in
    // the accessibility tree, and what is under test here is the tab order.
    page.locator('summary').filter({ hasText: 'More filters' }),
  ]
  for (const control of visible) {
    await page.keyboard.press('Tab')
    await expect(control).toBeFocused()
  }

  // Opened from the keyboard, on the summary that already has focus, because that
  // is how a visitor who got here by tabbing would open it.
  await page.keyboard.press('Enter')

  const hidden = [
    page.getByRole('combobox', { name: 'Source list' }),
    page.getByRole('combobox', { name: 'Sort by' }),
    page.getByRole('button', { name: /A to Z/ }),
    page.getByRole('checkbox', { name: 'Registered (2)' }),
  ]
  for (const control of hidden) {
    await page.keyboard.press('Tab')
    await expect(control).toBeFocused()
  }
})

test('the sort direction is a real button, toggled from the keyboard', async ({ page }) => {
  await visit(page)
  await openMore(page)

  const direction = page.getByRole('button', { name: /A to Z/ })
  await direction.focus()
  await page.keyboard.press('Enter')

  await expect(page.getByRole('button', { name: /Z to A/ })).toBeFocused()
  expect(searchOf(page)).toContain('dir=desc')
})

test('a status is ticked with the space bar and written to the address bar', async ({ page }) => {
  /*
   * `view=all`, because a status filter that covers the whole view is the same as no
   * filter and `parseQuery` normalizes it away. Ticking `Available` inside the
   * available view would therefore write `status=available`, have it read back as
   * nothing, and untick itself - correctly. The behaviour under test is the space
   * bar reaching the address bar, so it is checked where the tick survives.
   */
  await visit(page, { view: 'all' })
  await openMore(page)

  const available = page.getByRole('checkbox', { name: 'Available (2)' })
  await available.focus()
  await page.keyboard.press('Space')

  await expect(available).toBeChecked()
  expect(searchOf(page)).toContain('status=available')
  await expect(page.getByRole('table').getByRole('rowheader')).toHaveCount(2)
})

test.describe('with reduced motion asked for', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } })

  test('nothing on the page animates or transitions perceptibly', async ({ page }) => {
    await visit(page)

    /*
     * Not zero. The conventional reduced-motion reset sets a duration of 0.01ms
     * rather than 0s, because a zero duration cancels the `transitionend` and
     * `animationend` events some scripts wait on. What the requirement forbids is
     * motion a visitor can see, so the threshold is a perceptible one.
     */
    const moving = await page.locator('body *').evaluateAll((nodes) =>
      nodes
        .filter((node) => {
          const style = getComputedStyle(node)
          const durations = [style.transitionDuration, style.animationDuration]
          return durations.some((value) =>
            value.split(',').some((part) => Number.parseFloat(part) * 1000 >= 10),
          )
        })
        .map((node) => node.tagName.toLowerCase())
        .slice(0, 5),
    )

    expect(moving).toEqual([])
  })
})
