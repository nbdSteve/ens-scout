import { expect, test, type Locator } from '@playwright/test'
import { openData, openLength, openMore, scrollsSideways, visit } from './support'

async function fitsViewport(locator: Locator): Promise<boolean> {
  const box = await locator.boundingBox()
  if (box === null) {
    return false
  }
  const viewport = locator.page().viewportSize()
  return viewport !== null && box.x >= 0 && box.x + box.width <= viewport.width + 0.5
}

function cells(page: import('@playwright/test').Page): Locator {
  return page.locator('.name-field > .name-cell')
}

test('the primary path is the Spectrum field, not the rejected dashboard', async ({ page }) => {
  await visit(page)

  await expect(page.getByRole('heading', { level: 1, name: 'Available .eth names' })).toBeVisible()
  await expect(page.getByRole('table')).toHaveCount(0)
  await expect(page.locator('.trustline, .clockline, footer')).toHaveCount(0)
  await expect(page.getByText(/Recorded statuses, not a live check/)).toHaveCount(0)
  await expect(page.getByText(/What happens next/)).toHaveCount(0)
  await expect(cells(page)).toHaveCount(16)
})

test('the document never scrolls sideways in any lifecycle view', async ({ page }) => {
  for (const view of ['available', 'premium', 'expiring', 'grace', 'all']) {
    await visit(page, { view })
    expect(await scrollsSideways(page), `${view} moved the document sideways`).toBe(false)
  }
})

test('the dock, drawer, and their controls stay inside the viewport', async ({ page }) => {
  await visit(page, { view: 'all' })
  await openLength(page)
  await openMore(page)

  for (const control of await page
    .locator('.toolbar input, .toolbar select, .toolbar button')
    .all()) {
    const name =
      (await control.getAttribute('aria-label')) ??
      (await control.getAttribute('id')) ??
      'toolbar control'
    expect(await fitsViewport(control), `${name} is clipped`).toBe(true)
  }

  const drawer = await openData(page)
  expect(await fitsViewport(drawer)).toBe(true)
  expect(await scrollsSideways(page)).toBe(false)
})

test('the field uses three desktop columns, two tablet columns, and one mobile column', async ({
  page,
}, testInfo) => {
  await visit(page)

  const columns = await cells(page).evaluateAll(
    (nodes) =>
      new Set(nodes.slice(0, 6).map((node) => Math.round(node.getBoundingClientRect().left))).size,
  )
  const expected: Readonly<Record<string, number>> = {
    desktop: 3,
    tablet: 2,
    mobile: 1,
    narrow: 1,
  }
  expect(columns).toBe(expected[testInfo.project.name])
})

test('six names are fully visible in the 1440 by 900 first viewport', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop density acceptance criterion')
  await visit(page)

  for (let index = 0; index < 6; index += 1) {
    await expect(
      cells(page).nth(index),
      `name ${String(index + 1)} is below the fold`,
    ).toBeInViewport({ ratio: 1 })
  }
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
})

test('the first name begins above 320px in the 320 by 568 viewport', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'narrow', 'narrow density acceptance criterion')
  await visit(page)

  const first = await cells(page).first().boundingBox()
  expect(first).not.toBeNull()
  expect(first?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(320)
  await expect(cells(page).first()).toBeInViewport()
})

test('the 32 and 64 character preview names remain contained', async ({ page }) => {
  for (const length of [32, 64]) {
    const label = (length === 32 ? 'y' : 'z').repeat(length)
    await visit(page)
    await page.getByRole('searchbox', { name: 'Search names' }).fill(label)
    await expect(cells(page)).toHaveCount(1)

    const containment = await cells(page)
      .first()
      .evaluate((node) => {
        const cell = node.getBoundingClientRect()
        const labelNode = node.querySelector('.name-cell__label')
        if (labelNode === null) {
          return false
        }
        return [...labelNode.getClientRects()].every(
          (rect) => rect.left >= cell.left - 0.5 && rect.right <= cell.right + 0.5,
        )
      })
    expect(containment, `${String(length)}-character name escaped its cell`).toBe(true)
    expect(await scrollsSideways(page)).toBe(false)
  }
})

test('each required viewport can be captured without overflow', async ({ page }, testInfo) => {
  await visit(page)
  expect(await scrollsSideways(page)).toBe(false)
  await testInfo.attach(`ens-spectrum-${testInfo.project.name}`, {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  })
})
