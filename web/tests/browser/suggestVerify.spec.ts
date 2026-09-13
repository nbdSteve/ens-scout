import { expect, test, type Page } from '@playwright/test'
import {
  checkDocument,
  checkButton,
  ensLinkFor,
  fulfilCheck,
  refuseCheck,
  stubCheck,
  stubSnapshot,
  type CheckAnswer,
  type CheckedName,
} from './checkApi'
import { answerNaming, installFakeModel, passGrace, prompts, finishGenerate } from './suggestModel'
import { MINUTE, SCANNED_AT, since, visit } from './support'

/**
 * The one rule that governs a suggestion: it earns an outbound link exactly the way a
 * scanned row does, and not one step sooner.
 *
 * This runs against the verifier build because that is the only bundle where the question
 * exists. `VITE_API_BASE_URL` is what turns the tick boxes and the outbound links on at
 * all, so a suite against the fixture build can prove there are no links and this one is
 * what proves the links that do appear were earned. `verify.spec.ts` does the same for the
 * results table; what is different here is that a suggested name has been chosen for how it
 * reads rather than for what the index said about it, so if anything it is less verified
 * than a scanned one and the same gate is the least that can apply.
 *
 * There is deliberately no path in `src/` that could differ. `SuggestionItem` derives its
 * row through `rowVerification`, which is the function the table uses, which calls
 * `verify/gate.ts`, which takes no parameter a caller could use to claim a name is special.
 * These tests are what proves that arrangement end to end - through a real POST, a real
 * response, the real parser, and the real gate - rather than in a unit test that hands the
 * gate a map.
 *
 * The model boundary is faked exactly as in `suggest.spec.ts`, and no test here downloads a
 * model or contacts any service.
 */

/** Names in the committed `preview` fixture. Its available pair. */
const AMBER = 'amber.eth'

function panel(page: Page) {
  return page.getByRole('region', { name: 'Find a name you would actually use' })
}

function suggestions(page: Page) {
  return page.locator('.suggestion')
}

/** One suggestion's own list item, so an assertion cannot drift onto a table row. */
function suggestionFor(page: Page, name: string) {
  return suggestions(page).filter({ hasText: name })
}

/** The tick box inside the panel, which is the panel's own and not the table's. */
function suggestionTick(page: Page, name: string) {
  return panel(page).getByRole('checkbox', { name: `Fresh check ${name}` })
}

/** The panel's own check action, which is not the table's bar. */
function panelCheck(page: Page) {
  return panel(page).getByRole('button', { name: 'Check the ticked names now' })
}

/** An answer that is current at the frozen clock: read now, good for two minutes. */
function current(results: readonly CheckedName[]): CheckAnswer {
  return { checkedAt: since(0), expiresAt: since(2 * MINUTE), results }
}

/**
 * Opens the verifier build with the boundary faked and the model ready.
 *
 * The snapshot is routed before the navigation, because this bundle loads its snapshot over
 * the network and a test that navigated first would race its own request.
 *
 * `live` drops `?now=`, which every other test here wants: a frozen instant is what makes
 * the fixture's own statuses and countdowns assertable. It is also what a test about a check
 * lapsing cannot use, because `useNow` returns a given instant unchanged and the gate judges
 * expiry against exactly that - so a frozen page never reaches the moment its own answer
 * declared it stops being current. Playwright's clock then supplies a time that really moves.
 */
async function open(page: Page, options: { readonly live?: boolean } = {}): Promise<void> {
  await page.clock.install({ time: new Date(SCANNED_AT) })
  await installFakeModel(page)
  await stubSnapshot(page)
  if (options.live === true) {
    await page.goto('/?view=all')
    await expect(page.getByRole('region', { name: /\.eth names$/ })).toBeVisible()
  } else {
    await visit(page, { view: 'all' })
  }
  await passGrace(page)
  await expect(page.locator('.suggest__state')).toContainText('The optional model is ready')
}

/** Asks for names, and returns the shortlist the model was really shown. */
async function askForNames(page: Page): Promise<readonly string[]> {
  await page.getByRole('button', { name: 'Suggest names' }).click()
  await expect(suggestions(page)).not.toHaveCount(0)
  return (await prompts(page))[0]?.allowed ?? []
}

test('a suggestion is not a link until a fresh check covers it', async ({ page }) => {
  await open(page)
  const offered = await askForNames(page)

  // The whole rule, stated as a count. A name the snapshot published, chosen by the
  // recommender, ranked and explained, is still not somewhere a visitor can be sent.
  await expect(panel(page).getByRole('link')).toHaveCount(0)
  await expect(panel(page).getByText('No fresh check')).not.toHaveCount(0)

  // Including a name the fixture's own scan recorded as available, which is the case where
  // a page that trusted its snapshot would have linked out.
  expect(offered).toContain(AMBER)
})

test('a model-chosen name is gated exactly like a deterministically chosen one', async ({
  page,
}) => {
  await open(page)
  const offered = await askForNames(page)

  // The model picks, so these names are on screen because a model put them there.
  await finishGenerate(page, answerNaming(...offered.slice(0, 3)))
  await expect(page.locator('.suggest__source')).toContainText('Ordered by the model')

  // And not one of them is a link. Whose choice a name was is not an input to the gate.
  await expect(panel(page).getByRole('link')).toHaveCount(0)
  await expect(panel(page).getByText('No fresh check')).toHaveCount(3)
})

