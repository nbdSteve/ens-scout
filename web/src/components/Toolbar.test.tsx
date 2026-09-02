import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { deriveAttribution, type Attribution } from '../snapshot/attribution'
import { applyQuery, countByStatus } from '../state/filter'
import { parseQuery, serializeQuery } from '../state/query'
import { useUrlState } from '../state/useUrlState'
import { buildSnapshot } from '../test/factory'
import type { Snapshot } from '../snapshot/types'
import { Toolbar } from './Toolbar'

/**
 * The toolbar is tested through the address bar, because that is where its state
 * actually lives. Asserting on `window.location.search` after an interaction checks
 * the thing a visitor would copy out and send to someone else, and it holds the round
 * trip honest: the link a control writes must parse back to the state that wrote it.
 *
 * Every mount names `view=all`. The default view is `available`, which admits one
 * status, and a view with one status is the wrong place to test a status filter or a
 * count that has to change - the whole point of `all` is that every status is in it.
 */

/**
 * Wires the real URL state to the real toolbar. Anything faked between them would
 * test a copy of the state rather than the link.
 *
 * The match count is rendered here rather than in the toolbar, because that is where
 * `App` renders it: beside the page heading, above the list. It is included because
 * it is the evidence that a control did something - a link that parses is not proof
 * that fewer rows survive it.
 */
function Harness({
  snapshot,
  attribution,
}: {
  snapshot: Snapshot
  attribution?: Attribution
}): ReactNode {
  const { query, setQuery, hrefFor } = useUrlState()
  const resolved = attribution ?? deriveAttribution(snapshot.metadata.sources, snapshot.results)
  const context = { sourceIdByName: resolved.available ? resolved.sourceIdByName : null }
  const page = applyQuery(snapshot.results, query, context)
  return (
    <>
      <p role="status">
        {page.total} {page.total === 1 ? 'name matches' : 'names match'}
      </p>
      <Toolbar
        attribution={resolved}
        query={query}
        resetHref={hrefFor({
          search: '',
          statuses: [],
          length: { min: null, max: null },
          list: null,
        })}
        setQuery={setQuery}
        sources={snapshot.metadata.sources}
        statusCounts={countByStatus(snapshot.results, query, context)}
      />
    </>
  )
}

function mount(search = '?view=all', attribution?: Attribution): void {
  window.history.replaceState(null, '', `/${search}`)
  const snapshot = buildSnapshot()
  render(
    attribution === undefined ? (
      <Harness snapshot={snapshot} />
    ) : (
      <Harness attribution={attribution} snapshot={snapshot} />
    ),
  )
}

/** Opens the disclosure the way a visitor does, so what it holds becomes usable. */
async function openMore(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByText('More filters'))
}

