import { expect, test } from '@playwright/test'
import { visit } from './support'

test('name-seeded blooms are deterministic across reloads and varied across names', async ({
  page,
}) => {
  await visit(page)
  const styles = await page
    .locator('.name-cell')
    .evaluateAll((nodes) => nodes.slice(0, 8).map((node) => node.getAttribute('style')))

  expect(new Set(styles).size).toBeGreaterThan(1)
  await page.reload()
  await expect(page.locator('.name-cell')).not.toHaveCount(0)
  expect(
    await page
      .locator('.name-cell')
      .evaluateAll((nodes) => nodes.slice(0, 8).map((node) => node.getAttribute('style'))),
  ).toEqual(styles)
})

test('one requestAnimationFrame-updated light follows the field and resets on exit', async ({
  page,
}) => {
  await visit(page)
  const field = page.locator('.name-field')
  const before = await field.evaluate((node) => ({
    x: getComputedStyle(node).getPropertyValue('--pointer-x').trim(),
    y: getComputedStyle(node).getPropertyValue('--pointer-y').trim(),
  }))

  const box = await field.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) * 0.8, (box?.y ?? 0) + 40)
  await expect
    .poll(() =>
      field.evaluate((node) => ({
        x: node.style.getPropertyValue('--pointer-x'),
        y: node.style.getPropertyValue('--pointer-y'),
      })),
    )
    .not.toEqual({ x: '', y: '' })

  await page.getByRole('heading', { level: 1 }).hover()
  await expect
    .poll(() =>
      field.evaluate((node) => [
        Number.parseFloat(node.style.getPropertyValue('--pointer-x')),
        Number.parseFloat(node.style.getPropertyValue('--pointer-y')),
      ]),
    )
    .toEqual([Number.parseFloat(before.x), Number.parseFloat(before.y)])
})

test('the header uses local CSS identity and no copied Graph branding', async ({ page }) => {
  await visit(page)

  await expect(page.getByRole('link', { name: 'ENS Scout home' })).toBeVisible()
  await expect(page.locator('.brand img, .brand svg, .brand canvas')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('The Graph')
})