test('a check that lands makes exactly the checked suggestion actionable', async ({ page }) => {
  await open(page)
  const offered = await askForNames(page)
  const [first, second] = offered
  expect(first, 'the fixture offered nothing to check').toBeDefined()
  expect(second, 'the fixture offered only one name').toBeDefined()

  let asked: readonly string[] = []
  await stubCheck(page, async (route, names) => {
    asked = names
    await fulfilCheck(
      route,
      checkDocument(current([{ name: first ?? AMBER, status: 'available' }])),
    )
  })

  await suggestionTick(page, first ?? AMBER).check()
  await panelCheck(page).click()

  // The one name the visitor ticked was asked about, and it is now a link.
  const link = suggestionFor(page, first ?? AMBER).getByRole('link')
  await expect(link).toHaveAttribute('href', `https://app.ens.domains/${first ?? AMBER}`)
  // Every outbound action says where the authority is, in the link's own accessible name.
  await expect(link).toHaveAccessibleName(/the final authority on whether it can be registered/)
  expect(asked).toEqual([first])
  await expect(suggestionFor(page, first ?? AMBER)).toContainText('Fresh check')
  await expect(suggestionFor(page, first ?? AMBER)).toContainText('Available')
  await expect(suggestionFor(page, first ?? AMBER).locator('time')).toHaveAttribute(
    'datetime',
    since(0),
  )

  // And the suggestion beside it, which nothing checked, is still not one.
  await expect(suggestionFor(page, second ?? '').getByRole('link')).toHaveCount(0)
  await expect(suggestionFor(page, second ?? '')).toContainText('No fresh check')
})

test('a check that lapses closes the link again', async ({ page }) => {
  // A clock that really moves, because the gate judges expiry against the instant the page
  // is rendering at and a `?now=` page never leaves the one it was given.
  await open(page, { live: true })
  const offered = await askForNames(page)
  const first = offered[0] ?? AMBER

  await stubCheck(page, async (route) => {
    await fulfilCheck(route, checkDocument(current([{ name: first, status: 'available' }])))
  })
  await suggestionTick(page, first).check()
  await panelCheck(page).click()
  await expect(suggestionFor(page, first).getByRole('link')).toHaveCount(1)

  /*
   * Past the instant the answer itself declared it stops being current. The endpoint's own
   * `expires_at` is what decides, and the page's clock is what reaches it, so this is the
   * real rule rather than a special case: the link closes and the row says the check lapsed
   * rather than that none was made.
   */
  await page.clock.fastForward(3 * MINUTE)

  await expect(suggestionFor(page, first).getByRole('link')).toHaveCount(0)
  await expect(suggestionFor(page, first)).toContainText('Fresh check has lapsed')
  await expect(suggestionFor(page, first)).toContainText('Available')
  await expect(suggestionFor(page, first).locator('time')).toHaveAttribute('datetime', since(0))
})

test('a refused check leaves the suggestion unlinked and quotes nothing', async ({ page }) => {
  await open(page)
  const offered = await askForNames(page)
  const first = offered[0] ?? AMBER

  await stubCheck(page, async (route) => {
    // The endpoint's `message` is text this page must never show, whatever it holds: the
    // upstream is the Graph gateway and its URL carries a credential.
    await refuseCheck(route, {
      status: 429,
      code: 'client_throttled',
      message: 'https://gateway.thegraph.com/api/deadbeefdeadbeefdeadbeefdeadbeef/subgraphs',
      retryAfterSeconds: 30,
    })
  })

  await suggestionTick(page, first).check()
  await panelCheck(page).click()

  await expect(page.getByRole('alert').filter({ hasText: 'Fresh check failed' })).toBeVisible()
  // No link, and the suggestion still says what it said before.
  await expect(suggestionFor(page, first).getByRole('link')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('gateway.thegraph.com')
  await expect(page.locator('body')).not.toContainText('deadbeef')

  // The names are still there and still ranked: a failed check costs the link and nothing
  // else, and it never clears what the visitor was looking at.
  await expect(suggestions(page)).not.toHaveCount(0)
})

test('a check made from the table also opens the matching suggestion', async ({ page }) => {
  await open(page)
  const offered = await askForNames(page)
  const first = offered[0] ?? AMBER

  await stubCheck(page, async (route) => {
    await fulfilCheck(route, checkDocument(current([{ name: first, status: 'available' }])))
  })

  /*
   * Ticked in the table, not in the panel, and checked with the table's own bar.
   *
   * One verified set for the page, because there is one gate. A second store for the panel
   * would be a second answer to whether a name may be acted on, and a visitor who has just
   * checked a name in the table would find the same name unlinked below.
   */
  await page.getByRole('row').filter({ hasText: first }).getByRole('checkbox').check()
  await checkButton(page).click()

  await expect(ensLinkFor(page, first)).toHaveCount(1)
  await expect(suggestionFor(page, first).getByRole('link')).toHaveCount(1)
})

test('a fresh status that disagrees with the scan is what the suggestion carries', async ({
  page,
}) => {
  await open(page)
  const offered = await askForNames(page)
  const first = offered[0] ?? AMBER

  await stubCheck(page, async (route) => {
    // The index now says this name is registered. A suggestion is a reading of the list and
    // never a claim about availability, so the check is free to contradict it - and does.
    await fulfilCheck(
      route,
      checkDocument(
        current([{ name: first, status: 'registered', expiry: since(400 * 24 * 60 * MINUTE) }]),
      ),
    )
  })

  await suggestionTick(page, first).check()
  await panelCheck(page).click()

  /*
   * Linked, because a fresh check covered it and that is the only thing the gate asks. What
   * the status says is a separate question the row answers separately, and the page states
   * both rather than reconciling them.
   */
  await expect(suggestionFor(page, first).getByRole('link')).toHaveCount(1)
  await expect(page.getByRole('row').filter({ hasText: first })).toContainText('Registered')
  await expect(suggestionFor(page, first)).toContainText('Registered')
  await expect(suggestionFor(page, first).locator('time')).toHaveAttribute('datetime', since(0))
})
