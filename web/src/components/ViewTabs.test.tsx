import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { filterResults } from '../state/filter'
import { parseQuery } from '../state/query'
import { useUrlState } from '../state/useUrlState'
import { VIEWS } from '../state/views'
import { buildSnapshot } from '../test/factory'
import { ViewTabs } from './ViewTabs'

/**
 * The views are links, so they are tested as links: what each one's `href` says,
 * and what that link parses back to. The counts are computed the way the page
 * computes them, through `filterResults`, so a test cannot pass with a count the
 * visitor would not land on.
 */

const snapshot = buildSnapshot()

function Harness(): ReactNode {
  const { query, hrefFor } = useUrlState()
  const context = { sourceIdByName: null }
  const counts = new Map<string, number>(
    VIEWS.map((view) => [
      view.id,
      filterResults(snapshot.results, { ...query, view: view.id, statuses: [] }, context).length,
    ]),
  )
  return (
    <ViewTabs counts={counts} current={query.view} hrefForView={(id) => hrefFor({ view: id })} />
  )
}

function mount(search = ''): void {
  window.history.replaceState(null, '', `/${search}`)
  render(<Harness />)
}

function tab(name: string): HTMLElement {
  return screen.getByRole('link', { name: new RegExp(`^${name} `) })
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('ViewTabs', () => {
  it('offers every view as a link inside a named navigation', () => {
    mount()

    const nav = screen.getByRole('navigation', { name: 'Views' })
    expect(nav).toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(VIEWS.length)
  })

  it('marks the view being shown, and only that one', () => {
    mount('?view=premium')

    expect(tab('Premium')).toHaveAttribute('aria-current', 'page')
    expect(tab('All names')).not.toHaveAttribute('aria-current')
  })

  it('leaves the default view out of the link', () => {
    mount('?view=premium')

    expect(tab('Available')).toHaveAttribute('href', './')
    expect(tab('All names')).toHaveAttribute('href', '?view=all')
    expect(tab('Expiring')).toHaveAttribute('href', '?view=expiring')
  })

  it('moves a defaulted sort to the new view, so the first screen is already useful', () => {
    mount()

    const href = tab('Premium').getAttribute('href') ?? ''
    // The link itself carries no sort, because premium-end is that view's default.
    expect(href).toBe('?view=premium')
    expect(parseQuery(new URL(href, 'https://example.test/').search).state.sort).toBe('premium-end')
  })

  it('keeps a sort the visitor chose', () => {
    mount('?sort=expiry')

    const href = tab('Premium').getAttribute('href') ?? ''
    expect(parseQuery(new URL(href, 'https://example.test/').search).state.sort).toBe('expiry')
  })

  it('states how many names each view would show under the filters in force', () => {
    mount()

    expect(tab('All names')).toHaveAccessibleName(/^All names 4 names match/)
    expect(tab('Available')).toHaveAccessibleName(/^Available 1 name matches/)
    expect(tab('Grace period')).toHaveAccessibleName(/^Grace period 1 name matches/)
  })

  it('narrows the counts when a search is in force, so none of them overpromises', () => {
    mount('?q=bbbb')

    expect(tab('All names')).toHaveAccessibleName(/^All names 1 name matches/)
    expect(tab('Available')).toHaveAccessibleName(/^Available 0 names match/)
    expect(tab('Premium')).toHaveAccessibleName(/^Premium 1 name matches/)
  })

  it('describes what each view is, for anyone who cannot infer it from the label', () => {
    mount()

    expect(tab('Premium')).toHaveAccessibleName(/temporary premium still on the price/)
    expect(tab('Premium')).toHaveAttribute('title', expect.stringContaining('temporary premium'))
  })
})
