import { expect, test, type Locator } from '@playwright/test'
import { scrollsSideways, visit } from './support'

/**
 * Responsive layout, checked at each configured viewport.
 *
 * These are the assertions a screenshot cannot make. Every one of them started as
 * something that was actually wrong on this page at 320px: the document scrolled
 * sideways, two of the five view links were off-screen behind a scroll nobody was
 * told about, and names were broken mid-token to make room for the columns beside
 * them. A unit test in jsdom cannot see any of it, because jsdom has no layout.
 */

/** Whether every part of this element is inside the viewport horizontally. */
async function fitsHorizontally(locator: Locator): Promise<boolean> {
  const box = await locator.boundingBox()
  if (box === null) {
    return false
  }
  const width = await locator.page().evaluate(() => document.documentElement.clientWidth)
  return box.x >= 0 && box.x + box.width <= width + 0.5
}

test('the page never scrolls sideways, on any view', async ({ page }) => {
  for (const view of ['all', 'available', 'premium', 'expiring', 'grace']) {
    await visit(page, view === 'all' ? {} : { view })
    expect(await scrollsSideways(page), `the ${view} view scrolls sideways`).toBe(false)
  }
})

test('nothing is laid out wider than the box that holds it', async ({ page }) => {
  await visit(page)

  /*
   * The check the scroll test cannot make on a phone. A mobile context honours the
   * viewport meta tag, so Chrome answers content that is too wide by zooming the
   * page out rather than scrolling it, and `scrollsSideways` reports nothing wrong.
   * An element wider than its own parent is the same fault stated in a way no
   * viewport trick can hide, and it names the element instead of the symptom.
   */
  const overflowing = await page.evaluate(() => {
    const found: string[] = []
    for (const node of document.querySelectorAll('.page *')) {
      const parent = node.parentElement
      if (parent === null) {
        continue
      }
      const box = node.getBoundingClientRect()
      const outer = parent.getBoundingClientRect()
      // Half a pixel of slack for sub-pixel rounding, and negative margins are
      // deliberate, so only a real excess counts.
      if (box.width > outer.width + 0.5 && getComputedStyle(node).marginLeft.startsWith('-')) {
        continue
      }
      if (box.width > outer.width + 0.5) {
        found.push(
          // The attribute rather than `className`, which is an object on an SVG
          // element and would name the offender `[object SVGAnimatedString]`.
          `${node.tagName.toLowerCase()}.${node.getAttribute('class') ?? ''} is ${String(Math.round(box.width))}px inside ${String(Math.round(outer.width))}px`,
        )
      }
    }
    return found
  })

  expect(overflowing).toEqual([])
})

test('the page does not scroll sideways with the longest strings on it', async ({ page }) => {
  // The widest cell content in the fixture is a four-hundred-day countdown beside
  // the "Grace ending soon" pill, and the widest heading is the source-list path.
  await visit(page, { sort: 'expiry', dir: 'desc' })
  expect(await scrollsSideways(page)).toBe(false)
})

test('every view is visible without a swipe', async ({ page }) => {
  await visit(page)

  const links = page.getByRole('navigation', { name: 'Views' }).getByRole('link')
  await expect(links).toHaveCount(5)

  for (const link of await links.all()) {
    // A link that sits outside the viewport is unreachable on a touch device,
    // which draws no scrollbar to say that anything is hidden.
    expect(await fitsHorizontally(link), `${(await link.textContent()) ?? ''} is clipped`).toBe(
      true,
    )
  }
})

test('the table keeps its roles rather than becoming a list of blocks', async ({ page }) => {
  await visit(page)

  const table = page.getByRole('table')
  await expect(table).toBeVisible()
  await expect(table.getByRole('columnheader')).toHaveCount(3)
  // Ten names in the fixture, each with its own row header.
  await expect(table.getByRole('rowheader')).toHaveCount(10)
})

test('a name is never broken across two lines to make room for the columns', async ({ page }) => {
  await visit(page)

  // The visible label, not the whole link: the link also carries a visually hidden
  // announcement, which is out of flow and would count as a second line on its own.
  const names = page.getByRole('table').locator('.ens-link .mono')
  await expect(names).toHaveCount(10)
  for (const name of await names.all()) {
    const lines = await name.evaluate((node) => node.getClientRects().length)
    expect(lines, `${(await name.textContent()) ?? ''} is broken over ${String(lines)} lines`).toBe(
      1,
    )
  }
})

test('a recorded instant breaks only between its date and its clock time', async ({ page }) => {
  await visit(page)

  /*
   * One string left to itself breaks after every `-` and every `:`, so at phone
   * width `2026-03-04 12:00:00 UTC` became four lines and every row grew to
   * match. Two lines is the most it may take: one for the date, one for the
   * clock, and no break inside either.
   */
  const stamps = page.getByRole('table').locator('.countdown__at time')
  expect(await stamps.count()).toBeGreaterThan(0)
  for (const stamp of await stamps.all()) {
    // Distinct tops, not the number of rects. An inline element reports one rect
    // per box fragment, and this one has two child spans, so a single line
    // already answers three. What a line costs is vertical space.
    const lines = await stamp.evaluate(
      (node) => new Set([...node.getClientRects()].map((rect) => Math.round(rect.top))).size,
    )
    expect(
      lines,
      `${(await stamp.textContent()) ?? ''} is broken over ${String(lines)} lines`,
    ).toBeLessThanOrEqual(2)
  }
})

test('the summary counts share their rows rather than stacking one per row', async ({ page }) => {
  await visit(page)

  /*
   * `auto-fit` answers a track it cannot fit by dropping to a single column, and
   * it does so silently: at 320px three pixels of shortfall turned all seven
   * counts into seven full-width rows. Counting the rows says the track still
   * fits at this width without pinning the exact packing, which is allowed to
   * differ from one viewport to the next.
   */
  const rows = await page.locator('.counts').evaluate((grid) => {
    const tops = new Set<number>()
    for (const card of grid.children) {
      tops.add(Math.round(card.getBoundingClientRect().top))
    }
    return tops.size
  })

  // Seven statuses. Seven rows would mean one per row, and four would mean two
  // per row with the last alone, which is as thin as the narrowest viewport gets.
  expect(rows).toBeLessThanOrEqual(4)
})

test('the filter controls stay inside the page', async ({ page }) => {
  await visit(page)

  const region = page.getByRole('region', { name: 'Narrow the list' })
  for (const control of await region.locator('input, select, button').all()) {
    expect(await fitsHorizontally(control)).toBe(true)
  }
})
