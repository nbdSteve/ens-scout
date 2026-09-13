import { expect, test, type Page } from '@playwright/test'
import './support'

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
  await context.setOffline(true)
  const otherPage = await context.newPage()

  expect(await navigationFailure(page, 'default-page')).toBe('net::ERR_BLOCKED_BY_CLIENT')
  expect(await navigationFailure(otherPage, 'other-page')).toBe('net::ERR_BLOCKED_BY_CLIENT')
})
