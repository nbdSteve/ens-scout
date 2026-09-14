import { expect, test } from '@playwright/test'
import { CHECK_FORMAT_VERSION, CHECK_MAX_NAMES } from '../../src/verify/contract'
import {
  checkButton,
  checkDocument,
  checkingButton,
  ensLinkFor,
  fieldLinks,
  failureBanner,
  fulfilCheck,
  hold,
  openVerified,
  POISON,
  refuseCheck,
  rowFor,
  stubCheck,
  tickBox,
  type CheckAnswer,
  type CheckedName,
} from './checkApi'
import { expectAccessible, MINUTE, scrollsSideways, since } from './support'

/**
 * Fresh checks, in a real browser, against the bundle that has a verifier.
 *
 * This is the only project that runs the `dist-verify` build, and the reason it
 * exists is one rule: a snapshot result may not offer an outbound registration link
 * until a fresh check has covered that name and has not lapsed. Everything else here
 * follows from that rule being enforced end to end - through a real POST, a real
 * response, the real parser, and the real gate - rather than in a unit test that
 * hands the gate a map.
 *
 * The clock is frozen with `?now=`, at the instant the committed fixture records as
 * its scan. So a landed answer is one that says it was taken now and expires in two
 * minutes, and a lapsed answer is one that had already expired when it arrived: both
 * are documents the endpoint could really send, and the page's own arithmetic is what
 * decides between them.
 *
 * The sentences are written out here rather than imported from `src/verify/failure.ts`.
 * They are what a visitor reads, and asserting them against the same constant that
 * produced them would prove only that a value equals itself. `failure.test.ts` is what
 * ties each sentence to its kind.
 */

/** Names in the committed `preview` fixture. The first two are its available pair. */
const AMBER = 'amber.eth'
const ORB = 'orb.eth'

/** The bound, as text, for the sentence the bar renders it into. */
const BOUND = String(CHECK_MAX_NAMES)

/** Every name the fixture publishes, which is exactly `CHECK_MAX_NAMES` of them. */
const ALL_NAMES = [
  AMBER,
  'dusk.eth',
  'flux.eth',
  'helm.eth',
  'nova.eth',
  ORB,
  'quill.eth',
  'raven.eth',
  'vex.eth',
  'zap.eth',
] as const

/** An answer that is current at the frozen clock: read now, good for two minutes. */
function current(results: readonly CheckedName[]): CheckAnswer {
  return { checkedAt: since(0), expiresAt: since(2 * MINUTE), results }
}

/** An answer that had already stopped being a fresh check when it arrived. */
function lapsed(results: readonly CheckedName[]): CheckAnswer {
  return { checkedAt: since(-5 * MINUTE), expiresAt: since(-4 * MINUTE), results }
}

test('no name is a link until a fresh check covers it', async ({ page }) => {
  await openVerified(page, { view: 'all' })

  // The whole rule, stated as a count. A published snapshot on its own earns no
  // outbound link anywhere in the field, whatever any recorded status says.
  await expect(fieldLinks(page)).toHaveCount(0)

  // And the bar draws nothing until there is a selection, so the first screen still
  // opens on the names.
  await expect(checkButton(page)).toHaveCount(0)
})

test('a check that lands links the name out and states when it was read', async ({ page }) => {
  await openVerified(page)

  let asked: readonly string[] = []
  await stubCheck(page, async (route, names) => {
    asked = names
    await fulfilCheck(route, checkDocument(current([{ name: AMBER, status: 'available' }])))
  })

  await tickBox(page, AMBER).check()
  await checkButton(page).click()

  const link = ensLinkFor(page, AMBER)
  await expect(link).toHaveAttribute('href', `https://app.ens.domains/${AMBER}`)
  // Every outbound action says where the authority is, in the link's own accessible name.
  await expect(link).toHaveAccessibleName(/the final authority on whether it can be registered/)

  // The instant is the answer's own, shown beside the fresh status rather than implied
  // by the link being there.
  await expect(rowFor(page, AMBER)).toContainText('Fresh check 12:00:00 UTC')

  // Exactly the ticked name was asked about, and only it was covered.
  expect(asked).toEqual([AMBER])
  await expect(fieldLinks(page)).toHaveCount(1)
  await expect(rowFor(page, ORB).getByRole('link')).toHaveCount(0)
})

