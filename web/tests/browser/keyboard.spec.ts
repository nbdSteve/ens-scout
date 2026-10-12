import { expect, test, type Page } from '@playwright/test'
import { openData, scrollsSideways, searchOf, visit, visitFeatured } from './support'

async function bloom(page: Page): Promise<{ opacity: string; transform: string }> {
  return page
    .locator('.name-cell')
    .first()
    .evaluate((node) => {
      const style = getComputedStyle(node, '::before')
      return { opacity: style.opacity, transform: style.transform }
    })
}

test('the skip link is first and lands on the name field', async ({ page }) => {
  await visit(page)
  await page.keyboard.press('Tab')

  const skip = page.getByRole('link', { name: 'Skip to the names' })
  await expect(skip).toBeFocused()
  await expect(skip).toBeInViewport()
  await skip.press('Enter')
  await expect(page).toHaveURL(/#page-title$/)
  await expect(page.locator('#page-title')).toBeFocused()
  await expect(page.locator('#page-title')).toBeInViewport()
})

test('the canonical skip link and Explore action focus the discovery heading', async ({ page }) => {
  await visitFeatured(page)
  await page.keyboard.press('Tab')

  const skip = page.getByRole('link', { name: 'Skip featured names' })
  await expect(skip).toBeFocused()
  await skip.press('Enter')
  await expect(page.locator('#page-title')).toBeFocused()
  await expect(page.locator('#page-title')).toBeInViewport()

  await page.evaluate(() => {
    window.scrollTo(0, 0)
  })
  await page.getByRole('link', { name: /Explore all 16/ }).click()
  await expect(page.locator('#page-title')).toBeFocused()
  await expect(page.locator('#page-title')).toBeInViewport()
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
})

test('the Data drawer traps focus, closes with Escape, and restores its opener', async ({
  page,
}) => {
  await visit(page)
  const opener = page.getByRole('button', { name: 'Data', exact: true })
  await opener.focus()
  await opener.press('Enter')

  const drawer = page.getByRole('dialog', { name: 'Data' })
  await expect(drawer).toBeVisible()
  const close = drawer.getByRole('button', { name: 'Close Data' })
  await expect(close).toBeFocused()

  const last = drawer.getByRole('link').last()
  await page.keyboard.press('Shift+Tab')
  await expect(last).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(close).toBeFocused()

  await last.focus()
  await page.keyboard.press('Tab')
  await expect(close).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(opener).toBeFocused()
})

test('Length and More open from the keyboard and keep URL-backed controls usable', async ({
  page,
}) => {
  await visit(page, { view: 'all' })

  const length = page.locator('summary').filter({ hasText: 'Length' })
  await length.focus()
  await page.keyboard.press('Enter')
  const shortest = page.getByRole('spinbutton', { name: 'Shortest label length' })
  await shortest.fill('4')
  await expect.poll(() => searchOf(page)).toContain('min=4')

  const more = page.locator('summary').filter({ hasText: 'More' })
  await more.focus()
  await page.keyboard.press('Enter')
  const available = page.getByRole('checkbox', { name: /^Available/ })
  await available.focus()
  await page.keyboard.press('Space')
  await expect(available).toBeChecked()
  expect(searchOf(page)).toContain('status=available')
})

test('keyboard focus and pointer hover produce the same name-cell bloom', async ({ page }) => {
  await visit(page)
  const first = page.locator('.name-cell').first()

  await first.hover()
  await page.waitForTimeout(500)
  const hovered = await bloom(page)
  await page.getByRole('heading', { level: 1 }).hover()
  await first.focus()
  await page.waitForTimeout(500)
  const focused = await bloom(page)

  expect(focused).toEqual(hovered)
  const outline = await first.evaluate((node) => {
    const style = getComputedStyle(node)
    return { width: style.outlineWidth, style: style.outlineStyle }
  })
  expect(outline.style).not.toBe('none')
  expect(Number.parseFloat(outline.width)).toBeGreaterThan(0)
})

test('higher contrast and forced colors preserve focus, labels, and reflow', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one media-emulation assertion is enough')
  await page.emulateMedia({ contrast: 'more', forcedColors: 'active' })
  await visitFeatured(page)

  await expect(page.locator('.featured-name:visible')).toHaveCount(12)
  const explore = page.getByRole('link', { name: /Explore all 16/ })
  await explore.focus()
  await expect(explore).toBeFocused()
  const focus = await explore.evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      color: style.color,
      background: style.backgroundColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    }
  })
  expect(focus.color).not.toBe(focus.background)
  expect(focus.outlineStyle).not.toBe('none')
  expect(Number.parseFloat(focus.outlineWidth)).toBeGreaterThan(0)
  expect(await scrollsSideways(page)).toBe(false)
})

test.describe('with reduced motion requested', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } })

  test('motion is disabled while every interaction still works', async ({ page }) => {
    await visit(page)

    const moving = await page.locator('body *').evaluateAll((nodes) =>
      nodes
        .filter((node) => {
          const style = getComputedStyle(node)
          return [style.transitionDuration, style.animationDuration].some((value) =>
            value.split(',').some((part) => Number.parseFloat(part) * 1000 >= 10),
          )
        })
        .map((node) => node.tagName.toLowerCase()),
    )
    expect(moving).toEqual([])

    const field = page.locator('.name-field')
    const before = await field.getAttribute('style')
    await page.mouse.move(100, 500)
    await page.waitForTimeout(50)
    expect(await field.getAttribute('style')).toBe(before)

    await openData(page)
    await expect(page.getByRole('dialog', { name: 'Data' })).toBeVisible()
  })

  test('the hero has no entry or pointer-following motion and hands off immediately', async ({
    page,
  }) => {
    await visitFeatured(page)
    const map = page.locator('.featured-map')
    const before = await map.getAttribute('style')
    const box = await map.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move((box?.x ?? 0) + 40, (box?.y ?? 0) + 40)
    await page.waitForTimeout(50)
    expect(await map.getAttribute('style')).toBe(before)

    const animated = await page.locator('.featured-hero *').evaluateAll((nodes) =>
      nodes
        .filter((node) => {
          const style = getComputedStyle(node)
          return Number.parseFloat(style.animationDuration) * 1000 >= 10
        })
        .map((node) => node.getAttribute('class') ?? node.tagName.toLowerCase()),
    )
    expect(animated).toEqual([])

    await page.getByRole('link', { name: /Explore all 16/ }).click()
    await expect(page.locator('#page-title')).toBeFocused()
    await expect(page.locator('#page-title')).toBeInViewport()
  })
})
