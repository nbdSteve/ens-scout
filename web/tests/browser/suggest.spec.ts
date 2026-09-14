import { expect, test, type Page } from '@playwright/test'
import { MODEL_DOWNLOAD_BYTES, SUGGESTIONS_MAX } from '../../src/suggest/contract'
import {
  answerNaming,
  events,
  expectNoModelHostAttempts,
  failGenerate,
  failLoad,
  finishGenerate,
  finishLoad,
  installFakeModel,
  isModelChunk,
  passGrace,
  prompts,
  report,
  setPlan,
  type HostWatch,
} from './suggestModel'
import { expectAccessible, SCANNED_AT, scrollsSideways, visit } from './support'

/**
 * The local recommender, in a real browser, against the bundle with no read API.
 *
 * Two promises hold this suite together and every test here is one of them stated
 * concretely.
 *
 * The first is that the base product does not depend on a model. The names, the filters,
 * and the fresh-check action are interactive before anything model-related begins, and
 * every way the model can fail to arrive - an unsupported device, an opt-out, an offline
 * browser, a stopped download, a device out of memory, an answer this build refuses - ends
 * with a useful ranked list and a sentence saying which recommender ordered it. None of them
 * is an application error.
 *
 * The second is that a name can only ever come out of the snapshot already on screen. The
 * model is shown a bounded shortlist drawn from the visitor's own filters, and an answer
 * naming anything else is refused whole. That is asserted from both directions here: the
 * exact list the model was given, and what happens to an answer that strays from it.
 *
 * `tests/browser/suggestModel.ts` says how the boundary is faked and why it is faked at
 * the chunk rather than through a hook in `src/`. Nothing in this file downloads a model or
 * reaches any service; the asset hosts are routed to an abort, and reaching one fails the
 * test that did it.
 *
 * The clock is Playwright's throughout, because the deferral before a load and the states
 * a load passes through are both time-shaped and neither should cost a real wait.
 */

/** Names in the committed `preview` fixture. */
const AMBER = 'amber.eth'
const ZAP = 'zap.eth'

/** The size notice's own figure, derived as the component derives it. */
const DOWNLOAD_MB = `${String(Math.round(MODEL_DOWNLOAD_BYTES / 1_000_000))} MB`

/**
 * A device that will not run the model, for the tests whose subject is everything else.
 *
 * The probe refuses rather than `navigator.gpu` being absent, because the property cannot
 * be removed here: headless Chromium exposes it on a secure origin, which `127.0.0.1` is.
 * The refusal lands in the same place either way - one sentence, no load, and the
 * deterministic recommender answering - so this is the shape those tests want, and
 * `useSuggest.test.ts` covers the branch where the property itself is missing.
 */
const NO_MODEL = { plan: { probe: 'no-webgpu' } } as const

function panel(page: Page) {
  return page.getByRole('region', { name: 'Find a name you would actually use' })
}

function stateLine(page: Page) {
  return page.locator('.suggest__state')
}

/** Which recommender supplied the order on screen. The sentence a visitor is owed. */
function sourceLine(page: Page) {
  return page.locator('.suggest__source')
}

function suggestions(page: Page) {
  return page.locator('.suggestion')
}

/** Every suggested name, in the order they are shown. */
function suggestedNames(page: Page): Promise<string[]> {
  return page.locator('.suggestion__name').allInnerTexts()
}

function ask(page: Page) {
  return page.getByRole('button', { name: 'Suggest names' })
}

/** The one control that stops a load or declines to start one, by any of its four labels. */
function stopButton(page: Page) {
  return page.getByRole('button', {
    name: /^(Do not download it|Stop the download|Stop using it)$/,
  })
}

function failureNotice(page: Page) {
  return panel(page).getByRole('alert')
}

/**
 * Opens the page with the boundary faked, at the fixture's own scan instant.
 *
 * `view=all`, so the shortlist has the fixture's ten names to draw from rather than the two
 * the landing view holds: the shortlist is built from the rows the visitor's filters admit,
 * which is the behaviour under test in half of these.
 */
async function open(
  page: Page,
  options: Parameters<typeof installFakeModel>[1] = {},
  params: Record<string, string> = {},
): Promise<HostWatch> {
  await page.clock.install({ time: new Date(SCANNED_AT) })
  const watch = await installFakeModel(page, options)
  await visit(page, { view: 'all', ...params })
  return watch
}

