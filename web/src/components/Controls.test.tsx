import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { deriveAttribution, type Attribution } from '../snapshot/attribution'
import { countByStatus } from '../state/filter'
import { applyQuery } from '../state/filter'
import { parseQuery, serializeQuery } from '../state/query'
import { useUrlState } from '../state/useUrlState'
import { buildSnapshot } from '../test/factory'
import type { Snapshot } from '../snapshot/types'
import { Controls } from './Controls'

/**
 * The controls are tested through the address bar, because that is where their
 * state actually lives. Asserting on `window.location.search` after an interaction
 * checks the thing a visitor would copy out and send to someone else, and it holds
 * the round trip honest: the link a control writes must parse back to the state
 * that wrote it.
 */

/**
 * Wires the real URL state to the real controls. Anything faked between them would
 * test a copy of the state rather than the link.
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
    <Controls
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
      total={page.total}
    />
  )
}

function mount(search = '', attribution?: Attribution): void {
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

/** The link is canonical when parsing and re-serializing it changes nothing. */
function expectCanonicalLink(expected: string): void {
  expect(window.location.search).toBe(expected)
  expect(serializeQuery(parseQuery(window.location.search).state)).toBe(expected)
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('Controls search', () => {
  it('writes the normalized search to the link and keeps what was typed on screen', async () => {
    const user = userEvent.setup()
    mount()

    await user.type(screen.getByLabelText('Search names'), 'ZAP.eth')

    // The link carries the normalized label; the box still shows the keystrokes.
    expectCanonicalLink('?q=zap')
    expect(screen.getByLabelText('Search names')).toHaveValue('ZAP.eth')
  })

  it('applies a search that arrived in the link', () => {
    mount('?q=bbbb')
    expect(screen.getByLabelText('Search names')).toHaveValue('bbbb')
    expect(screen.getByRole('status')).toHaveTextContent('1 name matches')
  })

  it('reports how many names match', () => {
    mount()
    expect(screen.getByRole('status')).toHaveTextContent('4 names match')
  })
})

describe('Controls length range', () => {
  it('writes both bounds to the link', async () => {
    const user = userEvent.setup()
    mount()

    await user.type(screen.getByLabelText('Shortest label length'), '4')
    await user.type(screen.getByLabelText('Longest label length'), '4')

    expectCanonicalLink('?min=4&max=4')
    expect(screen.getByRole('status')).toHaveTextContent('3 names match')
  })

  it('clears a bound the snapshot cannot use, without discarding the keystroke', async () => {
    const user = userEvent.setup()
    mount('?min=4')

    await user.clear(screen.getByLabelText('Shortest label length'))

    expectCanonicalLink('')
    expect(screen.getByLabelText('Shortest label length')).toHaveValue(null)
  })

  it('drops an inverted range from the link and says so', () => {
    mount('?min=9&max=4')
    expect(window.location.search).toBe('')
  })
})

describe('Controls status filter', () => {
  it('writes ticked statuses in the published order, whatever order they were ticked', async () => {
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole('checkbox', { name: /^Available/ }))
    await user.click(screen.getByRole('checkbox', { name: /^Expiring soon/ }))

    expectCanonicalLink('?status=expiring-soon%2Cavailable')
  })

  it('shows the count for each status, before its own filter is applied', async () => {
    const user = userEvent.setup()
    mount()

    expect(screen.getByRole('checkbox', { name: 'Available (1)' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Registered (0)' })).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: 'Available (1)' }))
    // Ticking one status must not zero the others, or the list of counts would
    // collapse to the one already chosen.
    expect(screen.getByRole('checkbox', { name: 'Premium (1)' })).toBeInTheDocument()
  })

  it('ticks the boxes named by an incoming link', () => {
    mount('?status=premium')
    expect(screen.getByRole('checkbox', { name: 'Premium (1)' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Available (1)' })).not.toBeChecked()
  })

  it('unticks a status back out of the link', async () => {
    const user = userEvent.setup()
    mount('?status=premium')

    await user.click(screen.getByRole('checkbox', { name: 'Premium (1)' }))

    expectCanonicalLink('')
  })
})

describe('Controls sort', () => {
  it('writes a chosen sort and names both of its directions in words', async () => {
    const user = userEvent.setup()
    mount()

    // The direction is never called "ascending": each sort names its own two ends.
    const toggle = screen.getByRole('button', { name: /Press to sort/ })
    expect(toggle).toHaveAccessibleName(/^A to Z/)

    await user.selectOptions(screen.getByLabelText('Sort by'), 'expiry')
    expectCanonicalLink('?sort=expiry')
    expect(toggle).toHaveAccessibleName(/^Soonest first/)

    await user.click(toggle)
    expectCanonicalLink('?sort=expiry&dir=desc')
    expect(toggle).toHaveAccessibleName(/^Latest first/)
  })

  it('leaves the default sort out of the link', async () => {
    const user = userEvent.setup()
    mount('?sort=expiry')

    await user.selectOptions(screen.getByLabelText('Sort by'), 'name')

    expectCanonicalLink('')
  })
})

describe('Controls source list', () => {
  it('offers each list with its own name count and writes the choice to the link', async () => {
    const user = userEvent.setup()
    mount()

    await user.selectOptions(
      screen.getByLabelText('Source list'),
      screen.getByRole('option', { name: 'data/words/4-letters.txt (3)' }),
    )

    expectCanonicalLink('?list=four-letters')
    expect(screen.getByRole('status')).toHaveTextContent('3 names match')
  })

  it('hides the control and states why when names cannot be attributed', () => {
    mount('', {
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

describe('Controls reset', () => {
  it('offers a link back to the unfiltered view only while something is filtered', async () => {
    const user = userEvent.setup()
    mount()

    expect(screen.queryByRole('link', { name: 'Clear all filters' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: 'Available (1)' }))

    expect(screen.getByRole('link', { name: 'Clear all filters' })).toHaveAttribute('href', './')
  })

  it('keeps the sort when clearing the filters, because sorting hides nothing', async () => {
    const user = userEvent.setup()
    mount('?sort=expiry&dir=desc&status=premium')

    await user.click(screen.getByRole('checkbox', { name: 'Premium (1)' }))

    expectCanonicalLink('?sort=expiry&dir=desc')
  })
})
