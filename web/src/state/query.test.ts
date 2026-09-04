import { describe, expect, it } from 'vitest'
import {
  CLEAR_FILTERS,
  DEFAULT_QUERY,
  isFiltered,
  isInvertedRange,
  parseQuery,
  serializeQuery,
  updateQuery,
} from './query'

/**
 * The URL is the state, so the property that matters is the round trip: a link
 * parses to a state, that state serializes back to the same link, and parsing the
 * result again changes nothing. Everything else here is a case where a link cannot
 * be honoured as written, which must be reported rather than silently reinterpreted.
 */

/** Parse, serialize, and parse again. A canonical link survives both passes. */
function roundTrip(search: string): string {
  const once = serializeQuery(parseQuery(search).state)
  expect(serializeQuery(parseQuery(once).state)).toBe(once)
  return once
}

describe('query round trips', () => {
  it('reproduces a link that names every control', () => {
    const search = '?view=grace&q=zap&status=grace-period&min=3&max=5&list=four&dir=desc&page=4'
    expect(roundTrip(search)).toBe(search)
  })

  it('leaves out everything at its default, so one state is one link', () => {
    expect(serializeQuery(DEFAULT_QUERY)).toBe('')
    expect(roundTrip('?view=available&sort=name&dir=asc&page=1')).toBe('')
  })

  it('writes the statuses in the published order, not the order they were clicked', () => {
    // In `all`, because the default view admits one status and a single-status
    // selection there covers the whole view, which canonicalizes to no selection.
    expect(roundTrip('?view=all&status=available,premium')).toBe(
      '?view=all&status=premium%2Cavailable',
    )
  })

  it('keeps a sort only when it is not the view default', () => {
    // premium sorts by premium-end on arrival, so naming that sort adds nothing.
    expect(roundTrip('?view=premium&sort=premium-end')).toBe('?view=premium')
    expect(roundTrip('?view=premium&sort=name')).toBe('?view=premium&sort=name')
  })

  it('round trips a length range whose bounds cross, so neither bound is lost', () => {
    expect(roundTrip('?min=9&max=3')).toBe('?min=9&max=3')
  })

  it('drops a parameter it does not know rather than carrying it along', () => {
    expect(roundTrip('?q=zap&colour=red')).toBe('?q=zap')
  })

  it('writes the simulated clock to the second, matching the snapshot timestamps', () => {
    expect(roundTrip('?now=2026-03-01T12:00:00.500Z')).toBe('?now=2026-03-01T12%3A00%3A00Z')
  })
})