/** Loads the model and waits until it is ready. The precondition of most tests here. */
async function ready(page: Page): Promise<void> {
  await passGrace(page)
  await expect(stateLine(page)).toContainText('The optional model is ready')
}

/** Asks for suggestions with the first built-in vibe, which is the default selection. */
async function askForNames(page: Page): Promise<void> {
  await ask(page).click()
}

test.describe('the core page never waits for the model', () => {
  test('the names, the filters, and the panel are usable before anything is fetched', async ({
    page,
  }) => {
    const chunkRequests: string[] = []
    page.on('request', (request) => {
      if (isModelChunk(request)) {
        chunkRequests.push(request.url())
      }
    })

    const watch = await open(page)

    /*
     * The milestone, asserted as the page's own content rather than as a metric. The names
     * are rendered, a filter applies, and the recommender answers - all with the model
     * chunk not yet requested and the fake not yet asked anything.
     */
    await expect(
      page.getByRole('listitem', { name: new RegExp(ZAP.replace('.', '\\.')) }),
    ).toBeVisible()
    expect(chunkRequests, 'the model chunk was fetched before the grace elapsed').toEqual([])
    expect(await events(page)).toEqual([])

    // A deterministic answer, in full, before a model exists anywhere on this page.
    await askForNames(page)
    await expect(sourceLine(page)).toContainText('Ordered by this page')
    await expect(suggestions(page)).toHaveCount(SUGGESTIONS_MAX)

    // And the search field still filters, which is the other half of interactive.
    await page.getByRole('searchbox').fill('zap')
    await expect(
      page.getByRole('listitem', { name: new RegExp(AMBER.replace('.', '\\.')) }),
    ).toHaveCount(0)

    expectNoModelHostAttempts(watch)
  })

  test('the size is stated with the controls reachable and nothing in flight', async ({ page }) => {
    await open(page)

    // The whole reason the grace exists: the figure and both refusals are on screen while
    // no byte has been fetched.
    await expect(panel(page)).toContainText(`The first load transfers ${DOWNLOAD_MB}`)
    await expect(stopButton(page)).toHaveText('Do not download it')
    await expect(page.getByRole('button', { name: 'Turn it off on this device' })).toBeVisible()
    expect(await events(page)).toEqual([])
  })

  test('declining before the grace elapses fetches nothing at all', async ({ page }) => {
    const chunkRequests: string[] = []
    page.on('request', (request) => {
      if (isModelChunk(request)) {
        chunkRequests.push(request.url())
      }
    })
    await open(page)

    await stopButton(page).click()
    await expect(stateLine(page)).toContainText('The optional model is not in use')

    // The clock then passes the grace with the refusal standing, which is what proves the
    // refusal cancelled the start rather than merely preceding it.
    await passGrace(page)
    await expect(stateLine(page)).toContainText('The optional model is not in use')
    expect(chunkRequests).toEqual([])
    expect(await events(page)).toEqual([])

    // Ranking still works, and says it was this page that did it.
    await askForNames(page)
    await expect(sourceLine(page)).toContainText('Ordered by this page')
    await expect(suggestions(page)).toHaveCount(SUGGESTIONS_MAX)
  })
})

