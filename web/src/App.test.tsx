import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { App } from './App'
import type { AppConfig } from './config/env'
import type { SnapshotDocument } from './snapshot/types'
import type { SnapshotDeps } from './state/useSnapshot'
import { buildLatestDocument, buildSnapshotDocument, SCANNED_AT } from './test/factory'

/**
 * What the page puts first.
 *
 * A visitor arrives with one question - which names are open - so these tests pin
 * the two decisions that answer it, both of which are easy to undo by accident while
 * moving anything else around: a link with no view parameter lands on Available, and
 * the names are rendered before the long-form provenance rather than after it.
 *
 * Order here is document order, which is what a screen reader, a keyboard, and a
 * reader with no CSS all follow. Whether three rows also *fit* on a 1440x900 screen
 * is a geometry question that only a real browser can answer, so the Playwright
 * suite owns that half.
 */

/** No API is configured, so the page reads the fixture the deps supply. */
const CONFIG: AppConfig = { apiBaseUrl: null, fixtureId: 'preview' }

/**
 * Three available names and two that are not, so the default view has rows to show
 * and there is something for it to leave out. The source lists are sized to match the
 * label lengths, which is what lets attribution be proven rather than guessed.
 */
const DOCUMENT = buildSnapshotDocument({
  results: [
    { name: 'aaa.eth', status: 'available' },
    { name: 'bbb.eth', status: 'available' },
    { name: 'ccc.eth', status: 'available' },
    { name: 'dddd.eth', status: 'registered', expiry: new Date('2027-01-01T00:00:00Z') },
    {
      name: 'eeee.eth',
      status: 'premium',
      expiry: new Date('2025-11-01T00:00:00Z'),
      graceEnds: new Date('2026-01-30T00:00:00Z'),
      premiumEnds: new Date('2026-03-20T00:00:00Z'),
    },
  ],
  sources: [
    { id: 'four-letters', path: 'data/words/4-letters.txt', cadence: 'three-hourly', names: 2 },
    { id: 'three-letters', path: 'data/words/3-letters.txt', cadence: 'daily', names: 3 },
  ],
})

const DEPS: SnapshotDeps = {
  loadFixture: () => Promise.resolve({ snapshot: DOCUMENT, latest: buildLatestDocument(DOCUMENT) }),
  storage: null,
}

/**
 * An hour after the scan, so the snapshot is inside its schedule and no staleness
 * alert fires. The committed fixtures are permanently stale against a real clock,
 * and the simulated clock is the supported way to say which instant is meant.
 */
const NOW = new Date(SCANNED_AT.getTime() + 60 * 60 * 1000)

async function mount(search = `?now=${NOW.toISOString().slice(0, 19)}Z`): Promise<void> {
  window.history.replaceState(null, '', `/${search}`)
  render(<App config={CONFIG} deps={DEPS} />)
  // The fixture load is asynchronous, so nothing below is true until it settles.
  await screen.findByRole('table')
}

/** True when `later` comes after `earlier` in document order. */
function follows(earlier: Element, later: Element): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