test('a fresh status that disagrees with the scan is shown beside it', async ({ page }) => {
  await openVerified(page)

  await stubCheck(page, async (route) => {
    // The fixture's scan recorded `amber.eth` as available. The index now says someone
    // holds it, which is exactly why a fresh check exists.
    await fulfilCheck(
      route,
      checkDocument(
        current([{ name: AMBER, status: 'registered', expiry: '2027-06-01T12:00:00Z' }]),
      ),
    )
  })

  await tickBox(page, AMBER).check()
  await checkButton(page).click()

  // The view heading is the scan's status, so the compact cell does not repeat it.
  // Fresh evidence remains explicit and may contradict that recorded view.
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Available .eth names')
  await expect(rowFor(page, AMBER)).toContainText(/Fresh check 12:00:00 UTC\s*Registered/)
})

test('a check that has lapsed takes the link away and says so', async ({ page }) => {
  await openVerified(page)

  await stubCheck(page, async (route) => {
    await fulfilCheck(route, checkDocument(lapsed([{ name: AMBER, status: 'available' }])))
  })

  await tickBox(page, AMBER).check()
  await checkButton(page).click()

  // The answer is still the newest thing anyone read, so it stays on screen with its
  // instant. What it no longer does is open the link.
  await expect(rowFor(page, AMBER)).toContainText('Fresh check lapsed')
  await expect(rowFor(page, AMBER)).toContainText('Fresh check 11:55:00 UTC')
  await expect(fieldLinks(page)).toHaveCount(0)
})

test('a check in flight is announced and the button stops offering', async ({ page }) => {
  await openVerified(page)

  const gate = hold()
  await stubCheck(page, async (route) => {
    await gate.held
    await fulfilCheck(route, checkDocument(current([{ name: AMBER, status: 'available' }])))
  })

  await tickBox(page, AMBER).check()
  await checkButton(page).click()

  // Observed while the request is outstanding, not raced past it.
  await expect(checkingButton(page)).toBeDisabled()
  await expect(rowFor(page, AMBER)).toContainText('Checking')
  await expect(fieldLinks(page)).toHaveCount(0)

  gate.release()
  await expect(ensLinkFor(page, AMBER)).toBeVisible()
  await expect(checkButton(page)).toBeEnabled()
})

test('a throttled check keeps the selection and adds no status', async ({ page }) => {
  await openVerified(page)

  await stubCheck(page, async (route) => {
    await refuseCheck(route, { status: 429, code: 'client_throttled', retryAfterSeconds: 30 })
  })

  await tickBox(page, AMBER).check()
  await checkButton(page).click()

  await expect(failureBanner(page)).toContainText(
    'You have checked several names in quick succession. Wait a moment and check again.',
  )
  // The promise the page makes, which a visitor cannot verify from here.
  await expect(failureBanner(page)).toContainText(
    'Your selection is unchanged, and no status on this page was replaced by a guess.',
  )
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()

  // And the promise kept: the box is still ticked, the count is unchanged, and no
  // snapshot status was promoted into a fresh one.
  await expect(tickBox(page, AMBER)).toBeChecked()
  await expect(page.getByText(`1 of ${BOUND} names selected`)).toBeVisible()
  await expect(fieldLinks(page)).toHaveCount(0)
  await expect(rowFor(page, AMBER).getByRole('link')).toHaveCount(0)
})

test('an answer covering different names is refused whole', async ({ page }) => {
  await openVerified(page)

  await stubCheck(page, async (route) => {
    // Asked about `amber.eth`, answered about `orb.eth`. Nothing in it is evidence
    // about either name, so neither gets a link.
    await fulfilCheck(route, checkDocument(current([{ name: ORB, status: 'available' }])))
  })

  await tickBox(page, AMBER).check()
  await checkButton(page).click()

  await expect(failureBanner(page)).toContainText(
    'The answer did not match what this site accepts, so it was not used.',
  )
  await expect(fieldLinks(page)).toHaveCount(0)
  await expect(rowFor(page, ORB).getByRole('link')).toHaveCount(0)
})

