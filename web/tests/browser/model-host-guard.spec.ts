import { expect, test, type Page } from '@playwright/test'
import { installModelHostGuard } from './support'

const MODEL_HOST = 'https://huggingface.co/ens-scout-network-guard'

async function navigationFailure(page: Page, name: string): Promise<string | null> {
  const url = `${MODEL_HOST}/${name}.bin`
  const failed = page.waitForEvent('requestfailed', {
    predicate: (request) => request.url() === url,
  })
  await page.goto(url).catch(() => undefined)
  return (await failed).failure()?.errorText ?? null
}

test('blocks model hosts from every page in one browser context', async ({ context, page }) => {
  // Keep an independent network floor under the guard this test exercises. Context
  // routes run newest first, so the real guard wins when installed and this fallback
  // returns ERR_FAILED without contacting the host if that installation ever regresses.
  await context.unrouteAll({ behavior: 'wait' })
  await context.route(`${MODEL_HOST}/**`, async (route) => {
    await route.abort('failed')
  })
  await installModelHostGuard(context)
  const otherPage = await context.newPage()

  expect(await navigationFailure(page, 'default-page')).toBe('net::ERR_BLOCKED_BY_CLIENT')
  expect(await navigationFailure(otherPage, 'other-page')).toBe('net::ERR_BLOCKED_BY_CLIENT')
})
