import { expect, test, type Page } from '@playwright/test'

const LCP_BUDGET_MS = 2500
const INP_BUDGET_MS = 200
const CLS_BUDGET = 0.1
const CPU_SLOWDOWN = 4

interface LabVitals {
  readonly lcp: number
  readonly cls: number
  readonly inp: number
  readonly interactions: number
  readonly interactionDetails: readonly InteractionTiming[]
  readonly supported: readonly string[]
}

interface InteractionTiming {
  readonly duration: number
  readonly eventTypes: readonly string[]
  readonly inputDelay: number
  readonly presentationDelay: number
  readonly processingDuration: number
  readonly startTime: number
  readonly target: string
}

interface BrowserVitalState {
  lcp: number
  cls: number
  interactions: Record<string, InteractionTiming>
}

type VitalEntry = PerformanceEntry & {
  readonly duration: number
  readonly hadRecentInput?: boolean
  readonly interactionId?: number
  readonly processingEnd?: number
  readonly processingStart?: number
  readonly target?: EventTarget | null
  readonly value?: number
}

type VitalWindow = Window & {
  __ensScoutVitals?: BrowserVitalState
}

async function installObservers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state: BrowserVitalState = { lcp: 0, cls: 0, interactions: {} }
    ;(window as VitalWindow).__ensScoutVitals = state
    const supported = new Set(PerformanceObserver.supportedEntryTypes)

    if (supported.has('largest-contentful-paint')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.lcp = Math.max(state.lcp, entry.startTime)
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true })
    }

    if (supported.has('layout-shift')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as VitalEntry[]) {
          if (entry.hadRecentInput !== true) {
            state.cls += entry.value ?? 0
          }
        }
      }).observe({ type: 'layout-shift', buffered: true })
    }

    if (supported.has('event')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as VitalEntry[]) {
          const interactionId = entry.interactionId ?? 0
          if (interactionId > 0) {
            const key = String(interactionId)
            const processingStart = entry.processingStart ?? entry.startTime
            const processingEnd = entry.processingEnd ?? processingStart
            const inputDelay = Math.max(0, processingStart - entry.startTime)
            const processingDuration = Math.max(0, processingEnd - processingStart)
            const presentationDelay = Math.max(0, entry.duration - inputDelay - processingDuration)
            let target = 'unknown'
            if (entry.target instanceof Element) {
              const text = entry.target.textContent.trim().replace(/\s+/g, ' ').slice(0, 80)
              target =
                entry.target.getAttribute('aria-label') ??
                (text.length === 0 ? entry.target.tagName.toLowerCase() : text)
            }
            const previous = state.interactions[key]
            const eventTypes = [...new Set([...(previous?.eventTypes ?? []), entry.name])]
            if (previous === undefined || entry.duration >= previous.duration) {
              state.interactions[key] = {
                duration: entry.duration,
                eventTypes,
                inputDelay,
                presentationDelay,
                processingDuration,
                startTime: entry.startTime,
                target,
              }
            } else {
              state.interactions[key] = { ...previous, eventTypes }
            }
          }
        }
      }).observe({
        type: 'event',
        buffered: true,
        durationThreshold: 16,
      } as PerformanceObserverInit)
    }
  })
}

async function readVitals(page: Page): Promise<LabVitals> {
  return page.evaluate(() => {
    const state = (window as VitalWindow).__ensScoutVitals
    const interactionDetails = Object.values(state?.interactions ?? {}).sort(
      (left, right) => left.startTime - right.startTime,
    )
    return {
      lcp: state?.lcp ?? 0,
      cls: state?.cls ?? 0,
      inp:
        interactionDetails.length === 0
          ? 0
          : Math.max(...interactionDetails.map((interaction) => interaction.duration)),
      interactions: interactionDetails.length,
      interactionDetails,
      supported: PerformanceObserver.supportedEntryTypes,
    }
  })
}

async function waitForCompletedPaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve()
          })
        })
      }),
  )
}

test('the local mid-tier mobile lab profile stays inside the LCP, INP, and CLS budgets', async ({
  context,
  page,
}, testInfo) => {
  const session = await context.newCDPSession(page)
  await session.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN })
  await session.send('Network.setCacheDisabled', { cacheDisabled: true })
  await installObservers(page)

  await page.goto('/', { waitUntil: 'networkidle' })
  await expect(page.locator('.featured-hero')).toHaveAttribute(
    'data-featured-source',
    'reviewed-artifact',
  )
  await expect(page.locator('.featured-name:visible')).toHaveCount(7)

  await page.getByRole('button', { name: 'Data', exact: true }).click()
  const dataDialog = page.getByRole('dialog', { name: 'Data' })
  await expect(dataDialog).toBeVisible()
  await waitForCompletedPaint(page)

  await page.getByRole('button', { name: 'Close Data' }).click()
  await expect(dataDialog).toHaveCount(0)
  await waitForCompletedPaint(page)

  await page.getByRole('link', { name: /Explore all 16/ }).click()
  await expect(page.locator('#page-title')).toBeFocused()
  await waitForCompletedPaint(page)

  await expect
    .poll(async () => (await readVitals(page)).interactions, {
      message: 'Chrome did not report all three Event Timing interactions',
    })
    .toBeGreaterThanOrEqual(3)

  const metrics = await readVitals(page)
  await testInfo.attach('mid-tier-mobile-vitals.json', {
    body: Buffer.from(
      `${JSON.stringify(
        {
          profile: {
            viewport: '390x844',
            touch: true,
            mobile: true,
            cpuSlowdown: CPU_SLOWDOWN,
            network: 'local production bundle; transfer enforced by asset budgets',
          },
          budgets: { lcpMs: LCP_BUDGET_MS, inpMs: INP_BUDGET_MS, cls: CLS_BUDGET },
          measured: metrics,
        },
        null,
        2,
      )}\n`,
    ),
    contentType: 'application/json',
  })

  expect(metrics.supported).toEqual(
    expect.arrayContaining(['largest-contentful-paint', 'layout-shift', 'event']),
  )
  expect(metrics.lcp, 'largest contentful paint was not recorded').toBeGreaterThan(0)
  expect(metrics.lcp, `LCP exceeds ${String(LCP_BUDGET_MS)} ms`).toBeLessThanOrEqual(LCP_BUDGET_MS)
  expect(metrics.inp, 'interaction to next paint was not recorded').toBeGreaterThan(0)
  expect(metrics.inp, `INP exceeds ${String(INP_BUDGET_MS)} ms`).toBeLessThanOrEqual(INP_BUDGET_MS)
  expect(metrics.cls, `CLS exceeds ${String(CLS_BUDGET)}`).toBeLessThanOrEqual(CLS_BUDGET)
})