function resultsRegion(): HTMLElement {
  return screen.getByRole('region', { name: 'Available .eth names' })
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('App default view', () => {
  it('lands on Available when the link names no view', async () => {
    await mount()

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Available .eth names')
    expect(screen.getByRole('link', { name: /^Available/ })).toHaveAttribute('aria-current', 'page')

    // Only the available names, and all of them.
    const names = screen.getAllByRole('rowheader').map((cell) => cell.textContent)
    expect(names).toHaveLength(3)
    for (const name of names) {
      expect(name).toMatch(/^(aaa|bbb|ccc)\.eth/)
    }
  })

  it('leaves the default view out of the link, so the shared link is the short one', async () => {
    await mount()
    const params = new URLSearchParams(window.location.search)
    expect(params.get('view')).toBeNull()
    expect(params.get('now')).toBe(`${NOW.toISOString().slice(0, 19)}Z`)
  })

  it('says so, and still lands on Available, when the link names a view that is gone', async () => {
    // The clock is named too, so the only alert on the page is the one under test.
    await mount(`?view=nope&now=${NOW.toISOString().slice(0, 19)}Z`)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Available .eth names')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The link asked for an unknown view, so Available .eth names is shown instead.',
    )
    // The link is rewritten to one that round-trips, and the explanation survives
    // that rewrite - the whole point of it is that the address bar no longer says
    // what was dropped.
    expect(new URLSearchParams(window.location.search).get('view')).toBeNull()
  })

  it('drops the explanation once the visitor changes something', async () => {
    const user = userEvent.setup()
    await mount(`?view=nope&now=${NOW.toISOString().slice(0, 19)}Z`)

    await user.type(screen.getByLabelText('Search names'), 'a')

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('App list filter that cannot be honoured', () => {
  /**
   * The same five names, but the source lists no longer state a label length, so
   * `deriveAttribution` cannot prove which list each name came from and refuses.
   * `filterResults` then admits every row for a `?list=` link, which is the case the
   * advisory exists for.
   */
  const UNATTRIBUTABLE: SnapshotDocument = {
    ...DOCUMENT,
    metadata: {
      ...DOCUMENT.metadata,
      sources: [{ id: 'wordlist', path: 'data/words/wordlist.txt', cadence: 'daily', names: 5 }],
    },
  }

  async function mountUnattributable(search: string): Promise<void> {
    window.history.replaceState(null, '', `/${search}`)
    render(
      <App
        config={CONFIG}
        deps={{
          loadFixture: () =>
            Promise.resolve({
              snapshot: UNATTRIBUTABLE,
              latest: buildLatestDocument(UNATTRIBUTABLE),
            }),
          storage: null,
        }}
      />,
    )
    await screen.findByRole('table')
  }

  it('says the list filter was not applied, rather than showing every name as if it had', async () => {
    await mountUnattributable(`?view=all&list=four-letters&now=${NOW.toISOString().slice(0, 19)}Z`)

    const notice = screen.getByRole('alert')
    expect(notice).toHaveTextContent('This link asks for the list four-letters')
    expect(notice).toHaveTextContent('every name is shown rather than that list alone')
    expect(
      within(notice).getByRole('link', { name: 'Show every list instead' }),
    ).toBeInTheDocument()

    // And the rows really are the whole snapshot, which is what makes the advisory
    // necessary rather than merely tidy.
    expect(screen.getAllByRole('rowheader')).toHaveLength(5)
  })

  it('raises nothing when no list was asked for', async () => {
    await mountUnattributable(`?view=all&now=${NOW.toISOString().slice(0, 19)}Z`)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('App order', () => {
  it('renders the names before any of the long-form detail', async () => {
    await mount()

    const results = resultsRegion()
    const firstRow = within(results).getAllByRole('rowheader')[0]
    expect(firstRow).toBeDefined()

    // The heading and the trust line are the only things above the list, and the
    // trust line is there because a reader must not be able to miss it.
    const title = screen.getByRole('heading', { level: 1 })
    expect(follows(title, results)).toBe(true)

    // Everything a reader may want to check is below the names, not above them.
    for (const detail of [
      'Scan details, source lists, and method',
      'Scanned at',
      'Expected cadence',
      'Source lists',
      'What this scan found',
      'What each status means',
      'What each view holds',
    ]) {
      expect(follows(results, screen.getByText(detail))).toBe(true)
    }
  })

  it('keeps the detail out of the way until it is asked for', async () => {
    const user = userEvent.setup()
    await mount()

    const summary = screen.getByText('Scan details, source lists, and method')
    expect(screen.getByRole('heading', { name: 'What each status means' })).not.toBeVisible()

    await user.click(summary)

    expect(screen.getByRole('heading', { name: 'What each status means' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Scan' })).toBeVisible()
  })

  it('starts the tab order with a link straight to the names', async () => {
    const user = userEvent.setup()
    await mount()

    await user.tab()
    const skip = screen.getByRole('link', { name: 'Skip to the names' })
    expect(skip).toHaveFocus()
    expect(skip).toHaveAttribute('href', '#results')
    expect(resultsRegion()).toHaveAttribute('id', 'results')
  })
})

describe('App trust', () => {
  it('states the scan time and that nothing is a live check, above the list', async () => {
    await mount()

    const results = resultsRegion()
    const trust = screen.getByText(/Recorded statuses, not a live check/)
    expect(follows(trust, results)).toBe(true)
    // The exact instant, unrounded and in UTC, on the same line: two people
    // comparing notes have to be able to tell whether it is the same scan.
    expect(trust.closest('p')).toHaveTextContent('2026-03-01 12:00:00 UTC')
  })

  it('announces a simulated clock rather than quietly using it', async () => {
    await mount()

    const notice = screen.getByRole('region', { name: 'Showing a simulated time' })
    expect(notice).toHaveTextContent('Simulated time.')
    expect(within(notice).getByRole('link', { name: 'Use the real time instead' })).toHaveAttribute(
      'href',
      './',
    )
  })
})