test.describe('only names from the shortlist reach the screen', () => {
  test('the model is shown the filtered snapshot and nothing else', async ({ page }) => {
    const watch = await open(page, {}, { min: '3', max: '4' })
    await ready(page)
    await askForNames(page)

    const [prompt] = await prompts(page)
    expect(prompt, 'the model was never asked').toBeDefined()

    /*
     * Every name the model saw was one the visitor's own length filter admitted, and every
     * one is a name the fixture published. The filter is the only control over what may be
     * suggested, which is why the assertion is made against it rather than against a rule
     * inside the recommender.
     */
    const shown = prompt?.allowed ?? []
    expect(shown.length).toBeGreaterThan(0)
    for (const name of shown) {
      const label = name.replace(/\.eth$/, '')
      expect(label.length, `${name} is outside the requested length range`).toBeGreaterThanOrEqual(
        3,
      )
      expect(label.length, `${name} is outside the requested length range`).toBeLessThanOrEqual(4)
    }

    // The prompt says nothing about lifecycle, which is the model's other non-job.
    expect(prompt?.system).toContain('Do not assess availability')

    // And an answer drawn from that list is attributed to the model.
    await finishGenerate(page, answerNaming(shown[0] ?? AMBER))
    await expect(sourceLine(page)).toContainText('Ordered by the model')
    await expect(sourceLine(page)).toContainText('described by this page')
    expectNoModelHostAttempts(watch)
  })

  test('an answer naming a name that was not offered is refused whole', async ({ page }) => {
    await open(page)
    await ready(page)
    await askForNames(page)

    // The deterministic answer is already on screen, which is what makes a refusal cheap.
    const before = await suggestedNames(page)
    expect(before.length).toBe(SUGGESTIONS_MAX)

    // A plausible `.eth` label the fixture does not publish. Nothing about it is wrong
    // except that it was not in the list, which is the only thing that matters.
    await finishGenerate(page, answerNaming('vitalik.eth'))

    await expect(failureNotice(page)).toContainText('did not match what this page accepts')
    // Not one name changed, and the invented one is nowhere on the page.
    expect(await suggestedNames(page)).toEqual(before)
    await expect(sourceLine(page)).toContainText('Ordered by this page')
    await expect(page.getByText('vitalik.eth')).toHaveCount(0)
  })

  test('a malformed answer leaves the deterministic ranking exactly as it was', async ({
    page,
  }) => {
    await open(page)
    await ready(page)
    await askForNames(page)
    const before = await suggestedNames(page)

    // Prose around the JSON, which the pinned configuration cannot produce and this build
    // therefore refuses rather than strips.
    await finishGenerate(page, `Here you go!\n\`\`\`json\n${answerNaming(AMBER)}\n\`\`\``)

    await expect(failureNotice(page)).toBeVisible()
    expect(await suggestedNames(page)).toEqual(before)
    await expect(sourceLine(page)).toContainText('Ordered by this page')
  })

  test('a repeated name is refused, so a list cannot be padded', async ({ page }) => {
    await open(page)
    await ready(page)
    await askForNames(page)
    const before = await suggestedNames(page)

    await finishGenerate(page, answerNaming(AMBER, AMBER))

    await expect(failureNotice(page)).toBeVisible()
    expect(await suggestedNames(page)).toEqual(before)
  })

  test('generated prose with names and lifecycle claims is refused whole', async ({ page }) => {
    await open(page)
    await ready(page)
    await askForNames(page)
    const before = await suggestedNames(page)

    await finishGenerate(
      page,
      JSON.stringify({
        picks: [
          {
            name: AMBER,
            reason:
              '\nAvailable to register now; try Vitalik.ETH or sub.amber.eth instead, for a low price.',
          },
        ],
      }),
    )

    await expect(failureNotice(page)).toBeVisible()
    expect(await suggestedNames(page)).toEqual(before)
    await expect(page.locator('body')).not.toContainText('Vitalik.ETH')
    await expect(page.locator('body')).not.toContainText('sub.amber.eth')
  })

  test('an accepted answer replaces the ranking and says the model ordered it', async ({
    page,
  }) => {
    const watch = await open(page)
    await ready(page)
    await askForNames(page)

    const offered = (await prompts(page))[0]?.allowed ?? []
    // Two names the model really was shown, in an order the deterministic ranking did not
    // produce, so the replacement is observable rather than coincidental.
    const picks = [...offered].reverse().slice(0, 2)
    await finishGenerate(page, answerNaming(...picks))

    await expect(sourceLine(page)).toContainText('Ordered by the model')
    await expect(sourceLine(page)).toContainText('described by this page')
    await expect(sourceLine(page)).toContainText('It only ever sees that list')
    await expect(suggestions(page)).toHaveCount(2)
    expect(await suggestedNames(page)).toEqual(picks)
    await expect(failureNotice(page)).toHaveCount(0)
    expectNoModelHostAttempts(watch)
  })
})