/** The link is canonical when parsing and re-serializing it changes nothing. */
function expectCanonicalLink(expected: string): void {
  expect(window.location.search).toBe(expected)
  expect(serializeQuery(parseQuery(window.location.search).state)).toBe(expected)
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('Toolbar disclosure', () => {
  it('shows search and length at once, and keeps the rest one control away', async () => {
    const user = userEvent.setup()
    mount()

    // The two a visitor reaches for on arrival are on screen without asking.
    expect(screen.getByLabelText('Search names')).toBeVisible()
    expect(screen.getByLabelText('Shortest label length')).toBeVisible()
    expect(screen.getByLabelText('Longest label length')).toBeVisible()

    // The rest is in the DOM, so find-in-page and the tests reach it, but it is
    // not taking up the screen until it is asked for.
    expect(screen.getByLabelText('Sort by')).not.toBeVisible()
    expect(screen.getByRole('checkbox', { name: 'Available (1)' })).not.toBeVisible()

    await openMore(user)

    expect(screen.getByLabelText('Sort by')).toBeVisible()
    expect(screen.getByLabelText('Source list')).toBeVisible()
    expect(screen.getByRole('checkbox', { name: 'Available (1)' })).toBeVisible()
  })
})

describe('Toolbar search', () => {
  it('writes the normalized search to the link and keeps what was typed on screen', async () => {
    const user = userEvent.setup()
    mount()

    await user.type(screen.getByLabelText('Search names'), 'BBBB.eth')

    // The link carries the normalized label; the box still shows the keystrokes.
    expectCanonicalLink('?view=all&q=bbbb')
    expect(screen.getByLabelText('Search names')).toHaveValue('BBBB.eth')
  })

  it('applies a search that arrived in the link', () => {
    mount('?view=all&q=bbbb')
    expect(screen.getByLabelText('Search names')).toHaveValue('bbbb')
    expect(screen.getByRole('status')).toHaveTextContent('1 name matches')
  })
})

describe('Toolbar length range', () => {
  it('writes both bounds to the link', async () => {
    const user = userEvent.setup()
    mount()

    await user.type(screen.getByLabelText('Shortest label length'), '4')
    await user.type(screen.getByLabelText('Longest label length'), '4')

    expectCanonicalLink('?view=all&min=4&max=4')
    expect(screen.getByRole('status')).toHaveTextContent('3 names match')
  })

  it('clears a bound the snapshot cannot use, without discarding the keystroke', async () => {
    const user = userEvent.setup()
    mount('?view=all&min=4')

    await user.clear(screen.getByLabelText('Shortest label length'))

    expectCanonicalLink('?view=all')
    expect(screen.getByLabelText('Shortest label length')).toHaveValue(null)
  })

  it('drops an inverted range from the link and says so', () => {
    mount('?view=all&min=9&max=4')
    expect(window.location.search).toBe('?view=all')
  })
})

describe('Toolbar status filter', () => {
  it('writes ticked statuses in the published order, whatever order they were ticked', async () => {
    const user = userEvent.setup()
    mount()
    await openMore(user)

    await user.click(screen.getByRole('checkbox', { name: /^Available/ }))
    await user.click(screen.getByRole('checkbox', { name: /^Expiring soon/ }))

    expectCanonicalLink('?view=all&status=expiring-soon%2Cavailable')
  })

  it('shows the count for each status, before its own filter is applied', async () => {
    const user = userEvent.setup()
    mount()
    await openMore(user)

    expect(screen.getByRole('checkbox', { name: 'Available (1)' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Registered (0)' })).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: 'Available (1)' }))
    // Ticking one status must not zero the others, or the list of counts would
    // collapse to the one already chosen.
    expect(screen.getByRole('checkbox', { name: 'Premium (1)' })).toBeInTheDocument()
  })

  it('ticks the boxes named by an incoming link', () => {
    mount('?view=all&status=premium')
    expect(screen.getByRole('checkbox', { name: 'Premium (1)' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Available (1)' })).not.toBeChecked()
  })

  it('unticks a status back out of the link', async () => {
    const user = userEvent.setup()
    mount('?view=all&status=premium')
    await openMore(user)

    await user.click(screen.getByRole('checkbox', { name: 'Premium (1)' }))

    expectCanonicalLink('?view=all')
  })
})

describe('Toolbar sort', () => {
  it('writes a chosen sort and names both of its directions in words', async () => {
    const user = userEvent.setup()
    mount()
    await openMore(user)

    // The direction is never called "ascending": each sort names its own two ends.
    const toggle = screen.getByRole('button', { name: /Press to sort/ })
    expect(toggle).toHaveAccessibleName(/^A to Z/)

    await user.selectOptions(screen.getByLabelText('Sort by'), 'expiry')
    expectCanonicalLink('?view=all&sort=expiry')
    expect(toggle).toHaveAccessibleName(/^Soonest first/)

    await user.click(toggle)
    expectCanonicalLink('?view=all&sort=expiry&dir=desc')
    expect(toggle).toHaveAccessibleName(/^Latest first/)
  })

  it('leaves the default sort out of the link', async () => {
    const user = userEvent.setup()
    mount('?view=all&sort=expiry')
    await openMore(user)

    await user.selectOptions(screen.getByLabelText('Sort by'), 'name')

    expectCanonicalLink('?view=all')
  })
})

describe('Toolbar source list', () => {
  it('offers each list with its own name count and writes the choice to the link', async () => {
    const user = userEvent.setup()
    mount()
    await openMore(user)

    await user.selectOptions(
      screen.getByLabelText('Source list'),
      screen.getByRole('option', { name: 'data/words/4-letters.txt (3)' }),
    )

    expectCanonicalLink('?view=all&list=four-letters')
    expect(screen.getByRole('status')).toHaveTextContent('3 names match')
  })

  it('hides the control and states why when names cannot be attributed', () => {
    mount('?view=all', {
      available: false,
      reason: 'source list five-letters does not state a label length',
      sourceIdByName: new Map(),
      lengthBySourceId: new Map(),
    })

    expect(screen.queryByRole('combobox', { name: 'Source list' })).not.toBeInTheDocument()
    expect(
      screen.getByText(/source list five-letters does not state a label length/),
    ).toBeInTheDocument()
  })
})

describe('Toolbar reset', () => {
  it('offers a link back to the unfiltered view only while something is filtered', async () => {
    const user = userEvent.setup()
    mount()
    await openMore(user)

    expect(screen.queryByRole('link', { name: 'Clear filters' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: 'Available (1)' }))

    // Visible without opening the disclosure again: the way out of a filter must
    // not be behind the control that set it.
    const reset = screen.getByRole('link', { name: 'Clear filters' })
    expect(reset).toBeVisible()
    expect(reset).toHaveAttribute('href', '?view=all')
  })

  it('keeps the sort when clearing the filters, because sorting hides nothing', async () => {
    const user = userEvent.setup()
    mount('?view=all&sort=expiry&dir=desc&status=premium')
    await openMore(user)

    await user.click(screen.getByRole('checkbox', { name: 'Premium (1)' }))

    expectCanonicalLink('?view=all&sort=expiry&dir=desc')
  })
})
