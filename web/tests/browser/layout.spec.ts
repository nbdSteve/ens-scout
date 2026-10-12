import { expect, test, type Locator } from '@playwright/test'
import {
  SCANNED_AT,
  openData,
  openLength,
  openMore,
  scrollsSideways,
  visit,
  visitFeatured,
} from './support'

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

function featuredNames(page: import('@playwright/test').Page): Locator {
  return page.locator('.featured-name:visible')
}

test('the canonical route opens on the curated hero at every required viewport', async ({
  page,
}, testInfo) => {
  await visitFeatured(page)

  const expected: Readonly<Record<string, number>> = {
    desktop: 12,
    tablet: 12,
    mobile: 7,
    narrow: 7,
  }
  await expect(featuredNames(page)).toHaveCount(expected[testInfo.project.name] ?? 0)
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName(
    'The good ones are still out there.',
  )
  await expect(page.getByRole('link', { name: /Explore all 16/ })).toBeInViewport()
  await expect(page.getByRole('button', { name: 'Select names to check' })).toBeInViewport()

  for (const name of await featuredNames(page).all()) {
    await expect(name).toBeInViewport({ ratio: 1 })
  }
  expect(await scrollsSideways(page)).toBe(false)
})

test('a 200 percent zoom-equivalent viewport reflows without clipping the hero', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one desktop zoom-equivalent assertion is enough')
  await page.setViewportSize({ width: 720, height: 450 })
  await visitFeatured(page)

  await expect(featuredNames(page)).toHaveCount(12)
  const hero = await page.locator('.featured-hero').boundingBox()
  expect(hero).not.toBeNull()
  expect(hero?.height ?? 0).toBeGreaterThanOrEqual(720)
  expect(await scrollsSideways(page)).toBe(false)

  const explore = page.getByRole('link', { name: /Explore all 16/ })
  await explore.focus()
  await expect(explore).toBeFocused()
  await expect(explore).toBeInViewport()
})

test('rank one is visually dominant and no lower tier crosses its ceiling', async ({ page }) => {
  await visitFeatured(page)
  const sizes = await featuredNames(page).evaluateAll((nodes) =>
    nodes.map((node) => ({
      rank: Number.parseInt(node.getAttribute('data-rank') ?? '0', 10),
      tier: node.getAttribute('data-tier'),
      size: Number.parseFloat(
        getComputedStyle(node.querySelector('.featured-name__label') ?? node).fontSize,
      ),
    })),
  )
  const first = sizes.find(({ rank }) => rank === 1)
  expect(first).toBeDefined()
  expect(
    sizes.every(({ rank, size }) => rank === 1 || size < (first?.size ?? Number.NEGATIVE_INFINITY)),
  ).toBe(true)

  const tierMaximum = new Map<string, number>()
  for (const { tier, size } of sizes) {
    if (tier !== null) {
      tierMaximum.set(tier, Math.max(tierMaximum.get(tier) ?? 0, size))
    }
  }
  expect(tierMaximum.get('dominant') ?? 0).toBeGreaterThan(tierMaximum.get('anchor') ?? 0)
  expect(tierMaximum.get('anchor') ?? 0).toBeGreaterThan(tierMaximum.get('supporting') ?? 0)
})

test('ranking arrival replaces reserved geometry without moving discovery', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one geometry assertion covers the shared shell')
  let release = (): void => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/data/og-rank-v1.json', async (route) => {
    const response = await route.fetch()
    await held
    await route.fulfill({ response })
  })
  await page.clock.setFixedTime(SCANNED_AT)
  await page.goto('/')
  await expect(page.locator('.featured-map__skeleton')).toHaveCount(12)
  await expect(page.locator('#page-title')).toBeAttached()
  const before = await page.locator('#page-title').boundingBox()

  release()
  await expect(page.locator('.featured-name')).toHaveCount(12)
  const after = await page.locator('#page-title').boundingBox()

  expect(before).not.toBeNull()
  expect(after).not.toBeNull()
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(0.5)
})

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

test('long synthetic featured labels stay inside their controls', async ({ page }) => {
  await visitFeatured(page)
  const names = featuredNames(page)
  await names
    .nth(0)
    .locator('.featured-name__label > span')
    .first()
    .evaluate((node) => {
      node.textContent = 'y'.repeat(32)
    })
  await names
    .nth(1)
    .locator('.featured-name__label > span')
    .first()
    .evaluate((node) => {
      node.textContent = 'z'.repeat(64)
    })

  for (const index of [0, 1]) {
    const contained = await names.nth(index).evaluate((node) => {
      const control = node.querySelector('.featured-name__control')?.getBoundingClientRect()
      const label = node.querySelector('.featured-name__label')
      if (control === undefined || label === null) {
        return false
      }
      return [...label.getClientRects()].every(
        (rect) => rect.left >= control.left - 0.5 && rect.right <= control.right + 0.5,
      )
    })
    expect(contained, `synthetic featured label ${String(index + 1)} escaped`).toBe(true)
  }
  expect(await scrollsSideways(page)).toBe(false)
})

test('each required viewport can be captured without overflow', async ({ page }, testInfo) => {
  await visitFeatured(page)
  expect(await scrollsSideways(page)).toBe(false)
  await testInfo.attach(`ens-og-hero-${testInfo.project.name}`, {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  })
})