test.describe('the deterministic recommender answers whenever the model does not', () => {
  test('an unsupported device gets names and one sentence about why', async ({ page }) => {
    /*
     * The probe's verdict, not the absence of `navigator.gpu`.
     *
     * A browser with no WebGPU at all is the cheaper refusal and `load.ts` makes it without
     * fetching anything, but it cannot be produced here: headless Chromium exposes the
     * property on a secure origin and no launch flag removes it. What a device without
     * WebGPU really reaches is the same verdict from the other side of the chunk, and that
     * is what is driven. `useSuggest.test.ts` covers the property-absent branch, where a
     * fake `hasWebGpu` is a one-line injection.
     */
    const watch = await open(page, { plan: { probe: 'no-webgpu' } })
    await passGrace(page)

    await expect(failureNotice(page)).toContainText('The model is unavailable here')
    await expect(failureNotice(page)).toContainText('This browser cannot run the on-device model')
    await expect(page.getByRole('button', { name: 'Stop using it' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Use the model' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
    // Refused at the probe, so not one model asset was fetched.
    expect(await events(page)).toEqual(['probe'])

    await askForNames(page)
    await expect(suggestions(page)).toHaveCount(SUGGESTIONS_MAX)
    await expect(sourceLine(page)).toContainText('Ordered by this page')
    expectNoModelHostAttempts(watch)
  })

  test('a device whose adapter lacks the required feature is told so once', async ({ page }) => {
    await open(page, { plan: { probe: 'no-feature' } })
    await passGrace(page)

    await expect(failureNotice(page)).toContainText('graphics hardware cannot run')
    // Probed, and then nothing loaded: the refusal is before the download.
    expect(await events(page)).toEqual(['probe'])
    // Nothing to try again with, so nothing is offered.
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)

    await askForNames(page)
    await expect(suggestions(page)).toHaveCount(SUGGESTIONS_MAX)
  })

  test('an offline device is told that, and not that the files were blocked', async ({ page }) => {
    await open(page, { online: false, plan: { autoLoad: false } })
    await passGrace(page)
    await expect(stateLine(page)).toContainText('Downloading the optional model')

    await failLoad(page, 'TypeError: Failed to fetch')

    await expect(failureNotice(page)).toContainText(
      'cannot be downloaded while this device is offline',
    )
    await askForNames(page)
    await expect(suggestions(page)).toHaveCount(SUGGESTIONS_MAX)
  })

  test('a device out of memory is told what might help', async ({ page }) => {
    await open(page, { plan: { autoLoad: false } })
    await passGrace(page)

    // The library reports this as message text, which is the only classification available.
    await failLoad(page, 'Error: device lost: out of memory while allocating buffer')

    await expect(failureNotice(page)).toContainText('did not have enough memory')
    await expect(failureNotice(page)).toContainText('Closing other tabs')
    // Retryable, so the offer to try again is there.
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()

    await askForNames(page)
    await expect(suggestions(page)).toHaveCount(SUGGESTIONS_MAX)
  })

  test('a failed generation keeps the ranking and does not disable the model', async ({ page }) => {
    await open(page)
    await ready(page)
    await askForNames(page)

    await failGenerate(page, 'Error: the runtime went away')

    await expect(failureNotice(page)).toContainText('The model did not answer')
    await expect(suggestions(page)).toHaveCount(SUGGESTIONS_MAX)
    // The model is still loaded, because one refused generation is not a lost model.
    await expect(stateLine(page)).toContainText('The optional model is ready')
  })

  test('the same request gives the same order every time', async ({ page }) => {
    // Two loads of the same page with the same filters, and no model in either.
    await open(page, NO_MODEL)
    await askForNames(page)
    const first = await suggestedNames(page)

    await page.reload()
    await expect(panel(page)).toBeVisible()
    await askForNames(page)

    expect(await suggestedNames(page)).toEqual(first)
    expect(first.length).toBe(SUGGESTIONS_MAX)
  })

  test('model ordering and page-owned explanations keep distinct provenance', async ({ page }) => {
    await open(page)
    await ready(page)
    await askForNames(page)

    // The deterministic sentences are this page's, and it says so.
    await expect(sourceLine(page)).toContainText('The same request gives the same order every time')

    const offered = (await prompts(page))[0]?.allowed ?? []
    await finishGenerate(page, answerNaming(offered[0] ?? AMBER))
    await expect(sourceLine(page)).toContainText('Ordered by the model')
    await expect(sourceLine(page)).toContainText('described by this page')
    await expect(suggestions(page).first()).not.toContainText('A fake reason for')
  })
})

test.describe('progress, cancellation, and the visitor’s no', () => {
  test('progress is a percentage and never the library’s own text', async ({ page }) => {
    await open(page, { plan: { autoLoad: false } })
    await passGrace(page)
    await expect(stateLine(page)).toContainText('Downloading the optional model')

    const bar = page.getByRole('progressbar', { name: 'Model download' })
    await expect(bar).toBeVisible()

    // The library's own line quotes an asset path, and the host in it is the one thing this
    // page otherwise never names. The fraction is a number, so it is what is shown.
    await report(page, 0.42, 'Fetching param shard 3 from https://huggingface.co/mlc-ai/whatever')
    await expect(page.locator('.suggest__progress-figure')).toHaveText('42%')
    await expect(panel(page)).not.toContainText('huggingface.co')
    await expect(panel(page)).not.toContainText('param shard')

    // An unknown fraction reads as working rather than as stalled at zero.
    await report(page, null, 'Loading model from cache')
    await expect(page.locator('.suggest__progress-figure')).toHaveText('Working')
  })

  test('stopping a load mid-download releases the model and keeps the names', async ({ page }) => {
    await open(page, { plan: { autoLoad: false } })
    await passGrace(page)
    await report(page, 0.3, 'Fetching')
    await expect(stopButton(page)).toHaveText('Stop the download')

    await stopButton(page).click()

    await expect(stateLine(page)).toContainText('The download was stopped')
    // The load was really aborted, as far as the boundary permits.
    expect(await events(page)).toContain('load-abort')
    // No progress bar left behind, and no failure banner: a cancellation is not a failure.
    await expect(page.getByRole('progressbar')).toHaveCount(0)
    await expect(failureNotice(page)).toHaveCount(0)

    await askForNames(page)
    await expect(suggestions(page)).toHaveCount(SUGGESTIONS_MAX)
    await expect(sourceLine(page)).toContainText('Ordered by this page')
  })

  test('a cancelled load can be restarted by the visitor and not by the page', async ({ page }) => {
    await open(page, { plan: { autoLoad: false } })
    await passGrace(page)
    await stopButton(page).click()
    await expect(stateLine(page)).toContainText('The download was stopped')

    // The page does not retry itself, however long it is left.
    await page.clock.fastForward(10 * 60 * 1000)
    await expect(stateLine(page)).toContainText('The download was stopped')

    await setPlan(page, { autoLoad: true })
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(stateLine(page)).toContainText('The optional model is ready')
  })

  test('turning it off is remembered on the next visit', async ({ page }) => {
    await open(page)
    await ready(page)
    await askForNames(page)
    const offered = (await prompts(page))[0]?.allowed ?? []
    await finishGenerate(page, answerNaming(offered[0] ?? AMBER))
    await expect(sourceLine(page)).toContainText('Ordered by the model')

    await page.getByRole('button', { name: 'Turn it off on this device' }).click()
    await expect(stateLine(page)).toContainText('turned off on this device')
    await expect(sourceLine(page)).toContainText('Ordered by this page')

    await page.reload()
    await expect(panel(page)).toBeVisible()

    // Nothing starts on the new page load, and nothing is fetched even after the grace.
    await expect(stateLine(page)).toContainText('turned off on this device')
    await passGrace(page)
    await expect(stateLine(page)).toContainText('turned off on this device')
    expect(await events(page)).toEqual([])

    // And the recommender still answers, which is the point of the opt-out being cheap.
    await askForNames(page)
    await expect(suggestions(page)).toHaveCount(SUGGESTIONS_MAX)
  })

  test('an opt-out from a previous visit suppresses the load from the first paint', async ({
    page,
  }) => {
    await open(page, { optedOut: true })

    await expect(stateLine(page)).toContainText('turned off on this device')
    // The size notice is not shown, because there is nothing to agree to.
    await expect(panel(page)).not.toContainText('The first load transfers')
    await passGrace(page)
    expect(await events(page)).toEqual([])
  })

  test('turning it back on does not itself start a download', async ({ page }) => {
    await open(page, { optedOut: true, plan: { autoLoad: false } })
    await page.getByRole('button', { name: 'Turn it back on' }).click()

    // Paused, not loading: re-enabling undoes the memory of the refusal and nothing more.
    await expect(stateLine(page)).toContainText('The optional model is not in use')
    await passGrace(page)
    expect(await events(page)).toEqual([])

    await page.getByRole('button', { name: 'Use the model' }).click()
    await expect(stateLine(page)).toContainText('Downloading the optional model')
  })

  test('a returning visitor with the model cached is not quoted a download', async ({ page }) => {
    await open(page, { plan: { cached: true, autoLoad: false } })
    await passGrace(page)

    // Cache reuse, as the visitor experiences it: no size to agree to, because there is
    // nothing to transfer.
    await expect(panel(page)).toContainText('already stored in this browser')
    await expect(panel(page)).not.toContainText(`The first load transfers ${DOWNLOAD_MB}`)

    await finishLoad(page)
    await expect(stateLine(page)).toContainText('The optional model is ready')
  })

  test('a load that runs long says so and still offers the names', async ({ page }) => {
    await open(page, { plan: { autoLoad: false } })
    await passGrace(page)
    await expect(stateLine(page)).toContainText('Downloading the optional model')

    // Past the point where the honest thing is to say it is taking a while. Still loading,
    // which is exactly what the sentence says.
    await page.clock.fastForward(46 * 1000)
    await expect(panel(page)).toContainText('This is taking a while')
    await expect(stateLine(page)).toContainText('Downloading the optional model')

    await askForNames(page)
    await expect(suggestions(page)).toHaveCount(SUGGESTIONS_MAX)
  })
})

test.describe('the panel is reachable and readable', () => {
  test('the whole panel is operable from the keyboard', async ({ page }) => {
    await open(page, NO_MODEL)

    // Reached by tabbing, not by clicking: the theme field and the vibe radios are one
    // control the keyboard walks through in order.
    const theme = page.getByLabel('Your own words')
    await theme.focus()
    await theme.fill('quiet coastal')
    // Enter in the field submits the form, which is what a visitor expects of a field
    // beside a button.
    await theme.press('Enter')

    await expect(suggestions(page)).not.toHaveCount(0)
    await expect(sourceLine(page)).toContainText('Ordered by this page')
    // The request is repeated back in the visitor's own words.
    await expect(page.locator('.suggest__answer-title')).toContainText('quiet coastal')
  })

  test('a theme that is too long is reported and not applied', async ({ page }) => {
    await open(page, NO_MODEL)

    await page.getByLabel('Your own words').fill('x'.repeat(80))
    // Reported live from the field, as a rejected length bound is, and the sentence names
    // the requirement rather than the text.
    await expect(panel(page)).toContainText('characters or fewer')
    await expect(page.getByLabel('Your own words')).toHaveAttribute('aria-invalid', 'true')

    await askForNames(page)
    await expect(suggestions(page)).toHaveCount(0)
  })

  test('an accessible panel in every state a load passes through', async ({ page }) => {
    await open(page, { plan: { autoLoad: false } })
    // Waiting, with the size notice and both refusals on screen.
    await expectAccessible(page)

    await passGrace(page)
    await report(page, 0.5, 'Fetching')
    // Loading, with a progress bar.
    await expectAccessible(page)

    await finishLoad(page)
    await askForNames(page)
    await expect(suggestions(page)).not.toHaveCount(0)
    // Ready, with an answer.
    await expectAccessible(page)

    await finishGenerate(page, '{"picks":[]}')
    await expect(failureNotice(page)).toBeVisible()
    // Refused, with the failure banner.
    await expectAccessible(page)
  })

  test('the panel does not make the page scroll sideways', async ({ page }) => {
    await open(page, { plan: { autoLoad: false } })
    await passGrace(page)
    await report(page, 0.5, 'Fetching')
    await finishLoad(page)
    await askForNames(page)
    await expect(suggestions(page)).not.toHaveCount(0)

    expect(await scrollsSideways(page)).toBe(false)
  })

  test('no name in this build is a link, because no check can be made', async ({ page }) => {
    await open(page, NO_MODEL)
    await askForNames(page)
    await expect(suggestions(page)).not.toHaveCount(0)

    // The gate's answer in a build with no verifier: no tick boxes, no links, and the panel
    // says why rather than leaving a visitor to notice.
    await expect(panel(page).getByRole('link')).toHaveCount(0)
    await expect(panel(page).getByRole('checkbox')).toHaveCount(0)
    await expect(panel(page)).toContainText('no verifier')
  })
})