test('an answer in a newer format offers a reload rather than a retry', async ({ page }) => {
  await openVerified(page)

  await stubCheck(page, async (route) => {
    await fulfilCheck(route, {
      ...(checkDocument(current([{ name: AMBER, status: 'available' }])) as object),
      format_version: CHECK_FORMAT_VERSION + 1,
    })
  })

  await tickBox(page, AMBER).check()
  await checkButton(page).click()

  await expect(failureBanner(page)).toContainText(
    'The answer is in a newer format than this page reads. Reload to pick up the new page.',
  )
  // A retry from this bundle lands on the same refusal, so the button that could not
  // succeed is absent rather than merely unhelpful.
  await expect(page.getByRole('button', { name: 'Reload the page' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
})

test('an unreachable endpoint says no name was verified', async ({ page }) => {
  await openVerified(page)

  await stubCheck(page, async (route) => {
    await route.abort()
  })

  await tickBox(page, AMBER).check()
  await checkButton(page).click()

  await expect(failureBanner(page)).toContainText(
    'The check could not be made. No name was verified.',
  )
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  await expect(fieldLinks(page)).toHaveCount(0)
})

test('nothing from a refusal body reaches the page', async ({ page }) => {
  await openVerified(page)

  await stubCheck(page, async (route) => {
    await refuseCheck(route, { status: 503, code: 'upstream_unavailable', message: POISON })
  })

  await tickBox(page, AMBER).check()
  await checkButton(page).click()

  // The page's own sentence, written in this repository.
  await expect(failureBanner(page)).toContainText(
    'The ENS index did not answer. No name was verified.',
  )

  // And nothing of the endpoint's. The refusal quoted an upstream URL carrying a
  // credential, which is the shape this guarantee exists for.
  const rendered = await page.content()
  expect(rendered).not.toContain(POISON)
  expect(rendered).not.toContain('thegraph')
  expect(rendered).not.toContain('0123456789abcdef')
})

test('a failed check leaves the search text a visitor typed alone', async ({ page }) => {
  await openVerified(page)

  const search = page.getByRole('searchbox', { name: 'Search names' })
  await search.fill('amber')
  await expect(rowFor(page, AMBER)).toBeVisible()

  await stubCheck(page, async (route) => {
    await refuseCheck(route, { status: 504, code: 'check_timed_out' })
  })

  await tickBox(page, AMBER).check()
  await checkButton(page).click()

  await expect(failureBanner(page)).toContainText(
    'The check did not finish in time. No name was verified.',
  )
  // Their work was choosing the names and typing the filter. A failure of ours is not
  // a reason to make them do either again.
  await expect(search).toHaveValue('amber')
  await expect(tickBox(page, AMBER)).toBeChecked()
})

test('the selection is counted against the bound one check covers', async ({ page }) => {
  await openVerified(page, { view: 'all' })

  for (const name of ALL_NAMES) {
    await tickBox(page, name).check()
  }

  // The fixture publishes exactly as many names as one check covers, so this is the
  // bound stated at the moment it is reached.
  await expect(page.getByText(`${BOUND} of ${BOUND} names selected`)).toBeVisible()
})

test('a check can be made and used from the keyboard alone', async ({ page }) => {
  await openVerified(page)

  await stubCheck(page, async (route) => {
    await fulfilCheck(route, checkDocument(current([{ name: AMBER, status: 'available' }])))
  })

  const box = tickBox(page, AMBER)
  await box.press(' ')
  await expect(box).toBeChecked()
  await checkButton(page).press('Enter')

  const link = ensLinkFor(page, AMBER)
  await expect(link).toBeVisible()

  // The link the check just opened is the next thing after the box that opened it, so
  // it is reachable without a mouse and without hunting.
  await box.press('Tab')
  await expect(link).toBeFocused()
})

test('a page with a landed check has no accessibility violations', async ({ page }) => {
  await openVerified(page)

  await stubCheck(page, async (route) => {
    await fulfilCheck(route, checkDocument(current([{ name: AMBER, status: 'available' }])))
  })

  await tickBox(page, AMBER).check()
  await checkButton(page).click()
  await expect(ensLinkFor(page, AMBER)).toBeVisible()

  await expectAccessible(page)
})

test('a page with a failed check has no accessibility violations', async ({ page }) => {
  await openVerified(page)

  await stubCheck(page, async (route) => {
    await refuseCheck(route, { status: 503, code: 'upstream_budget_exhausted' })
  })

  await tickBox(page, AMBER).check()
  await checkButton(page).click()
  await expect(failureBanner(page)).toBeVisible()

  await expectAccessible(page)
})

test('selection and fresh evidence preserve one-column reflow at 320 by 568', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await openVerified(page, { view: 'all' })

  await stubCheck(page, async (route) => {
    await fulfilCheck(route, checkDocument(current([{ name: AMBER, status: 'available' }])))
  })

  await tickBox(page, AMBER).check()
  await checkButton(page).click()
  await expect(ensLinkFor(page, AMBER)).toBeVisible()

  expect(await scrollsSideways(page)).toBe(false)
  const widths = await page.locator('.name-cell').evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect()
      return { left: box.left, right: box.right, viewport: document.documentElement.clientWidth }
    }),
  )
  expect(widths.every(({ left, right, viewport }) => left >= 0 && right <= viewport + 0.5)).toBe(
    true,
  )
})