describe('query parsing of links that cannot be honoured', () => {
  it('falls back to the default view and says so when the view is unknown', () => {
    const { state, warnings } = parseQuery('?view=nope')
    expect(state.view).toBe('available')
    expect(warnings).toEqual([expect.stringContaining('unknown view')])
  })

  it('drops a status the named view does not show', () => {
    const { state, warnings } = parseQuery('?view=premium&status=available')
    expect(state.statuses).toEqual([])
    expect(warnings).toEqual([expect.stringContaining('does not show')])
  })

  it('treats a selection of every status in the view as no selection', () => {
    const { state, warnings } = parseQuery('?view=grace&status=grace-period,grace-ending-soon')
    expect(state.statuses).toEqual([])
    expect(warnings).toEqual([])
  })

  it('keeps an inverted length range and reports it by its numbers', () => {
    const { state, warnings } = parseQuery('?min=9&max=3')
    // Kept, not repaired: the filter skips a range in this state, and a visitor who
    // set one bound must not have to find it again because they typed the other.
    expect(state.length).toEqual({ min: 9, max: 3 })
    expect(isInvertedRange(state.length)).toBe(true)
    expect(warnings).toEqual(['Length range not applied: shortest 9 is above longest 3.'])
  })

  it('reports nothing about a range that reads the right way round', () => {
    const { state, warnings } = parseQuery('?min=3&max=9')
    expect(isInvertedRange(state.length)).toBe(false)
    expect(warnings).toEqual([])
  })

  it('treats a single bound as usable, whichever end it is', () => {
    expect(isInvertedRange(parseQuery('?min=9').state.length)).toBe(false)
    expect(isInvertedRange(parseQuery('?max=3').state.length)).toBe(false)
  })

  it.each([
    ['?min=0', 'shortest length'],
    ['?max=999', 'longest length'],
    ['?min=-3', 'shortest length'],
    ['?min=3.5', 'shortest length'],
  ])('refuses a length bound that names no label: %s', (search, what) => {
    const { state, warnings } = parseQuery(search)
    expect(state.length).toEqual({ min: null, max: null })
    expect(warnings).toEqual([expect.stringContaining(what)])
  })

  it.each(['?page=0', '?page=-2', '?page=two', '?page=1.5'])(
    'falls back to page one and says so: %s',
    (search) => {
      const { state, warnings } = parseQuery(search)
      expect(state.page).toBe(1)
      expect(warnings).toEqual([expect.stringContaining('page number')])
    },
  )

  it('reports an unreadable simulated time rather than rendering against the real clock silently', () => {
    const { state, warnings } = parseQuery('?now=yesterday')
    expect(state.now).toBeNull()
    expect(warnings).toEqual([expect.stringContaining('simulated time')])
  })

  it('normalizes the search the way a label is normalized', () => {
    expect(parseQuery('?q=%20ZAP.eth%20').state.search).toBe('zap')
  })

  it('caps the search, so a hostile link cannot set the page a long task', () => {
    const long = 'a'.repeat(500)
    expect(parseQuery(`?q=${long}`).state.search).toHaveLength(128)
  })
})

describe('isFiltered', () => {
  it('is false for a view on its own, and for the sort, page, and clock', () => {
    expect(isFiltered(DEFAULT_QUERY)).toBe(false)
    expect(
      isFiltered(parseQuery('?view=premium&dir=desc&page=7&now=2026-03-01T00:00:00Z').state),
    ).toBe(false)
  })

  it.each(['?q=zap', '?view=grace&status=grace-period', '?min=4', '?max=4', '?list=four'])(
    'is true for anything hiding rows the view would show: %s',
    (search) => {
      expect(isFiltered(parseQuery(search).state)).toBe(true)
    },
  )

  it('is false again after the change the reset link applies', () => {
    const state = parseQuery(
      '?view=grace&q=zap&status=grace-period&min=3&max=5&list=four&page=4',
    ).state
    const cleared = updateQuery(state, CLEAR_FILTERS)
    expect(isFiltered(cleared)).toBe(false)
    // Clearing the filters is not leaving the view.
    expect(cleared.view).toBe('grace')
    expect(serializeQuery(cleared)).toBe('?view=grace')
  })
})

describe('updateQuery', () => {
  it('returns to page one when the visible rows change', () => {
    const onPageNine = updateQuery(DEFAULT_QUERY, { page: 9 })
    expect(updateQuery(onPageNine, { search: 'zap' }).page).toBe(1)
  })

  it('keeps the page when only the page or the clock changes', () => {
    expect(updateQuery(DEFAULT_QUERY, { page: 9 }).page).toBe(9)
    const onPageNine = updateQuery(DEFAULT_QUERY, { page: 9 })
    expect(updateQuery(onPageNine, { now: new Date('2026-03-01T00:00:00Z') }).page).toBe(9)
  })

  it('moves a defaulted sort to the new view default, and keeps a chosen one', () => {
    expect(updateQuery(DEFAULT_QUERY, { view: 'premium' }).sort).toBe('premium-end')
    const chosen = updateQuery(DEFAULT_QUERY, { sort: 'expiry' })
    expect(updateQuery(chosen, { view: 'premium' }).sort).toBe('expiry')
  })

  it('drops a status selection made in the view being left', () => {
    const inGrace = updateQuery(DEFAULT_QUERY, { view: 'grace', statuses: ['grace-period'] })
    expect(updateQuery(inGrace, { view: 'premium' }).statuses).toEqual([])
  })
})
